import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import { createSimulationHarness, stringField, type SimulationHarness } from "./harness.js";

/**
 * S7 (semantic-fail) — exit 0 but the output clearly signals failure.
 *
 * Maps to the real rounds:
 * - P-R22-3 (建议): "终态检测应比对磁盘交付 vs 声称交付" — ling reported
 *   success while the declared delivery was incomplete.
 * - P-R21-6: status/verdict derivation must not invent success from a clean
 *   exit code alone.
 *
 * What is pinned as regression behavior — the CURRENT baseline, honestly:
 * with exitCode=0 and a failure narrative that carries no success marker, the
 * existing pipeline reports `completed` and passes the failure narrative
 * through as finalAnswer. AgentMesh today has no semantic validator for
 * missing markers, so this scenario documents the gap the r22 recommendation
 * targets. When declared-vs-delivered comparison lands, flip the
 * `completed` assertion here and update this header.
 */
describe("S7 semantic-fail: exit 0 with a failure narrative stays completed (documented gap)", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("keeps the failure narrative recoverable while the terminal state stays completed", async () => {
    harness = await createSimulationHarness({ label: "s7" });
    const taskId = await harness.dispatchBackground(
      ["Write simulated pages 1-5 in one batch.", "fake-vendor-sim: mode=semantic-fail"].join("\n"),
    );
    const childPid = await harness.waitForChildPid(taskId);

    const registry = harness.registry;
    await harness.waitFor(() => registry.hasStoredResult(taskId));
    const stored = await harness.registry.readStoredResult(taskId);

    expect(stored?.status).toBe("completed");
    expect(stored?.exitCode).toBe(0);
    expect(stored?.finalAnswer ?? "").toContain("TASK INCOMPLETE");

    const terminal = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(terminal.status).toBe("completed");
    expect(stringField(terminal.result, "finalAnswer") ?? "").toContain("TASK INCOMPLETE");

    expect(harness.background.activeCount).toBe(0);
    await harness.waitFor(() => !isPidAlive(childPid));
  });
});
