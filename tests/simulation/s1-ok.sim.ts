import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import {
  createSimulationHarness,
  numberField,
  stringField,
  type SimulationHarness,
} from "./harness.js";

/**
 * S1 (ok) — control case for the M1 fake-vendor simulation matrix
 * (ROADMAP_v0.4 M1). Not mapped to a specific r21/r22 defect: it proves the
 * harness itself dispatches through the REAL in-process MCP surface
 * (delegate_task background → real CodexAdapter → real executor tee) with the
 * fake vendor, and fixes the healthy baseline every fault scenario is diffed
 * against: incremental output at byte offsets, a terminal `completed` result,
 * and a reaped vendor process.
 */
describe("S1 ok: background dispatch completes with terminal result and incremental output", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("records incremental output, a terminal completed result, and no leftover process", async () => {
    harness = await createSimulationHarness({ label: "s1" });
    const taskId = await harness.dispatchBackground(
      [
        "Produce the simulated weekly report.",
        "fake-vendor-sim: mode=ok, delay-ms=200, interval-ms=150, heartbeats=20, out-chars=400",
      ].join("\n"),
    );
    const childPid = await harness.waitForChildPid(taskId);

    const outputFile = harness.outputFileOf(taskId);
    await harness.waitFor(() => fs.statSync(outputFile).size > 0);

    // Incremental read: a quick poll returns the bytes produced so far plus
    // the byte offset the next poll must resume from.
    const first = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(first.status).toBe("running");
    const firstOffset = numberField(first, "nextOffset") ?? 0;
    expect((first.outputSinceOffset ?? "").length).toBeGreaterThan(0);

    // The registration is persisted before any terminal state exists.
    expect(fs.readFileSync(harness.registry.registryFilePath, "utf-8")).toContain(taskId);

    // Long-poll (event-driven) until the terminal result arrives.
    const terminal = await harness.pollTask(taskId, {
      sinceOffset: firstOffset,
      maxWaitMs: 30_000,
    });
    expect(terminal.status).toBe("completed");
    expect(stringField(terminal.result, "finalAnswer")).toContain("DONE:");
    expect(numberField(terminal.result, "exitCode")).toBe(0);
    // Output continued past the first read: the suffix carries heartbeat lines.
    expect(terminal.outputSinceOffset ?? "").toContain("heartbeat");

    expect(harness.events.some((e) => e.type === "task.started" && e.taskId === taskId)).toBe(true);
    expect(
      harness.events.some(
        (e) => e.type === "task.completed" && e.taskId === taskId && e.status === "completed",
      ),
    ).toBe(true);

    // Windows process discipline: the vendor child is reaped after completion.
    await harness.waitFor(() => !isPidAlive(childPid));
  });
});
