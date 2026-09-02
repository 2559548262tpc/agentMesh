import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aggregateFindingsPrecision,
  appendFindings,
  buildFindingId,
  classifyFindingKind,
  collectReworkClosureFindings,
  confirmFindings,
  deriveFindingCategory,
  enrichReviewFinding,
  parseReworkFindingsFromPrompt,
  proposeGraduations,
  readFindings,
  resolveFindingsFilePath,
} from "../../src/core/findings.js";
import type { FindingRecord } from "../../src/core/findings.js";
import { buildReworkFixPrompt } from "../../src/core/prompts.js";
import type { ReviewFinding } from "../../src/agents/types.js";
import type { SessionHistoryEntry } from "../../src/core/types.js";

describe("core/findings store", () => {
  const createdDirectories: string[] = [];

  function createTempHome(): string {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-findings-")));
    createdDirectories.push(home);
    return home;
  }

  afterEach(() => {
    for (const directory of createdDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  const baseRecord: FindingRecord = {
    findingId: "fnd_abc123",
    sessionId: "bridge-sess_rev1",
    reviewerAgent: "opencode",
    category: "security",
    kind: "security",
    severity: "high",
    file: "src/auth.ts",
    line: "42",
    reviewedAt: "2026-09-01T10:00:00.000Z",
  };

  it("resolves the findings file inside the given home directory", () => {
    expect(resolveFindingsFilePath("/tmp/agentmesh-home")).toBe(
      path.join("/tmp/agentmesh-home", "findings.jsonl"),
    );
  });

  it("round-trips appended records through the JSONL store in order", () => {
    const home = createTempHome();
    expect(appendFindings([baseRecord], { homeDir: home })).toBe(true);
    expect(
      appendFindings([{ ...baseRecord, findingId: "fnd_def456", kind: "style" }], {
        homeDir: home,
      }),
    ).toBe(true);

    const raw = fs.readFileSync(resolveFindingsFilePath(home), "utf-8");
    expect(raw.split("\n")).toHaveLength(3); // two records + trailing newline

    const records = readFindings({ homeDir: home });
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(baseRecord);
    expect(records[1]).toMatchObject({ findingId: "fnd_def456", kind: "style" });
  });

  it("appending zero records is a no-op that does not create the file", () => {
    const home = createTempHome();
    expect(appendFindings([], { homeDir: home })).toBe(true);
    expect(fs.existsSync(resolveFindingsFilePath(home))).toBe(false);
  });

  it("treats a missing findings file as an empty store", () => {
    const home = createTempHome();
    expect(readFindings({ homeDir: home })).toEqual([]);
  });

  it("skips corrupt lines fail-closed and warns on stderr", () => {
    const home = createTempHome();
    const filePath = resolveFindingsFilePath(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(baseRecord),
        "{broken json",
        JSON.stringify({ ...baseRecord, findingId: "" }),
        JSON.stringify({ ...baseRecord, kind: "nitpick" }),
        JSON.stringify({ ...baseRecord, severity: "blocker" }),
        JSON.stringify({ ...baseRecord, confirmed: "yes" }),
        JSON.stringify({ ...baseRecord, reviewedAt: "not-a-date" }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const records = readFindings({ homeDir: home });
    expect(records).toEqual([baseRecord]);
    expect(stderrSpy).toHaveBeenCalledTimes(6);
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warnings).toContain("corrupt line");
    expect(warnings).toContain(filePath);
  });

  it("reports append failures as false with a stderr warning instead of throwing", () => {
    const home = createTempHome();
    // A regular file where the home directory should be makes mkdir/append fail.
    const blocker = path.join(home, "blocker");
    fs.writeFileSync(blocker, "not a directory", "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(appendFindings([baseRecord], { homeDir: blocker })).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("could not be appended");
  });

  it("confirmFindings appends confirmation records that supersede the original via latest-wins", () => {
    const home = createTempHome();
    appendFindings([baseRecord, { ...baseRecord, findingId: "fnd_false1" }], { homeDir: home });

    const appended = confirmFindings(["fnd_abc123", "fnd_missing"], true, {
      homeDir: home,
      evidence: "rework closed PASS after the fix changed the repository",
    });
    expect(appended).toBe(1);

    const records = readFindings({ homeDir: home });
    expect(records).toHaveLength(3);
    const confirmed = records[2]!;
    expect(confirmed).toMatchObject({
      findingId: "fnd_abc123",
      confirmed: true,
      evidence: "rework closed PASS after the fix changed the repository",
      reviewerAgent: "opencode",
      category: "security",
    });
    expect(confirmed.reviewedAt).toBe(baseRecord.reviewedAt);

    const latest = aggregateFindingsPrecision(records);
    expect(latest).toHaveLength(1);
  });

  it("confirmFindings writes evidence only when provided", () => {
    const home = createTempHome();
    appendFindings([baseRecord], { homeDir: home });
    expect(confirmFindings(["fnd_abc123"], false, { homeDir: home })).toBe(1);
    const rejected = readFindings({ homeDir: home })[1]!;
    expect(rejected.confirmed).toBe(false);
    expect(rejected.evidence).toBeUndefined();
    expect(confirmFindings(["fnd_absent"], true, { homeDir: home })).toBe(0);
  });

  it("aggregates reviewer precision with latest-record-wins reconciliation", () => {
    const aggregate = aggregateFindingsPrecision([
      { ...baseRecord, findingId: "fnd_1", reviewerAgent: "opencode", confirmed: true },
      { ...baseRecord, findingId: "fnd_2", reviewerAgent: "opencode" },
      { ...baseRecord, findingId: "fnd_3", reviewerAgent: "codex", confirmed: false },
      { ...baseRecord, findingId: "fnd_4", reviewerAgent: "codex", confirmed: true },
      // A later line for the same id supersedes the earlier confirmation.
      { ...baseRecord, findingId: "fnd_1", reviewerAgent: "opencode", confirmed: true },
    ]);
    const opencode = aggregate.find((group) => group.reviewerAgent === "opencode")!;
    const codex = aggregate.find((group) => group.reviewerAgent === "codex")!;
    expect(opencode.total).toBe(2);
    expect(opencode.confirmed).toBe(1);
    expect(opencode.rejected).toBe(0);
    expect(opencode.precision).toBe(1);
    expect(codex.total).toBe(2);
    expect(codex.confirmed).toBe(1);
    expect(codex.rejected).toBe(1);
    expect(codex.precision).toBeCloseTo(0.5);
  });

  it("reports precision 0 when no finding has a confirmation verdict", () => {
    const aggregate = aggregateFindingsPrecision([{ ...baseRecord, confirmed: undefined }]);
    expect(aggregate[0]).toMatchObject({ total: 1, confirmed: 0, rejected: 0, precision: 0 });
  });

  it("sorts precision groups by total desc then reviewer name", () => {
    const aggregate = aggregateFindingsPrecision([
      ...[1, 2].map((n) => ({ ...baseRecord, findingId: `fnd_c${n}`, reviewerAgent: "codex" })),
      { ...baseRecord, findingId: "fnd_o1", reviewerAgent: "opencode" },
      { ...baseRecord, findingId: "fnd_a1", reviewerAgent: "antigravity" },
    ]);
    expect(aggregate.map((group) => group.reviewerAgent)).toEqual([
      "codex",
      "antigravity",
      "opencode",
    ]);
  });

  it("proposes graduations for categories reaching the threshold with distinct-finding counting", () => {
    const records: FindingRecord[] = [
      { ...baseRecord, findingId: "fnd_s1", category: "style", kind: "style" },
      { ...baseRecord, findingId: "fnd_s2", category: "style", kind: "style" },
      // Same finding re-recorded (confirmation mirror) must not double count.
      { ...baseRecord, findingId: "fnd_s1", category: "style", kind: "style", confirmed: true },
      { ...baseRecord, findingId: "fnd_sec1", category: "security", kind: "security" },
      { ...baseRecord, findingId: "fnd_sec2", category: "security", kind: "security" },
      { ...baseRecord, findingId: "fnd_sec3", category: "security", kind: "security" },
      { ...baseRecord, findingId: "fnd_gen1", category: "general", kind: "defect" },
    ];

    const proposals = proposeGraduations(records, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      category: "security",
      count: 3,
      suggestedCheck: "acceptance-script",
    });
    expect(proposals[0]!.sampleFindingIds).toEqual(["fnd_sec1", "fnd_sec2", "fnd_sec3"]);

    const relaxed = proposeGraduations(records, 2);
    expect(relaxed.map((proposal) => proposal.category)).toEqual(["security", "style"]);
    expect(relaxed[1]).toMatchObject({ count: 2, suggestedCheck: "eslint-rule" });
    expect(relaxed[1]!.sampleFindingIds).toHaveLength(2);

    expect(proposeGraduations(records, 99)).toEqual([]);
  });

  it("keeps graduation samples capped at five finding ids", () => {
    const records = [1, 2, 3, 4, 5, 6].map((n) => ({
      ...baseRecord,
      findingId: `fnd_t${n}`,
      category: "type-safety",
      kind: "defect" as const,
    }));
    const [proposal] = proposeGraduations(records, 6);
    expect(proposal!.count).toBe(6);
    expect(proposal!.sampleFindingIds).toHaveLength(5);
    expect(proposal!.suggestedCheck).toBe("eslint-rule");
  });
});

describe("core/findings enrichment classifiers", () => {
  it("resolves kind from category keywords first, then an explicit valid tag, then issue text", () => {
    expect(classifyFindingKind({ kind: "style" })).toBe("style");
    expect(classifyFindingKind({ kind: "STYLE ", issue: "security hole" })).toBe("style");
    // An out-of-taxonomy tag is ignored, category keywords then decide.
    expect(classifyFindingKind({ kind: "nitpick", category: "security" })).toBe("security");
    expect(classifyFindingKind({ category: "style" })).toBe("style");
    expect(classifyFindingKind({ category: "formatting" })).toBe("style");
    expect(classifyFindingKind({ category: "architecture" })).toBe("semantic");
    expect(classifyFindingKind({ category: "compatibility" })).toBe("risk");
    expect(classifyFindingKind({ issue: "SQL injection risk" })).toBe("security");
    expect(classifyFindingKind({ issue: "Inconsistent naming style" })).toBe("style");
    expect(classifyFindingKind({ issue: "This abstraction leaks details" })).toBe("semantic");
    expect(classifyFindingKind({ suggestion: "This API is deprecated and fragile" })).toBe("risk");
    expect(classifyFindingKind({ issue: "Off-by-one in the loop bound" })).toBe("defect");
    expect(classifyFindingKind({})).toBe("defect");
  });

  it("derives categories from explicit tags and keyword buckets", () => {
    expect(deriveFindingCategory({ category: "Security" })).toBe("security");
    expect(deriveFindingCategory({ category: "custom-domain-tag" })).toBe("custom-domain-tag");
    expect(deriveFindingCategory({ issue: "Credential leak in logs" })).toBe("security");
    expect(deriveFindingCategory({ issue: "The test suite is flaky" })).toBe("testing");
    expect(deriveFindingCategory({ suggestion: "Wrap in try/catch" })).toBe("error-handling");
    expect(deriveFindingCategory({ issue: "Memory leak on retry" })).toBe("performance");
    expect(deriveFindingCategory({ issue: "Unsafe cast to any" })).toBe("type-safety");
    expect(deriveFindingCategory({ issue: "README example is stale" })).toBe("documentation");
    expect(deriveFindingCategory({ issue: "Trailing whitespace", file: "a.ts" })).toBe("style");
    expect(deriveFindingCategory({ issue: "Off-by-one in the loop" })).toBe("general");
  });

  it("builds deterministic content-hashed finding ids", () => {
    const parts = {
      category: "security",
      kind: "security" as const,
      severity: "high",
      file: "src/auth.ts",
      line: "42",
      issue: "SQL Injection",
    };
    const id = buildFindingId(parts);
    expect(id).toMatch(/^fnd_[0-9a-f]{16}$/);
    expect(buildFindingId(parts)).toBe(id);
    expect(buildFindingId({ ...parts, issue: "SQL injection" })).not.toBe(id);
    expect(buildFindingId({ ...parts, line: undefined })).not.toBe(id);
  });

  it("enriches findings additively and recovers reviewer category/kind tags", () => {
    const tagged: ReviewFinding = {
      severity: "high",
      file: "src/auth.ts",
      line: "42",
      issue: "SQL Injection\ncategory: security\nkind: defect",
      suggestion: "Use parameterized query",
    };
    const enriched = enrichReviewFinding(tagged);
    expect(enriched.severity).toBe("high");
    expect(enriched.file).toBe("src/auth.ts");
    expect(enriched.line).toBe("42");
    expect(enriched.suggestion).toBe("Use parameterized query");
    expect(enriched.issue).toBe("SQL Injection");
    expect(enriched.category).toBe("security");
    expect(enriched.kind).toBe("security");
    expect(enriched.id).toBe(
      buildFindingId({
        category: "security",
        kind: "security",
        severity: "high",
        file: "src/auth.ts",
        line: "42",
        issue: "SQL Injection",
      }),
    );

    // The same tags inside the suggestion are recovered too.
    const suggestionTagged = enrichReviewFinding({
      severity: "low",
      file: "src/config.ts",
      issue: "Hardcoded timeout",
      suggestion: "Extract to a constant\ncategory: style",
    });
    expect(suggestionTagged.suggestion).toBe("Extract to a constant");
    expect(suggestionTagged.category).toBe("style");
    expect(suggestionTagged.kind).toBe("style");

    // Without tags, the classifier defaults apply deterministically.
    const plain = enrichReviewFinding({
      severity: "medium",
      file: "src/loop.ts",
      issue: "Off-by-one in the loop bound",
    });
    expect(plain.category).toBe("general");
    expect(plain.kind).toBe("defect");
    expect(enrichReviewFinding(plain)).toMatchObject({ id: plain.id });
  });
});

describe("core/findings rework closure extraction", () => {
  const finding: ReviewFinding = {
    severity: "high",
    file: "src/auth.ts",
    line: "42",
    issue: "SQL Injection",
    suggestion: "Use parameterized query",
  };

  function historyEntry(options: {
    task: string;
    timestamp?: string;
    fingerprintBefore?: string;
    fingerprintAfter?: string;
    repositoryRoot?: string;
    repositoryRootAfter?: string;
  }): SessionHistoryEntry {
    const repositoryRoot = options.repositoryRoot ?? "f:/repo";
    const repositoryRootAfter = options.repositoryRootAfter ?? repositoryRoot;
    return {
      role: "worker",
      task: options.task,
      timestamp: options.timestamp ?? "2026-09-01T10:05:00.000Z",
      status: "success",
      evidence: {
        ...(options.fingerprintBefore !== undefined
          ? {
              repositoryBefore: {
                capturedAt: "2026-09-01T10:04:00.000Z",
                repositoryRoot,
                dirty: true,
                fingerprint: options.fingerprintBefore,
                changedPaths: [],
              },
            }
          : {}),
        ...(options.fingerprintAfter !== undefined
          ? {
              repositoryAfter: {
                capturedAt: "2026-09-01T10:06:00.000Z",
                repositoryRoot: repositoryRootAfter,
                dirty: true,
                fingerprint: options.fingerprintAfter,
                changedPaths: [],
              },
            }
          : {}),
      },
    };
  }

  it("re-parses findings from the real buildReworkFixPrompt format (sync guard)", () => {
    const prompt = buildReworkFixPrompt({
      round: 1,
      maxRounds: 3,
      findings: [
        finding,
        { severity: "low", file: "src/config.ts", issue: "Missing trailing comma" },
      ],
      reviewSummary: "Review FAILED: 2 issue(s) detected.",
    });
    const parsed = parseReworkFindingsFromPrompt(prompt);
    expect(parsed).toEqual([
      {
        severity: "high",
        file: "src/auth.ts",
        line: "42",
        issue: "SQL Injection",
        suggestion: "Use parameterized query",
      },
      { severity: "low", file: "src/config.ts", issue: "Missing trailing comma" },
    ]);
  });

  it("returns no findings for non-rework text or the no-findings placeholder", () => {
    expect(parseReworkFindingsFromPrompt("Plain continuation task text")).toEqual([]);
    expect(
      parseReworkFindingsFromPrompt(buildReworkFixPrompt({ round: 2, maxRounds: 2, findings: [] })),
    ).toEqual([]);
  });

  it("collects closure findings from the last N rework turns with change signals", () => {
    const prompt1 = buildReworkFixPrompt({ round: 1, maxRounds: 2, findings: [finding] });
    const prompt2 = buildReworkFixPrompt({ round: 2, maxRounds: 2, findings: [finding] });
    const history = [
      historyEntry({ task: "Seed worker task" }),
      historyEntry({
        task: prompt1,
        timestamp: "2026-09-01T10:05:00.000Z",
        fingerprintBefore: "aaa",
        fingerprintAfter: "bbb",
      }),
      historyEntry({
        task: prompt2,
        timestamp: "2026-09-01T10:10:00.000Z",
        fingerprintBefore: "bbb",
        fingerprintAfter: "bbb",
      }),
    ];

    const closures = collectReworkClosureFindings(history, 2);
    expect(closures).toHaveLength(2);
    expect(closures[0]).toMatchObject({ round: 1, changedRepository: true });
    expect(closures[0]!.reviewedAt).toBe("2026-09-01T10:05:00.000Z");
    expect(closures[0]!.finding).toMatchObject({ file: "src/auth.ts", issue: "SQL Injection" });
    expect(closures[1]).toMatchObject({ round: 2, changedRepository: false });
  });

  it("only considers the requested number of trailing rework turns and no-signal evidence", () => {
    const prompt = buildReworkFixPrompt({ round: 1, maxRounds: 1, findings: [finding] });
    const history = [
      historyEntry({ task: prompt, fingerprintBefore: "aaa", fingerprintAfter: "bbb" }),
    ];
    expect(collectReworkClosureFindings(history, 0)).toEqual([]);
    // Evidence missing one side → no reliable change signal.
    expect(collectReworkClosureFindings([historyEntry({ task: prompt })], 1)).toEqual([
      expect.objectContaining({ round: 1, changedRepository: undefined }),
    ]);
    // Mismatched repository roots cannot be compared.
    expect(
      collectReworkClosureFindings(
        [
          historyEntry({
            task: prompt,
            fingerprintBefore: "aaa",
            fingerprintAfter: "bbb",
            repositoryRoot: "f:/repo",
            repositoryRootAfter: "f:/other",
          }),
        ],
        1,
      ),
    ).toEqual([expect.objectContaining({ changedRepository: undefined })]);
  });
});
