import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import { createSimulationHarness, numberField, type SimulationHarness } from "./harness.js";

/**
 * S5 (truncate) — a long output that stops mid-stream is captured verbatim and
 * the task still terminates as `completed` (the current detection gap).
 *
 * Maps to the real rounds:
 * - P-R21-1: opencode reviewer (`--agent plan`) sessions died early with
 *   exitCode=0, a finalAnswer truncated mid-narrative ("Let me run npm
 *   test..."), and no verdict — AgentMesh persisted the truncated narrative.
 * - P-R22-3: ling-3.0-flash-fin-free truncated long batch-write tasks twice;
 *   faTail always ended in a "Now creating..." mid-sentence narrative while
 *   exitCode stayed 0 and the on-disk delivery stayed incomplete.
 *
 * What is pinned as regression behavior:
 * 1. every byte the vendor emitted before the cut lands in the capture file,
 *    including the partial final event with no closing brace or newline;
 * 2. poll_task offset reads reproduce the capture byte-for-byte with
 *    nextOffset/hasMore describing the true file end;
 * 3. with exitCode=0 the existing semantics report `completed` and carry the
 *    mid-narrative text as finalAnswer — the exact misleading-terminal-state
 *    signature r21/r22 had to catch manually. (A future milestone that
 *    compares declared vs delivered output must flip the `completed`
 *    assertion together with this header.)
 */
describe("S5 truncate: partial output captured verbatim; exit 0 keeps the misleading completed state", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("captures the mid-stream cut byte-exactly and surfaces the truncated narrative", async () => {
    harness = await createSimulationHarness({ label: "s5" });
    const taskId = await harness.dispatchBackground(
      [
        "Write simulated pages 1-5 in one batch.",
        "fake-vendor-sim: mode=truncate, out-chars=200000",
      ].join("\n"),
    );
    const childPid = await harness.waitForChildPid(taskId);

    const registry = harness.registry;
    await harness.waitFor(() => registry.hasStoredResult(taskId));

    // Verbatim mid-stream cut evidence in the capture file.
    const captured = fs.readFileSync(harness.outputFileOf(taskId), "utf-8");
    expect(captured.startsWith('{"type":"thread.started"')).toBe(true);
    expect(captured).toContain("Now creating page 3 of 5");
    expect(captured.length).toBeGreaterThan(200_000);
    const cutFragment = '{"type":"item.completed","item":{"type":"agent_m';
    expect(captured.endsWith(cutFragment)).toBe(true);
    expect(captured.endsWith("\n")).toBe(false);

    // Offset read semantics over the partial capture.
    const poll = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(poll.status).toBe("completed");
    expect(poll.outputSinceOffset).toBe(captured);
    expect(numberField(poll, "nextOffset")).toBe(Buffer.byteLength(captured, "utf8"));
    expect(poll.hasMore).toBe(false);

    // The r21/r22 signature: exit 0 → completed, finalAnswer mid-narrative.
    const stored = await harness.registry.readStoredResult(taskId);
    expect(stored?.status).toBe("completed");
    expect(stored?.exitCode).toBe(0);
    expect(stored?.finalAnswer ?? "").toContain("Now creating page 3 of 5");

    expect(harness.background.activeCount).toBe(0);
    await harness.waitFor(() => !isPidAlive(childPid));
  });
});
