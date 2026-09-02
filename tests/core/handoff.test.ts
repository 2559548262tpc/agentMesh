import { describe, it, expect } from "vitest";
import {
  analyzeHandoff,
  computeHandoffGrade,
  formatHandoffSummary,
} from "../../src/core/handoff.js";
import { buildSharedContextDetailed } from "../../src/core/runner.js";
import type {
  BridgeSession,
  RepositoryStateEvidence,
  SessionHistoryEntry,
} from "../../src/core/types.js";

const UPSTREAM_ID = "bridge-sess_upstream0";

function makeEntry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    role: "worker",
    task: "Implement the parser module",
    timestamp: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    status: "success",
    summary: "Parser implemented with tests",
    ...overrides,
  };
}

function makeUpstreamSession(history: SessionHistoryEntry[]): BridgeSession {
  return {
    id: UPSTREAM_ID,
    agent: "codex",
    cwd: "/repo",
    role: "worker",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    history,
  };
}

function repoEvidence(fingerprint: string): RepositoryStateEvidence {
  return {
    capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    repositoryRoot: "/repo",
    dirty: false,
    fingerprint,
    changedPaths: [],
  };
}

/** Upstream turn producing every section: task, summary, finalAnswer, findings, evidence. */
function fullHistory(): SessionHistoryEntry[] {
  return [
    makeEntry({
      finalAnswer: "The parser now handles nested expressions.",
      findings: [
        {
          severity: "medium",
          file: "src/parser.ts",
          line: 12,
          issue: "Missing boundary check for empty token stream",
          suggestion: "Guard the reduce step",
        },
      ],
      evidence: { repositoryAfter: repoEvidence("f".repeat(64)) },
    }),
  ];
}

/**
 * Builds a downstream context entry together with the exact injected bytes
 * produced by the real shared-context renderer, so content-basis judgments
 * run against the verbatim delivery format.
 */
function renderInjection(
  history: SessionHistoryEntry[],
  currentFingerprint?: string,
): { content: string; chars: number; truncated: boolean; totalChars: number } {
  const current = currentFingerprint === undefined ? undefined : repoEvidence(currentFingerprint);
  const rendered = buildSharedContextDetailed([makeUpstreamSession(history)], current);
  if (!rendered) throw new Error("fixture history failed to render");
  const source = rendered.sources[0]!;
  return {
    content: rendered.text,
    chars: source.chars,
    truncated: source.truncated,
    totalChars: rendered.text.length,
  };
}

function downEntry(
  overrides: Partial<SessionHistoryEntry> & { task: string },
  extra: {
    contextSources?: string[];
    audit?: { chars: number; truncated: boolean; totalChars?: number };
    content?: string;
  },
): SessionHistoryEntry {
  return {
    role: "reviewer",
    timestamp: new Date("2026-01-02T00:00:00.000Z").toISOString(),
    status: "success",
    ...overrides,
    ...(extra.contextSources ? { contextSources: extra.contextSources } : {}),
    ...(extra.audit
      ? {
          sharedContextAudit: {
            bytes: extra.audit.totalChars ?? extra.audit.chars,
            sha256: "a".repeat(64),
            totalChars: extra.audit.totalChars ?? extra.audit.chars,
            sources: [
              {
                sessionId: UPSTREAM_ID,
                chars: extra.audit.chars,
                truncated: extra.audit.truncated,
              },
            ],
          },
        }
      : {}),
  };
}

