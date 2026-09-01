import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskRegistry, STALLED_OUTPUT_THRESHOLD_MS } from "../../src/core/background.js";
import { createAgentMeshEventBus, type AgentMeshEvent } from "../../src/core/events.js";

function makeRegistry() {
  const homeDir = mkdtempSync(join(tmpdir(), "agentmesh-bgevt-"));
  const bus = createAgentMeshEventBus();
  const registry = new BackgroundTaskRegistry({ homeDir, eventBus: bus });
  return { registry, bus, homeDir };
}

describe("BackgroundTaskRegistry event emission", () => {
  it("emits task.started on registerTask", () => {
    const { registry, bus } = makeRegistry();
    const listener = vi.fn();
    bus.subscribe(listener);
    const outputFile = registry.outputFilePath("t1");
    registry.registerTask({ taskId: "t1", pid: process.pid, startedAtMs: 1, outputFile });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task.started", taskId: "t1" }),
    );
  });

  it("emits task.completed on writeStoredResult", async () => {
    const { registry, bus } = makeRegistry();
    const received: string[] = [];
    bus.subscribe((e) => received.push(`${e.type}:${e.taskId}`));
    await registry.writeStoredResult({
      taskId: "t2",
      status: "failed",
      exitCode: 1,
      completedAtMs: Date.now(),
    });
    expect(received).toContain("task.completed:t2");
  });

  it("emits task.stalled from the watchdog sweep exactly once", () => {
    const { registry, bus } = makeRegistry();
    const outputFile = registry.outputFilePath("t3");
    registry.registerTask({ taskId: "t3", pid: process.pid, startedAtMs: 0, outputFile });
    const stalledEvents: AgentMeshEvent[] = [];
    bus.subscribe((e) => {
      if (e.type === "task.stalled") stalledEvents.push(e);
    });
    // Silence longer than the threshold → stall branch (dedup set fires once).
    registry.checkStalledTasks(STALLED_OUTPUT_THRESHOLD_MS + 5_000);
    registry.checkStalledTasks(STALLED_OUTPUT_THRESHOLD_MS + 6_000);
    expect(stalledEvents).toHaveLength(1);
  });

  it("emits task.output when pollOnce reads new bytes", async () => {
    const { registry, bus } = makeRegistry();
    const outputFile = registry.outputFilePath("t4");
    registry.registerTask({
      taskId: "t4",
      pid: process.pid,
      startedAtMs: Date.now(),
      outputFile,
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputFile, "hello worker output", "utf-8");
    const listener = vi.fn();
    bus.subscribe(listener);
    await registry.pollOnce("t4", 0);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task.output", taskId: "t4" }),
    );
  });

  it("behaves identically without a bus (legacy path)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "agentmesh-bgnobus-"));
    const registry = new BackgroundTaskRegistry({ homeDir });
    const outputFile = registry.outputFilePath("t7");
    registry.registerTask({ taskId: "t7", pid: process.pid, startedAtMs: 1, outputFile });
    const outcome = await registry.pollOnce("t7", 0);
    expect(outcome.status).toBe("running");
  });
});
