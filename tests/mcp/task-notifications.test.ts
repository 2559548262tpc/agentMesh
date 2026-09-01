import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { BackgroundDispatchService } from "../../src/mcp/tools.js";
import { createAgentMeshEventBus } from "../../src/core/events.js";
import { BackgroundTaskRegistry } from "../../src/core/background.js";

function makeService() {
  const homeDir = mkdtempSync(join(tmpdir(), "agentmesh-notif-"));
  const registry = new BackgroundTaskRegistry({
    homeDir,
    eventBus: createAgentMeshEventBus(),
  });
  return { service: new BackgroundDispatchService(registry), registry, homeDir };
}

describe("background task notifications", () => {
  it("sends notifications/message when a background task reaches terminal state", async () => {
    const { service, registry } = makeService();
    const server = createMcpServer({ backgroundService: service });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const received: LoggingMessageNotification["params"][] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      received.push(notification.params);
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const taskId = "bgtask_test_notif";
    const outputFile = registry.outputFilePath(taskId);
    registry.registerTask({
      taskId,
      pid: process.pid,
      startedAtMs: Date.now(),
      outputFile,
    });
    await registry.writeStoredResult({
      taskId,
      status: "completed",
      summary: "done",
      completedAtMs: Date.now(),
    });
    // Fire-and-forget notification: let microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    expect(received[0]!.level).toBe("info");
    expect(received[0]!.data).toContain(taskId);
    expect(received[0]!.data).toContain("completed");

    await Promise.allSettled([server.close(), client.close()]);
  });

  it("sends notifications/message when the watchdog flags a task as stalled", async () => {
    const { service, registry } = makeService();
    const server = createMcpServer({ backgroundService: service });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const received: LoggingMessageNotification["params"][] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      received.push(notification.params);
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const taskId = "bgtask_test_stall";
    registry.registerTask({
      taskId,
      pid: process.pid,
      startedAtMs: 0,
      outputFile: registry.outputFilePath(taskId),
    });
    // Direct emission mirrors the watchdog sweep's stall branch.
    registry.eventBus?.emit({ type: "task.stalled", taskId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toContain("stalled");

    await Promise.allSettled([server.close(), client.close()]);
  });
});