describe("core/handoff grade thresholds", () => {
  it("grades lossless when every applicable section is preserved", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: true,
      sections: [
        { section: "task", state: "preserved" },
        { section: "summary", state: "preserved" },
        { section: "finalAnswer", state: "preserved" },
        { section: "findings", state: "not-applicable" },
        { section: "evidence", state: "not-applicable" },
      ],
      staleFreshness: false,
    });
    expect(grade).toBe("lossless");
  });

  it("grades minor-truncation when a section is truncated", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: true,
      sections: [
        { section: "task", state: "preserved" },
        { section: "finalAnswer", state: "truncated" },
      ],
      staleFreshness: false,
    });
    expect(grade).toBe("minor-truncation");
  });

  it("grades minor-truncation on STALE freshness even without truncation", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: true,
      sections: [{ section: "task", state: "preserved" }],
      staleFreshness: true,
    });
    expect(grade).toBe("minor-truncation");
  });

  it("grades partial-loss when a non-task section is missing", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: true,
      sections: [
        { section: "task", state: "preserved" },
        { section: "summary", state: "missing" },
        { section: "finalAnswer", state: "missing" },
      ],
      staleFreshness: false,
    });
    expect(grade).toBe("partial-loss");
  });

  it("grades severe-loss when the task section is missing", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: true,
      sections: [
        { section: "task", state: "missing" },
        { section: "summary", state: "preserved" },
      ],
      staleFreshness: false,
    });
    expect(grade).toBe("severe-loss");
  });

  it("grades lost when no context record exists", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: false,
      sections: [{ section: "task", state: "preserved" }],
      staleFreshness: false,
    });
    expect(grade).toBe("lost");
  });

  it("grades lost when every applicable section is missing", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: true,
      sections: [
        { section: "task", state: "missing" },
        { section: "summary", state: "missing" },
      ],
      staleFreshness: false,
    });
    expect(grade).toBe("lost");
  });

  it("grades lossless vacuously when nothing was deliverable", () => {
    const grade = computeHandoffGrade({
      hasContextRecord: true,
      sections: [{ section: "task", state: "not-applicable" }],
      staleFreshness: false,
    });
    expect(grade).toBe("lossless");
  });
});

