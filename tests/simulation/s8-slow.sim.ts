import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import { createSimulationHarness, type SimulationHarness } from "./harness.js";

/**
 * S8 (slow) — a vendor that stays silent past the dispatch timeout is
 * stopped and recorded; no output, no orphan.
 *
 * Maps to the real rounds:
 * - P-R21-2 family (free-pool models without SLA; see also r19 P-R19-5):
 *   slow/absent vendor responses that must be stopped by a deadline instead
 *   of being waited out manually. Where S2 covers the 0-byte stall caught by
 *   the watchdog, S8 covers the explicit dispatch timeoutMs path.
 *
 * What is pinned as regression behavior:
 * 1. the executor's timeout terminates the process tree (exit convention
 *    124, `timedOut` evidence on the result);
 * 2. the stored terminal outcome is `failed` and summary carries the exit
 *    code convention;
 * 3. the capture stays empty (the vendor never emitted a byte) and the
 *    vendor pid is reaped.
 */
describe("S8 slow: dispatch timeout stops the silent vendor and records the failure", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("terminates the overdue vendor and stores a failed outcome with exit 124", async () => {
    harness = await createSimulationHarness({ label: "s8" });
    const taskId = await harness.dispatchBackground(
      ["Call the simulated slow model.", "fake-vendor-sim: mode=slow, delay-ms=15000"].join("\n"),
      { timeoutMs: 3_000 },
    );
    const childPid = await harness.waitForChildPid(taskId);

    const registry = harness.registry;
    await harness.waitFor(() => registry.hasStoredResult(taskId));
    const stored = await harness.registry.readStoredResult(taskId);

    expect(stored?.status).toBe("failed");
    expect(stored?.exitCode).toBe(124);
    expect(stored?.summary ?? "").toContain("exited with code 124");

    // Nothing was ever emitted: the capture is still 0 bytes.
    expect(fs.statSync(harness.outputFileOf(taskId)).size).toBe(0);

    expect(harness.background.activeCount).toBe(0);
    await harness.waitFor(() => !isPidAlive(childPid));
  });
});
