import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyTier0ReturnTruncation,
  buildCompactWorkflowView,
  collectUnresolvedP0P1,
  readLedgerCoverage,
} from "../../src/core/compact.js";
import { defaultStorage } from "../../src/core/storage.js";
import type { WorkflowSnapshot, WorkflowStageRecord } from "../../src/core/workflow.js";

/**
 * v0.5 Batch 1 #5: compact envelope + Tier 0 return-time truncation
 * (P-080①②). The tail is kept inline because envelopes and poll views place
 * pointers and flag bits last.
 */

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
    workflowId: "wf_compact",
    name: "wf",
    status: "done",
    stages,
    startedAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

describe("core/compact (v0.5 leader-facing return layer)", () => {
  it("counts unresolved critical/high findings from non-PASS review records", () => {
    const stages = [
      stageRecord({
        name: "review",
        index: 0,
        review: {
          initialVerdict: "FAIL",
          findings: [
            { severity: "critical", file: "a.ts", issue: "x" },
            { severity: "low", file: "b.ts", issue: "y" },
          ],
          rounds: [
            {
              round: 1,
              fixStatus: "success",
              reviewOutcome: "FAIL",
              findings: [{ severity: "high", file: "a.ts", issue: "still x" }],
            },
          ],
          verdict: "FAIL",
        },
      }),
      stageRecord({
        name: "review-passed",
        index: 1,
        review: {
          initialVerdict: "PASS",
          findings: [{ severity: "critical", file: "c.ts", issue: "closed" }],
          rounds: [],
          verdict: "PASS",
        },
      }),
    ];
    expect(collectUnresolvedP0P1(snapshot(stages))).toBe(2);
  });

  it("builds the compact envelope with flag bits and no task payloads", () => {
    const view = buildCompactWorkflowView(
      snapshot([stageRecord({ name: "implement", index: 0 })]),
      { coverage: "2/3（1 PENDING_RULING）" },
    );
    expect(view.status).toBe("done");
    expect(view.stages).toEqual([{ name: "implement", status: "passed" }]);
    expect(view.flags).toEqual({
      unresolvedP0P1: 0,
      coverage: "2/3（1 PENDING_RULING）",
      anomalies: [],
    });
    expect(JSON.stringify(view)).not.toContain("tasks");
  });

  it("records anomalies for escalated, failed and needs_ruling terminals", () => {
    const escalated = buildCompactWorkflowView({
      ...snapshot([]),
      status: "escalated",
      evidence: {
        outcome: "escalated",
        stageName: "build",
        reason: "Acceptance command failed",
        at: "2026-09-08T00:00:00.000Z",
        rounds: [],
      },
    });
    expect(escalated.flags.anomalies[0]).toContain("escalated:build");

    const needsRulingView = buildCompactWorkflowView({
      ...snapshot([]),
      status: "needs_ruling",
      needsRulingIds: ["R3"],
    });
    expect(needsRulingView.flags.anomalies[0]).toContain("needs_ruling:1");
  });

  it("passes small return bodies through untouched (Tier 0)", () => {
    const result = applyTier0ReturnTruncation("small", "ref_small", { homeDir: os.tmpdir() });
    expect(result.text).toBe("small");
    expect(result.artifactPath).toBeUndefined();
  });

  it("persists oversized return bodies and keeps only the tail inline (Tier 0)", () => {
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-tier0-")));
    try {
      const body = `${"x".repeat(2_400)}\nTHE-END-MARKER`;
      const result = applyTier0ReturnTruncation(body, "ref_big", { homeDir });
      expect(result.artifactPath).toBe(path.join(homeDir, "out", "ref_big.txt"));
      expect(result.text.length).toBeLessThan(body.length);
      expect(result.text).toContain("[tier0: return body");
      expect(result.text).toContain("THE-END-MARKER");
      // Full body is preserved verbatim on disk.
      expect(defaultStorage.readTextFile(result.artifactPath!)).toBe(body);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reads the coverage flag from the terminal ledger without fabricating it", () => {
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-cov-")));
    try {
      const ledgerPath = path.join(homeDir, "ledger.json");
      defaultStorage.writeJsonAtomic(
        ledgerPath,
        {
          rows: [
            { id: "R1", status: "PASS" },
            { id: "R2", status: "PASS" },
            { id: "R3", status: "PENDING_RULING" },
          ],
        },
        { store: "workflows" },
      );
      expect(readLedgerCoverage(ledgerPath).coverage).toBe("2/3（1 PENDING_RULING）");
      expect(readLedgerCoverage(undefined)).toEqual({});
      expect(readLedgerCoverage(path.join(homeDir, "missing.json")).error).toContain(
        "not readable",
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