describe("core/handoff analyzeHandoff", () => {
  it("reports lossless on the verbatim recorded injection (content basis, MATCHED)", () => {
    const injection = renderInjection(fullHistory(), "f".repeat(64));
    const report = analyzeHandoff({
      upstreamHistory: fullHistory(),
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          { contextSources: [UPSTREAM_ID], audit: injection, content: injection.content },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, injection.content]]),
    });

    expect(report.grade).toBe("lossless");
    expect(report.sections.map((section) => section.state)).toEqual([
      "preserved",
      "preserved",
      "preserved",
      "preserved",
      "preserved",
    ]);
    expect(report.sections.every((section) => section.basis === "content")).toBe(true);
    expect(report.missingKeys).toEqual([]);
    expect(report.truncatedKeys).toEqual([]);
    expect(report.preservedSections).toHaveLength(5);
    expect(report.analyzedEntry).toMatchObject({
      turnNumber: 1,
      freshness: "MATCHED",
      basis: "content",
      truncated: false,
      analyzed: true,
      referencedSessionIds: [UPSTREAM_ID],
    });
  });

  it("detects truncation markers on oversized final answers (minor-truncation)", () => {
    const history = [
      makeEntry({
        finalAnswer: "z".repeat(4600),
        evidence: { repositoryAfter: repoEvidence("f".repeat(64)) },
      }),
    ];
    const injection = renderInjection(history, "f".repeat(64));
    expect(injection.truncated).toBe(true);
    const report = analyzeHandoff({
      upstreamHistory: history,
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          { contextSources: [UPSTREAM_ID], audit: injection, content: injection.content },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, injection.content]]),
    });

    expect(report.grade).toBe("minor-truncation");
    expect(report.truncatedKeys).toEqual(["finalAnswer"]);
    expect(report.missingKeys).toEqual([]);
  });

  it("downgrades an otherwise lossless handoff on STALE freshness", () => {
    const injection = renderInjection(fullHistory(), "e".repeat(64));
    expect(injection.content).toContain("Context freshness: STALE");
    const report = analyzeHandoff({
      upstreamHistory: fullHistory(),
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          { contextSources: [UPSTREAM_ID], audit: injection, content: injection.content },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, injection.content]]),
    });

    expect(report.sections.every((section) => section.state === "preserved")).toBe(true);
    expect(report.analyzedEntry?.freshness).toBe("STALE");
    expect(report.grade).toBe("minor-truncation");
  });

  it("does not downgrade when only another source is STALE (per-source attribution)", () => {
    const otherId = "bridge-sess_other00";
    const upstreamSession = makeUpstreamSession(fullHistory());
    const otherSession: BridgeSession = {
      ...makeUpstreamSession([
        makeEntry({
          task: "unrelated source",
          summary: "stale work",
          evidence: { repositoryAfter: repoEvidence("e".repeat(64)) },
        }),
      ]),
      id: otherId,
    };
    const rendered = buildSharedContextDetailed(
      [upstreamSession, otherSession],
      repoEvidence("f".repeat(64)),
    );
    if (!rendered) throw new Error("fixture failed to render");
    const report = analyzeHandoff({
      upstreamHistory: fullHistory(),
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          {
            contextSources: [UPSTREAM_ID, otherId],
            audit: { chars: rendered.sources[0]!.chars, truncated: rendered.sources[0]!.truncated },
          },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, rendered.text]]),
    });

    // The upstream block is MATCHED; the other source's STALE must not leak in.
    expect(rendered.text).toContain("Context freshness: STALE");
    expect(report.analyzedEntry?.freshness).toBe("MATCHED");
    expect(report.grade).toBe("lossless");
  });

  it("grades partial-loss when the injection content lacks produced sections", () => {
    const upstream = fullHistory();
    const partial = [
      "## Shared Context",
      `### Source 1 of 1 [Session: ${UPSTREAM_ID} | Agent: CODEX | Turns: 1]`,
      "Context freshness: MATCHED: ok.",
      `Task: ${upstream[0]!.task}`,
      `Summary: ${upstream[0]!.summary}`,
    ].join("\n");
    const report = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          {
            contextSources: [UPSTREAM_ID],
            audit: { chars: partial.length, truncated: true },
            content: partial,
          },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, partial]]),
    });

    expect(report.grade).toBe("partial-loss");
    expect(report.missingKeys).toEqual(["finalAnswer", "findings", "evidence"]);
    expect(report.preservedSections).toEqual(["task", "summary"]);
  });

  it("grades severe-loss when the task text never arrived", () => {
    const upstream = fullHistory();
    const headless = [
      "## Shared Context",
      `### Source 1 of 1 [Session: ${UPSTREAM_ID} | Agent: CODEX | Turns: 1]`,
      "Context freshness: MATCHED: ok.",
      `Summary: ${upstream[0]!.summary}`,
    ].join("\n");
    const report = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          {
            contextSources: [UPSTREAM_ID],
            audit: { chars: headless.length, truncated: true },
            content: headless,
          },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, headless]]),
    });

    expect(report.grade).toBe("severe-loss");
    expect(report.missingKeys).toEqual(["task", "finalAnswer", "findings", "evidence"]);
  });

  it("grades lost when the downstream session records no contextSources", () => {
    const upstream = fullHistory();
    const report = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [downEntry({ task: "review without context" }, {})],
      upstreamSessionId: UPSTREAM_ID,
    });

    expect(report.grade).toBe("lost");
    expect(report.analyzedEntry).toBeUndefined();
    expect(report.contextEntries).toEqual([]);
    expect(report.missingKeys).toEqual(["task", "summary", "finalAnswer", "findings", "evidence"]);
  });

  it("grades lost when the context record exists but nothing is verifiable", () => {
    const upstream = fullHistory();
    const report = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry({ task: "review the parser" }, { contextSources: [UPSTREAM_ID] }),
      ],
      upstreamSessionId: UPSTREAM_ID,
    });

    expect(report.grade).toBe("lost");
    expect(report.sections.every((section) => section.state === "missing")).toBe(true);
    expect(report.sections.every((section) => section.basis === "metadata")).toBe(true);
    expect(report.sections[0]!.detail).toContain("conservatively");
  });

  it("judges from audit metadata when no injection content is recorded", () => {
    const upstream = fullHistory();
    const cleanReport = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          { contextSources: [UPSTREAM_ID], audit: { chars: 1234, truncated: false } },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
    });
    expect(cleanReport.grade).toBe("lossless");
    expect(cleanReport.sections.every((section) => section.basis === "metadata")).toBe(true);
    expect(cleanReport.sections[0]!.detail).toContain("judged from metadata");
    expect(cleanReport.analyzedEntry?.freshness).toBe("not-recorded");
    expect(cleanReport.analyzedEntry?.injectedChars).toBe(1234);

    const truncatedReport = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          { contextSources: [UPSTREAM_ID], audit: { chars: 12000, truncated: true } },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
    });
    expect(truncatedReport.grade).toBe("minor-truncation");
    expect(truncatedReport.truncatedKeys).toEqual([
      "task",
      "summary",
      "finalAnswer",
      "findings",
      "evidence",
    ]);
  });

  it("marks upstream-produced sections not-applicable when they do not exist", () => {
    const history = [makeEntry()];
    const injection = renderInjection(history, "f".repeat(64));
    const report = analyzeHandoff({
      upstreamHistory: history,
      downstreamHistory: [
        downEntry(
          { task: "continue the work" },
          { contextSources: [UPSTREAM_ID], audit: injection, content: injection.content },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, injection.content]]),
    });

    expect(report.grade).toBe("lossless");
    const states = Object.fromEntries(
      report.sections.map((section) => [section.section, section.state]),
    );
    expect(states).toEqual({
      task: "preserved",
      summary: "preserved",
      finalAnswer: "not-applicable",
      findings: "not-applicable",
      evidence: "not-applicable",
    });
  });

  it("analyzes the latest referencing entry and lists every context entry (multi-entry)", () => {
    const upstream = fullHistory();
    const staleInjection = renderInjection(upstream, "e".repeat(64));
    const freshInjection = renderInjection(upstream, "f".repeat(64));
    const report = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry(
          { task: "first review" },
          {
            contextSources: [UPSTREAM_ID],
            audit: { chars: 999, truncated: true },
            content: staleInjection.content,
          },
        ),
        downEntry(
          { task: "second review" },
          { contextSources: [UPSTREAM_ID], audit: freshInjection, content: freshInjection.content },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([
        [1, staleInjection.content],
        [2, freshInjection.content],
      ]),
    });

    expect(report.contextEntries).toHaveLength(2);
    expect(report.contextEntries[0]).toMatchObject({
      turnNumber: 1,
      analyzed: false,
      truncated: true,
    });
    expect(report.contextEntries[1]).toMatchObject({
      turnNumber: 2,
      analyzed: true,
      truncated: false,
    });
    expect(report.analyzedEntry?.turnNumber).toBe(2);
    expect(report.analyzedEntry?.freshness).toBe("MATCHED");
    expect(report.grade).toBe("lossless");
  });

  it("treats the latest referencing entry as analyzed even when it is not the newest turn", () => {
    const upstream = fullHistory();
    const injection = renderInjection(upstream, "f".repeat(64));
    const report = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          { contextSources: [UPSTREAM_ID], audit: injection, content: injection.content },
        ),
        downEntry({ task: "follow-up without context" }, {}),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, injection.content]]),
    });

    expect(report.analyzedEntry?.turnNumber).toBe(1);
    expect(report.grade).toBe("lossless");
  });
});

describe("core/handoff summary formatting", () => {
  it("renders a compact human-readable summary", () => {
    const upstream = fullHistory();
    const injection = renderInjection(upstream, "f".repeat(64));
    const report = analyzeHandoff({
      upstreamHistory: upstream,
      downstreamHistory: [
        downEntry(
          { task: "review the parser" },
          { contextSources: [UPSTREAM_ID], audit: injection, content: injection.content },
        ),
      ],
      upstreamSessionId: UPSTREAM_ID,
      injectedContextByTurn: new Map([[1, injection.content]]),
    });
    const summary = formatHandoffSummary(report);

    expect(summary).toContain("Handoff fidelity grade: lossless");
    expect(summary).toContain("Preserved: task, summary, finalAnswer, findings, evidence");
    expect(summary).toContain("Missing: none");
    expect(summary).toContain("basis content");
    expect(summary).toContain("freshness MATCHED");
  });

  it("renders a lost summary when no context entry exists", () => {
    const report = analyzeHandoff({
      upstreamHistory: [makeEntry()],
      downstreamHistory: [downEntry({ task: "review without context" }, {})],
      upstreamSessionId: UPSTREAM_ID,
    });

    expect(formatHandoffSummary(report)).toContain("Analyzed context entry: none");
  });
});
