import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import { createSimulationHarness, stringField, type SimulationHarness } from "./harness.js";

/**
 * S4 (apierror) — a structured vendor error surfaces as a failed outcome.
 *
 * Maps to the real rounds:
 * - P-R22-1: muse-spark-1.2-contributor-free failed two worker packages fast
 *   with `result.json status=failed, error=APIError`; the orchestrator had to
 *   re-dispatch both packages on another model.
 *
 * What is pinned as regression behavior:
 * 1. the vendor's structured error (stderr + JSONL error event) is tee'd into
 *    the task output capture and carried into the stored terminal record;
 * 2. poll_task reports `failed` with the vendor error text;
 * 3. the failure is not auto-retried into a hidden second attempt (the error
 *    wording deliberately avoids the resilience layer's transient-5xx family,
 *    mirroring a hard model-side unavailability);
 * 4. the failed dispatch spills a failure checkpoint (P5 T5.2) with the
 *    captured output tail, and the vendor process is reaped.
 */
describe("S4 apierror: structured vendor error surfaces through the full failure path", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("fails the task with the vendor error and spills a failure checkpoint", async () => {
    harness = await createSimulationHarness({ label: "s4" });
    const taskId = await harness.dispatchBackground(
      ["Call the simulated upstream model.", "fake-vendor-sim: mode=apierror"].join("\n"),
    );
    const childPid = await harness.waitForChildPid(taskId);

    const registry = harness.registry;
    await harness.waitFor(() => registry.hasStoredResult(taskId));
    const stored = await harness.registry.readStoredResult(taskId);
    expect(stored?.status).toBe("failed");
    expect(stored?.error ?? "").toContain("APIError 400");
    expect(stored?.exitCode).toBe(1);

    const terminal = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(terminal.status).toBe("failed");
    expect(stringField(terminal.result, "error") ?? "").toContain("APIError 400");

    // The structured vendor error is preserved verbatim in the capture.
    const captured = fs.readFileSync(harness.outputFileOf(taskId), "utf-8");
    expect(captured).toContain("APIError 400");

    // P5 T5.2: a failed dispatch spills the captured tail as a checkpoint.
    const checkpoints = listCheckpoints(harness.homeDir);
    const failureCheckpoint = checkpoints.find((c) => c.reason === "failed");
    expect(failureCheckpoint?.partialAnswer).toContain("APIError 400");

    expect(harness.background.activeCount).toBe(0);
    await harness.waitFor(() => !isPidAlive(childPid));
  });
});

function listCheckpoints(homeDir: string): Array<{ reason: string; partialAnswer: string }> {
  const root = path.join(homeDir, "checkpoints");
  const records: Array<{ reason: string; partialAnswer: string }> = [];
  if (!fs.existsSync(root)) return records;
  for (const bucket of fs.readdirSync(root)) {
    const bucketDir = path.join(root, bucket);
    if (!fs.statSync(bucketDir).isDirectory()) continue;
    for (const file of fs.readdirSync(bucketDir)) {
      if (!file.endsWith(".json")) continue;
      records.push(
        JSON.parse(fs.readFileSync(path.join(bucketDir, file), "utf-8")) as {
          reason: string;
          partialAnswer: string;
        },
      );
    }
  }
  return records;
}
