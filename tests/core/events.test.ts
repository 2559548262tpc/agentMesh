import { describe, expect, it, vi } from "vitest";
import { createAgentMeshEventBus, type AgentMeshEvent } from "../../src/core/events.js";

describe("AgentMeshEventBus", () => {
  it("delivers emitted events to subscribers", () => {
    const bus = createAgentMeshEventBus();
    const received: AgentMeshEvent[] = [];
    bus.subscribe((event) => received.push(event));
    const event: AgentMeshEvent = {
      type: "task.started",
      taskId: "t1",
      outputFile: "/tmp/t1.output",
      startedAtMs: 1,
    };
    bus.emit(event);
    expect(received).toEqual([event]);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createAgentMeshEventBus();
    const listener = vi.fn();
    const off = bus.subscribe(listener);
    off();
    bus.emit({ type: "task.started", taskId: "t1", outputFile: "x", startedAtMs: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("waitForEvent resolves with the first matching event", async () => {
    const bus = createAgentMeshEventBus();
    const pending = bus.waitForEvent("t1", 1000);
    bus.emit({ type: "task.completed", taskId: "t1", status: "failed", exitCode: 2 });
    await expect(pending).resolves.toMatchObject({ type: "task.completed", taskId: "t1" });
  });

  it("waitForEvent resolves null on timeout", async () => {
    const bus = createAgentMeshEventBus();
    await expect(bus.waitForEvent("t-none", 20)).resolves.toBeNull();
  });

  it("waitForEvent ignores events of other tasks", async () => {
    const bus = createAgentMeshEventBus();
    const pending = bus.waitForEvent("t1", 30);
    bus.emit({ type: "task.completed", taskId: "other", status: "completed" });
    await expect(pending).resolves.toBeNull();
  });

  it("listener exceptions never break emit", () => {
    const bus = createAgentMeshEventBus();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    const after = vi.fn();
    bus.subscribe(after);
    bus.emit({ type: "task.started", taskId: "t1", outputFile: "x", startedAtMs: 1 });
    expect(after).toHaveBeenCalledTimes(1);
  });
});
