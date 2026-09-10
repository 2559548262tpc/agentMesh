import { describe, it, expect } from "vitest";
import {
  buildLedger,
  findUnknownRequirementIds,
  formatCoverage,
  needsRuling,
  pendingRulingIds,
} from "../../src/core/ledger.js";
import type { ReconciliationLedger } from "../../src/core/ledger.js";
import type { WorkflowSnapshot, WorkflowSpec } from "../../src/core/workflow.js";
import type { RequirementsFile } from "../../src/core/requirements.js";
import type { WorkflowStageRecord } from "../../src/core/workflow.js";

/**
 * v0.5 Batch 1 #4: the engine join. Row status derivation is the fail-closed
 * heart of the reconciliation ledger — PASS requires covering command
 * evidence in every declaring stage; anything less lands in PENDING_RULING.
 */

const requirements: RequirementsFile = {
  source: "doc.md",
  items: [
    {
      id: "R1",
      ears: "The system SHALL add",
      kind: "unconditional",
      quote: "add",
      decidable: true,
    },
    {
      id: "R2",
      ears: "WHEN full THEN the system SHALL refuse",
      kind: "event-driven",
      quote: "refuse",
      decidable: true,
    },
    { id: "R3", ears: null, kind: null, quote: "美观", decidable: false },
  ],
};

const spec: WorkflowSpec = {
  name: "wf",
  stages: [
    {
      name: "implement",
      roles: ["worker"],
      requirements: ["R1", "R2"],
      dispatch: { taskTemplate: "t" },
      acceptance: {
        commands: [
          { cmd: "node test1.js", covers: ["R1"] },
          { cmd: "node test2.js", covers: ["R2"] },
        ],
      },
    },
    { name: "review", roles: ["reviewer"], dispatch: { taskTemplate: "t" } },
  ],
};

function stageRecord(
  overrides: Partial<WorkflowStageRecord> & { name: string },
): WorkflowStageRecord {
  return {
    index: 0,
    status: "passed",
    transitions: [],
    tasks: [],
    sessionIds: [],
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(stages: WorkflowStageRecord[]): WorkflowSnapshot {
  return {
    workflowId: "wf_test",
    name: "wf",
    status: "done",
    stages,
    startedAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

const baseStages = () => [
  stageRecord({
    name: "implement",
    index: 0,
    acceptance: {
      ok: true,
      commands: [
        {
          command: "node test1.js",
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          covers: ["R1"],
        },
        {
          command: "node test2.js",
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          covers: ["R2"],
        },
      ],
      files: [],
    },
  }),
  stageRecord({ name: "review", index: 1 }),
];

describe("core/ledger (v0.5 reconciliation join)", () => {
  it("marks covered, passing requirements as PASS with command evidence", () => {
    const ledger = buildLedger({
      workflowId: "wf_test",
      spec,
      snapshot: snapshot(baseStages()),
      requirements,
      nowIso: "2026-09-08T01:00:00.000Z",
    });
    expect(ledger.rows.find((row) => row.id === "R1")).toMatchObject({
      status: "PASS",
      ears: "The system SHALL add",
    });
    expect(ledger.rows.find((row) => row.id === "R1")!.evidence.commands).toEqual([
      { cmd: "node test1.js", exitCode: 0, covers: ["R1"], ok: true },
    ]);
    expect(ledger.invariant).toEqual({ requirements: 3, rows: 3, ok: true });
  });

  it("keeps a stage-passed requirement without covering evidence in PENDING_RULING", () => {
    const stages = baseStages();
    stages[0]!.acceptance!.commands = stages[0]!.acceptance!.commands.filter((command) =>
      (command.covers ?? []).includes("R1"),
    );
    const ledger = buildLedger({
      workflowId: "wf_test",
      spec,
      snapshot: snapshot(stages),
      requirements,
      nowIso: "2026-09-08T01:00:00.000Z",
    });
    const row = ledger.rows.find((entry) => entry.id === "R2")!;
    expect(row.status).toBe("PENDING_RULING");
    expect(needsRuling(ledger)).toBe(true);
    expect(pendingRulingIds(ledger)).toContain("R2");
  });

  it("derives FAIL from a failed declaring stage (cross-stage conjunction)", () => {
    const stages = baseStages();
    stages[0]!.status = "failed";
    const ledger = buildLedger({
      workflowId: "wf_test",
      spec,
      snapshot: snapshot(stages),
      requirements,
      nowIso: "2026-09-08T01:00:00.000Z",
    });
    expect(ledger.rows.find((entry) => entry.id === "R1")!.status).toBe("FAIL");
    expect(ledger.rows.find((entry) => entry.id === "R2")!.status).toBe("FAIL");
  });

  it("derives ESCALATED over FAIL when a declaring stage escalated", () => {
    const stages = baseStages();
    stages[0]!.status = "escalated";
    const ledger = buildLedger({
      workflowId: "wf_test",
      spec,
      snapshot: snapshot(stages),
      requirements,
      nowIso: "2026-09-08T01:00:00.000Z",
    });
    expect(ledger.rows.find((entry) => entry.id === "R1")!.status).toBe("ESCALATED");
  });

  it("routes never-declared requirements to PENDING_RULING (no dropped accounts)", () => {
    const ledger = buildLedger({
      workflowId: "wf_test",
      spec,
      snapshot: snapshot(baseStages()),
      requirements,
      nowIso: "2026-09-08T01:00:00.000Z",
    });
    const row = ledger.rows.find((entry) => entry.id === "R3")!;
    expect(row.status).toBe("PENDING_RULING");
    // Undecidable rows keep the quote as the self-describing text.
    expect(row.ears).toBe("美观");
    expect(row.evidence.findings.join("\n")).toContain("No stage declares");
    expect(ledger.uncoveredIds).toEqual(["R3"]);
  });

  it("reports spec ids missing from the requirements set", () => {
    expect(findUnknownRequirementIds(spec, requirements)).toEqual([]);
    const bogusSpec: WorkflowSpec = {
      ...spec,
      stages: [{ ...spec.stages[0]!, requirements: ["R1", "R9"] }],
    };
    expect(findUnknownRequirementIds(bogusSpec, requirements)).toEqual(["R9"]);
  });

  it("formats the coverage string with the pending-ruling note", () => {
    const ledger: ReconciliationLedger = buildLedger({
      workflowId: "wf_test",
      spec,
      snapshot: snapshot(baseStages()),
      requirements,
      nowIso: "2026-09-08T01:00:00.000Z",
    });
    // R1/R2 PASS, R3 PENDING_RULING.
    expect(formatCoverage(ledger)).toBe("2/3（1 PENDING_RULING）");
  });

  it("needs_ruling is false when every row carries evidence", () => {
    const fullSpec: WorkflowSpec = {
      ...spec,
      stages: [{ ...spec.stages[0]!, requirements: ["R1", "R2", "R3"] }],
    };
    const stages = baseStages();
    stages[0]!.acceptance!.commands.push({
      command: "node test3.js",
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      covers: ["R3"],
    });
    const ledger = buildLedger({
      workflowId: "wf_test",
      spec: fullSpec,
      snapshot: snapshot(stages),
      requirements,
      nowIso: "2026-09-08T01:00:00.000Z",
    });
    expect(needsRuling(ledger)).toBe(false);
    expect(formatCoverage(ledger)).toBe("3/3");
  });
});
