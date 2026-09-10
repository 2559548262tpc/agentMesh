import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STATS_MIN_COUNT,
  MAX_TIMEOUT_MS,
  collectConfigSemanticIssues,
  parseMode,
  parseRole,
  parseStatsMinCount,
  parseStatsWindow,
  parseTimeout,
  renderConfigValidationReport,
  renderFindingsReport,
  renderMetricsReport,
  resolveReviewInput,
  resolveRunInput,
  validateConfigFile,
} from "../../src/cli/validation.js";
import type { AgentNameResolver } from "../../src/cli/validation.js";
import {
  aggregateFindingsPrecision,
  appendFindings,
  proposeGraduations,
  readFindings,
} from "../../src/core/findings.js";
import type { FindingRecord } from "../../src/core/findings.js";
import type { MetricsAggregate } from "../../src/core/metrics.js";

describe("cli/validation", () => {
  it("accepts supported roles and modes", () => {
    expect(parseRole("reviewer")).toBe("reviewer");
    expect(parseMode("mcp")).toBe("mcp");
  });

  it("rejects invalid roles and modes instead of silently using worker or CLI behavior", () => {
    expect(() => parseRole("reviewre")).toThrow("Role must be");
    expect(() => parseMode("typo")).toThrow("Mode must be");
  });

  it("requires a positive bounded integer timeout", () => {
    expect(parseTimeout("1500")).toBe(1500);
    for (const invalid of ["abc", "0", "-1", "1.5", String(MAX_TIMEOUT_MS + 1)]) {
      expect(() => parseTimeout(invalid)).toThrow("Timeout must be");
    }
  });

  it("supports both legacy explicit-agent and configured-role run syntax", () => {
    expect(resolveRunInput("antigravity", ["implement feature"], undefined)).toEqual({
      agent: "antigravity",
      task: "implement feature",
    });
    expect(resolveRunInput("implement feature", [], undefined)).toEqual({
      task: "implement feature",
    });
    expect(resolveRunInput("implement", ["feature"], "claude")).toEqual({
      agent: "claude",
      task: "implement feature",
    });
  });

  it("resolves review input without confusing a known agent with a review task", () => {
    const known = (value: string) => value === "claude";
    expect(resolveReviewInput("claude", [], undefined, known)).toEqual({ agent: "claude" });
    expect(resolveReviewInput("focus on auth", [], undefined, known)).toEqual({
      task: "focus on auth",
    });
  });
});

