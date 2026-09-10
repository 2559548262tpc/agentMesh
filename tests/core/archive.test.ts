import { describe, it, expect } from "vitest";
import { archiveSessionHistory } from "../../src/core/archive.js";
import type { BridgeSession, SessionHistoryEntry } from "../../src/core/types.js";

/**
 * v0.5 Batch 1 #6: Tier 1 rule-based cleanup. Deterministic placeholder
 * archiving of AgentMesh-side session payloads; summaries/findings survive
 * for contextSessionIds reuse, the bulky task echo and finalAnswer do not.
 */

let seq = 0;
function entry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  seq += 1;
  return {
    role: "worker",
    task: `task prompt number ${seq} — ${"detail ".repeat(80)}`,
    timestamp: `2026-09-08T00:00:0${seq % 10}.000Z`,
    status: "success",
    summary: `summary ${seq}`,
    finalAnswer: `${"answer ".repeat(200)}`,
    ...overrides,
  };
}

function session(history: SessionHistoryEntry[]): BridgeSession {
  return {
    id: "sess_archive",
    agent: "codex",
    cwd: "/tmp",
    role: "worker",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    history,
  };
}

describe("core/archive (v0.5 Tier 1 rule-based cleanup)", () => {
  it("replaces task echo and finalAnswer with the ledger placeholder, keeping summaries", () => {
    const archived = archiveSessionHistory(session([entry(), entry()]), {
      ledgerRef: "/home/out/ledger_wf.json",
    });
    expect(archived).toHaveLength(2);
    for (const turn of archived) {
      expect(turn.task).toContain("[archived → /home/out/ledger_wf.json]");
      expect(turn.finalAnswer).toBe("[archived → /home/out/ledger_wf.json]");
      expect(turn.summary).toMatch(/^summary \d$/);
    }
  });

  it("keeps the listed turn indexes fully intact (last stage's freshest context)", () => {
    const history = [entry(), entry(), entry()];
    const archived = archiveSessionHistory(session(history), {
      ledgerRef: "/home/out/ledger_wf.json",
      keepTurnIndexes: new Set([2]),
    });
    expect(archived[2]).toBe(history[2]);
    expect(archived[0]).not.toBe(history[0]);
    expect(archived[1]!.finalAnswer).toContain("[archived");
  });

  it("preserves structured findings and usage across archiving", () => {
    const withFindings = entry({
      findings: [{ severity: "high", file: "a.ts", issue: "x" }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const archived = archiveSessionHistory(session([withFindings]), {
      ledgerRef: "/home/out/ledger_wf.json",
    });
    expect(archived[0]!.findings).toEqual(withFindings.findings);
    expect(archived[0]!.usage).toEqual(withFindings.usage);
  });

  it("bounds the archived task echo instead of dropping the identification context", () => {
    const archived = archiveSessionHistory(session([entry()]), {
      ledgerRef: "/home/out/ledger_wf.json",
    });
    expect(archived[0]!.task.length).toBeLessThan(300);
    expect(archived[0]!.task.startsWith("task prompt number")).toBe(true);
  });
});
