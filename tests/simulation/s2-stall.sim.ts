import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import { createSimulationHarness, type SimulationHarness } from "./harness.js";

/**
 * S2 (stall) — 0-byte stall detection, notification, and automatic stop-loss.
 *
 * Maps to the real rounds:
 * - P-R21-2: nemotron-3-ultra-free reviewer frozen with a 0-byte output file
 *   for >5 minutes while the process stayed alive; the orchestrator could only
 *   abandon it (no cancel primitive existed yet).
 * - P-R22-2: review_changes+opencode three parallel dispatches stalled at
 *   0 bytes for >=4 minutes.
 *
 * What is pinned as regression behavior:
 * 1. the capture file stays 0 bytes while the vendor child is alive;
 * 2. poll_task reports `running` before the threshold and `stalled` after it;
 * 3. a `task.stalled` event is emitted on the bus (the panel/notifier signal);
 * 4. one terminate threshold later the PRODUCTION watchdog second stage
 *    (BackgroundDispatchService.onStalledTerminate) aborts the dispatch, the
 *    stored outcome is `failed`, and the vendor child process is reaped
 *    (Windows taskkill /T /F semantics — no orphan).
 *
 * Thresholds are NOT overridden: the sweep is driven manually through the
 * registry's injectable logical clock (stalled at +11min of silence,
 * terminated at +31min past the notification), the same technique as the
 * P5 T5.3 unit test, so production defaults (10min/30min) remain untouched.
 */
describe("S2 stall: 0-byte stall detected, notified, and auto-terminated with tree cleanup", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("surfaces the stall and reaps the frozen vendor process", async () => {
    harness = await createSimulationHarness({ label: "s2" });
    const taskId = await harness.dispatchBackground(
      ["Review the simulated module in plan mode.", "fake-vendor-sim: mode=stall"].join("\n"),
    );
    const childPid = await harness.waitForChildPid(taskId);

    // 0-byte stall evidence (P-R21-2): the vendor is alive but silent.
    const outputFile = harness.outputFileOf(taskId);
    expect(fs.statSync(outputFile).size).toBe(0);
    const running = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(running.status).toBe("running");

    // First watchdog stage: +11 minutes of logical silence crosses the 10min
    // STALLED_OUTPUT_THRESHOLD_MS and flags the task exactly once.
    harness.advanceClock(11 * 60_000);
    const newlyStalled = harness.registry.checkStalledTasks(harness.nowMs());
    expect(newlyStalled).toContain(taskId);
    expect(harness.registry.isStallNotified(taskId)).toBe(true);
    expect(harness.events.some((e) => e.type === "task.stalled" && e.taskId === taskId)).toBe(true);
    const stalled = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(stalled.status).toBe("stalled");

    // Second watchdog stage (P5 T5.3): +31 minutes past the notification
    // crosses STALLED_TERMINATE_THRESHOLD_MS; the production onStalledTerminate
    // aborts the dispatch through its controller.
    harness.advanceClock(31 * 60_000);
    harness.registry.checkStalledTasks(harness.nowMs());

    const registry = harness.registry;
    await harness.waitFor(() => registry.hasStoredResult(taskId));
    const stored = await harness.registry.readStoredResult(taskId);
    expect(stored?.status).toBe("failed");
    expect(stored?.error ?? "").toContain("cancelled");
    expect(harness.background.activeCount).toBe(0);

    // Stop-loss evidence: the frozen vendor process tree is actually gone.
    await harness.waitFor(() => !isPidAlive(childPid));

    // poll_task resolves the stalled limbo into the terminal failed state.
    const terminal = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(terminal.status).toBe("failed");
  });
});