describe("cli/stats", () => {
  it("accepts supported windows and rejects others", () => {
    expect(parseStatsWindow("all")).toBe("all");
    expect(parseStatsWindow("24h")).toBe("24h");
    expect(parseStatsWindow("7d")).toBe("7d");
    expect(() => parseStatsWindow("30d")).toThrow("Window must be");
    expect(() => parseStatsWindow("")).toThrow("Window must be");
  });

  const aggregate: MetricsAggregate = {
    window: "24h",
    taskCount: 3,
    unattributedStallEvents: 2,
    byModel: [
      {
        key: "gpt-5-codex",
        taskCount: 2,
        tokensIn: 300,
        tokensOut: 120,
        p50DurationMs: 1500,
        p95DurationMs: 4000,
        retryRate: 0.5,
        stallRate: 1,
        cancelCount: 1,
        outcomes: { ok: 1, error: 1, stalled: 0, cancelled: 0, timeout: 0 },
      },
      {
        key: "unknown",
        taskCount: 1,
        tokensIn: 0,
        tokensOut: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        retryRate: 0,
        stallRate: 0,
        cancelCount: 0,
        outcomes: { ok: 1, error: 0, stalled: 0, cancelled: 0, timeout: 0 },
      },
    ],
    byRole: [
      {
        key: "worker",
        taskCount: 3,
        tokensIn: 300,
        tokensOut: 120,
        p50DurationMs: 1500,
        p95DurationMs: 4000,
        retryRate: 0.5,
        stallRate: 1,
        cancelCount: 1,
        outcomes: { ok: 2, error: 1, stalled: 0, cancelled: 0, timeout: 0 },
      },
    ],
    byLane: [],
  };

  it("renders per-model and per-role tables with rates and the stall attribution note", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderMetricsReport(aggregate);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("AgentMesh Task Metrics (window: 24h, tasks: 3)");
      expect(output).toContain("By model:");
      expect(output).toContain("By role:");
      expect(output).toContain("gpt-5-codex");
      expect(output).toContain("50.0%");
      expect(output).toContain("100.0%");
      expect(output).toContain(
        "Note: 2 stall event(s) could not be attributed to a dispatch record.",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("renders an empty state when nothing has been recorded yet", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderMetricsReport({
        window: "all",
        taskCount: 0,
        unattributedStallEvents: 0,
        byModel: [],
        byRole: [],
        byLane: [],
      });
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("No task metrics recorded yet.");
      expect(output).not.toContain("By model:");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("cli/stats --findings", () => {
  const createdDirectories: string[] = [];

  function createTempHome(): string {
    const home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-stats-findings-")),
    );
    createdDirectories.push(home);
    return home;
  }

  afterEach(() => {
    for (const directory of createdDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const baseRecord: FindingRecord = {
    findingId: "fnd_abc123",
    sessionId: "bridge-sess_rev1",
    reviewerAgent: "opencode",
    category: "security",
    kind: "security",
    severity: "high",
    file: "src/auth.ts",
    reviewedAt: "2026-09-01T10:00:00.000Z",
  };

  /** Two confirmed, one rejected security finding plus one open style finding from opencode. */
  function populateStore(home: string): void {
    appendFindings(
      [
        { ...baseRecord, confirmed: true },
        { ...baseRecord, findingId: "fnd_def456", confirmed: true },
        { ...baseRecord, findingId: "fnd_ghi789", confirmed: false },
        { ...baseRecord, findingId: "fnd_jkl012", category: "style", kind: "style" },
        {
          ...baseRecord,
          findingId: "fnd_mno345",
          reviewerAgent: "codex",
          category: "testing",
          kind: "defect",
        },
      ],
      { homeDir: home },
    );
  }

  it("accepts positive integer min counts and rejects others", () => {
    expect(DEFAULT_STATS_MIN_COUNT).toBe(3);
    expect(parseStatsMinCount("3")).toBe(3);
    expect(parseStatsMinCount("1")).toBe(1);
    for (const invalid of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parseStatsMinCount(invalid)).toThrow("Min count must be a positive integer.");
    }
  });

  it("renders reviewer precision and graduation proposals from a populated temp-dir store", () => {
    const home = createTempHome();
    populateStore(home);
    const findings = readFindings({ homeDir: home });
    const precision = aggregateFindingsPrecision(findings);
    const graduations = proposeGraduations(findings, 3);
    expect(precision).toEqual([
      { reviewerAgent: "opencode", total: 4, confirmed: 2, rejected: 1, precision: 2 / 3 },
      { reviewerAgent: "codex", total: 1, confirmed: 0, rejected: 0, precision: 0 },
    ]);
    expect(graduations).toEqual([
      {
        category: "security",
        count: 3,
        sampleFindingIds: ["fnd_abc123", "fnd_def456", "fnd_ghi789"],
        suggestedCheck: "acceptance-script",
      },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderFindingsReport({ precision, graduations, minCount: 3 });
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("AgentMesh Reviewer Findings (min count: 3)");
      expect(output).toContain("Reviewer precision:");
      expect(output).toContain("opencode");
      expect(output).toContain("66.7%");
      expect(output).toContain("0.0%");
      expect(output).toContain("Graduation proposals (categories with >= 3 findings):");
      expect(output).toContain("acceptance-script");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("suggests an eslint rule for lintable categories when the minimum count is lowered", () => {
    const home = createTempHome();
    populateStore(home);
    const findings = readFindings({ homeDir: home });
    const graduations = proposeGraduations(findings, 1);
    expect(graduations.map((proposal) => [proposal.category, proposal.suggestedCheck])).toEqual([
      ["security", "acceptance-script"],
      ["style", "eslint-rule"],
      ["testing", "acceptance-script"],
    ]);
  });

  it("renders the no-proposal note when no category reaches the minimum count", () => {
    const home = createTempHome();
    populateStore(home);
    const findings = readFindings({ homeDir: home });
    const precision = aggregateFindingsPrecision(findings);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderFindingsReport({
        precision,
        graduations: proposeGraduations(findings, 5),
        minCount: 5,
      });
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("(no categories reached the minimum count)");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("renders an empty state when the findings store is empty", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderFindingsReport({ precision: [], graduations: [], minCount: 3 });
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("No reviewer findings recorded yet.");
      expect(output).not.toContain("Reviewer precision:");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits a machine-readable {precision, graduations} payload for --json", () => {
    const home = createTempHome();
    populateStore(home);
    const findings = readFindings({ homeDir: home });
    const payload = {
      precision: aggregateFindingsPrecision(findings),
      graduations: proposeGraduations(findings, 3),
    };
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      precision: [
        { reviewerAgent: "opencode", total: 4, confirmed: 2, rejected: 1, precision: 2 / 3 },
        { reviewerAgent: "codex", total: 1, confirmed: 0, rejected: 0, precision: 0 },
      ],
      graduations: [
        {
          category: "security",
          count: 3,
          sampleFindingIds: ["fnd_abc123", "fnd_def456", "fnd_ghi789"],
          suggestedCheck: "acceptance-script",
        },
      ],
    });
  });

  it("emits empty precision and graduation arrays for a cold-start findings store", () => {
    const home = createTempHome();
    const findings = readFindings({ homeDir: home });
    expect(findings).toEqual([]);
    expect({
      precision: aggregateFindingsPrecision(findings),
      graduations: proposeGraduations(findings, DEFAULT_STATS_MIN_COUNT),
    }).toEqual({ precision: [], graduations: [] });
  });
});

describe("cli/config validate", () => {
  const resolver: AgentNameResolver = (value) => {
    const known = new Set(["codex", "claude", "opencode", "zcode", "codex-cli"]);
    return known.has(value.toLowerCase().trim()) ? value.toLowerCase().trim() : undefined;
  };

  it("reports no issues for a resolvable roles-only config", () => {
    expect(
      collectConfigSemanticIssues({ version: 1, roles: { worker: { agent: "codex" } } }, resolver),
    ).toEqual([]);
  });

  it("errors on an unresolvable role assignment with the exact field path and a fix", () => {
    const issues = collectConfigSemanticIssues(
      { version: 1, roles: { worker: { agent: "codexx" } } },
      resolver,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "error",
      field: "roles.worker.agent",
    });
    expect(issues[0]?.fix).toContain('"codex"');
  });

  it("keeps unresolvable agents keys as warned profile-variant ids, not errors", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { "codex-strong": { tier: "strong", sandboxLevel: "native-sandbox" } },
      },
      resolver,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.field).toBe("agents.codex-strong");
  });

  it("warns when tier=strong declares only prompt-only protection", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { codex: { tier: "strong", sandboxLevel: "prompt-only" } },
      },
      resolver,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warning",
      field: "agents.codex.sandboxLevel",
    });
  });

  it("accepts candidates referencing aliases or sibling entries but errors on dangling ones", () => {
    const valid = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: {
          zcode: { tier: "weak", candidates: ["codex-medium"] },
          "codex-medium": { tier: "medium", candidates: ["codex-cli"] },
          codex: { tier: "strong" },
        },
      },
      resolver,
    );
    expect(valid.filter((issue) => issue.severity === "error")).toEqual([]);

    const dangling = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { zcode: { candidates: ["codex-max"] } },
      },
      resolver,
    );
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toMatchObject({
      severity: "error",
      field: "agents.zcode.candidates.0",
    });
    expect(dangling[0]?.fix).toContain('Declare an "agents"."codex-max" block');
  });

  it("rejects duplicate and self-referencing candidates with indexed field paths", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { zcode: { candidates: ["codex", "codex", "zcode"] } },
      },
      resolver,
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      "agents.zcode.candidates.1",
      "agents.zcode.candidates.2",
    ]);
  });

  it("detects cycles across the declared candidate graph", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: {
          a: { candidates: ["b"] },
          b: { candidates: ["a"] },
        },
      },
      resolver,
    );
    const cycleIssue = issues.find((issue) => issue.message.includes("cycle"));
    expect(cycleIssue?.severity).toBe("error");
    expect(cycleIssue?.message).toContain("a -> b -> a");
  });

  describe("validateConfigFile", () => {
    const createdDirectories: string[] = [];

    function createProject(config: unknown): { root: string; configPath: string } {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-validate-"));
      createdDirectories.push(root);
      fs.mkdirSync(path.join(root, ".git"));
      fs.mkdirSync(path.join(root, ".agentmesh"));
      const configPath = path.join(root, ".agentmesh", "config.json");
      fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
      return { root, configPath };
    }

    afterEach(() => {
      for (const directory of createdDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it("returns an actionable error when no project config exists", () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-validate-empty-"));
      createdDirectories.push(empty);
      const report = validateConfigFile(empty, resolver);
      expect(report.summary.errors).toBe(1);
      expect(report.path).toBeUndefined();
      expect(report.issues[0]?.field).toBe("config");
      expect(report.issues[0]?.message).toContain("No .agentmesh/config.json");
      expect(report.issues[0]?.fix).toContain('"version"');
    });

    it("passes a fully valid routing configuration", () => {
      const { root, configPath } = createProject({
        version: 1,
        roles: { worker: "zcode", reviewer: { agent: "opencode" } },
        allowPromptOnly: true,
        agents: {
          zcode: {
            tier: "weak",
            costLevel: 1,
            speed: "fast",
            strengths: ["quick summaries"],
            notGoodAt: ["deep refactors"],
            sandboxLevel: "prompt-only",
            notes: "cheap bulk work",
            candidates: ["codex"],
          },
          codex: { tier: "strong", costLevel: 5, sandboxLevel: "native-sandbox" },
        },
      });
      const report = validateConfigFile(root, resolver);
      expect(report.path).toBe(configPath);
      expect(report.summary).toEqual({ errors: 0, warnings: 0 });
    });

    it("maps schema violations to per-field errors with fix examples", () => {
      const { root } = createProject({
        version: 1,
        roles: { worker: "codex" },
        agents: { codex: { costLevel: 9, tier: "powerful" } },
      });
      const report = validateConfigFile(root, resolver);
      expect(report.summary.errors).toBeGreaterThanOrEqual(2);
      const fields = report.issues.map((issue) => issue.field);
      expect(fields).toContain("agents.codex.costLevel");
      expect(fields).toContain("agents.codex.tier");
      for (const issue of report.issues) {
        expect(issue.fix.length).toBeGreaterThan(0);
      }
    });

    it("renders errors, field paths, fixes, and summary in human-readable output", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        renderConfigValidationReport({
          path: "C:\\proj\\.agentmesh\\config.json",
          issues: [
            {
              severity: "error",
              field: "roles.worker.agent",
              message: "Unknown agent name or alias 'codexx'.",
              fix: 'Set "roles.worker" to a known agent.',
            },
            {
              severity: "warning",
              field: "agents.codex.sandboxLevel",
              message: "tier strong with prompt-only protection.",
              fix: "Use a channel with real isolation.",
            },
          ],
          summary: { errors: 1, warnings: 1 },
        });
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("[ERROR] roles.worker.agent");
        expect(output).toContain("[WARN]  agents.codex.sandboxLevel");
        expect(output).toContain("Fix:");
        expect(output).toContain("Summary: 1 error(s) / 1 warning(s)");
        expect(output).toContain("Result: invalid");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("renders a clean result when there are no issues", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        renderConfigValidationReport({ issues: [], summary: { errors: 0, warnings: 0 } });
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("No issues found.");
        expect(output).toContain("Result: valid.");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("keeps exit-worthy result positive when only warnings are present", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        renderConfigValidationReport({
          issues: [
            {
              severity: "warning",
              field: "agents.codex-strong",
              message: "'codex-strong' is not a registered agent name or alias.",
              fix: "Provision the matching profile file.",
            },
          ],
          summary: { errors: 0, warnings: 1 },
        });
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("[WARN]  agents.codex-strong");
        expect(output).not.toContain("[ERROR]");
        expect(output).toContain("Result: valid, with warnings.");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("treats alias-resolving candidates as valid chain terminators", () => {
      const issues = collectConfigSemanticIssues(
        {
          version: 1,
          roles: {},
          agents: { zcode: { tier: "weak", candidates: ["codex"] } },
        },
        resolver,
      );
      expect(issues).toEqual([]);
    });
  });
});
