import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import { createSimulationHarness, sleep, type SimulationHarness } from "./harness.js";

/**
 * S3 (cancel) — cancelling a running background task records the abort and
 * stops output growth with no orphan process.
 *
 * Maps to the real rounds:
 * - P-R21-2: "增加 cancel_task(taskId)：杀进程树 + 落盘 cancelled 终态" — the
 *   dedicated cancel MCP tool recommended in r21 does not exist yet, so this
 *   scenario exercises the cancellation primitive that DOES exist today: a
 *   client disconnect closes the transport, the server's graceful-shutdown
 *   path aborts every running dispatch through its AbortController, the
 *   executor terminates the full process tree (taskkill /T /F), and the
 *   cancelled outcome is persisted to the task registry.
 *
 * Pinned regression behavior:
 * 1. output was flowing before the cancel (heartbeat stream);
 * 2. after the cancel the stored outcome is `failed` with cancellation
 *    evidence and the background service reports no active dispatch;
 * 3. the output capture never grows again (the vendor child was terminated,
 *    not merely abandoned);
 * 4. the vendor pid is reaped on Windows.
 */
describe("S3 cancel: client disconnect aborts the running task and freezes output", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("records the cancellation, stops output growth, and reaps the process tree", async () => {
    harness = await createSimulationHarness({ label: "s3" });
    const taskId = await harness.dispatchBackground(
      [
        "Stream the simulated implementation log.",
        "fake-vendor-sim: mode=ok, delay-ms=300, interval-ms=150, heartbeats=100000, out-chars=200",
      ].join("\n"),
    );
    const childPid = await harness.waitForChildPid(taskId);

    const outputFile = harness.outputFileOf(taskId);
    await harness.waitFor(() => fs.statSync(outputFile).size > 0);

    // The MCP-level cancellation path available today (see header): transport
    // close → graceful shutdown → abortAll → controller abort → tree kill.
    await harness.closeTransports();

    const background = harness.background;
    await harness.waitFor(() => background.activeCount === 0);
    const stored = await harness.registry.readStoredResult(taskId);
    expect(stored?.status).toBe("failed");
    expect(stored?.summary ?? "").toContain("cancelled");

    // The capture is frozen at whatever the vendor produced before the kill:
    // no further bytes may arrive after the terminal state is recorded.
    const sizeAtCancel = fs.statSync(outputFile).size;
    expect(sizeAtCancel).toBeGreaterThan(0);
    await sleep(600);
    expect(fs.statSync(outputFile).size).toBe(sizeAtCancel);

    // Windows process-tree discipline: no orphan vendor child remains.
    await harness.waitFor(() => !isPidAlive(childPid));
  });
});
