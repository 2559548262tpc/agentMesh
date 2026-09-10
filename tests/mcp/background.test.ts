import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startMcpServer } from "../../src/mcp/server.js";
import {
  BackgroundDispatchService,
  resolveMaxConcurrentBackgroundTasks,
} from "../../src/mcp/tools.js";
import { BackgroundTaskRegistry } from "../../src/core/background.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  TransportMode,
} from "../../src/agents/types.js";

/** Deferred the test controls; opening it lets the gated adapter finish. */
class ReleaseGate {
  readonly promise: Promise<void>;
  private resolveFn!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  public open(): void {
    this.resolveFn();
  }
}

class GatedAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Gated Test Adapter";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "TEST_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public gate: ReleaseGate = new ReleaseGate();
  /** Tasks as received by the vendor boundary (checkpoint-injection assertions). */
  public receivedTasks: string[] = [];

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    this.receivedTasks.push(options.task);
    const outputFile = options.taskActivity?.outputFile;
    if (outputFile) fs.appendFileSync(outputFile, "started\n", "utf-8");
    await Promise.race([
      this.gate.promise,
      new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    if (options.signal?.aborted) {
      return {
        status: "failed",
        agent: this.name,
        output: "cancelled",
        summary: "Cancelled by shutdown",
        error: "cancelled",
        errorCode: "CANCELLED",
        exitCode: 1,
        durationMs: 0,
      };
    }
    if (outputFile) fs.appendFileSync(outputFile, "finished\n", "utf-8");
    return this.formatSuccessResult("vendor log noise", Date.now(), {
      summary: "Background finished",
      finalAnswer: "The background answer",
      role: options.role,
    });
  }
}

describe("mcp background delegate and poll_task", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let server: McpServer;
  let adapter: GatedAdapter;
  let runner: MultiAgentRunner;
  let registry: BackgroundTaskRegistry;
  let background: BackgroundDispatchService;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_mcp_bg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    const appRegistry = new AgentRegistry();
    const sessionManager = new SessionManager({ persist: false });
    adapter = new GatedAdapter();
    appRegistry.register(adapter);
    runner = new MultiAgentRunner(appRegistry, sessionManager);
    registry = new BackgroundTaskRegistry({ homeDir });
    background = new BackgroundDispatchService(registry);

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // startMcpServer installs the transport.onclose → gracefulShutdown path
    // the shutdown test exercises (createMcpServer alone would not).
    server = await startMcpServer({
      runner,
      backgroundService: background,
      transport: serverTransport,
    });
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await clientTransport.close();
      await serverTransport.close();
      await server.close();
    } catch {
      // ignore
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const waitFor = async (condition: () => boolean, timeoutMs = 15_000): Promise<void> => {
    // 15s default: the full `npm run check` suite runs this file under
    // coverage + parallel workers, which can slow event delivery well past
    // the previous 5s and turn green tests into flaky timeouts.
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const outputFilePathOf = (taskId: string): string =>
    registry.getRegisteredTask(taskId)?.outputFile ??
    path.join(homeDir, "tasks", `${taskId}.output`);

  const startBackgroundTask = async (): Promise<string> => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "Long running job", role: "worker", background: true },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain("Status: RUNNING");
    expect(text).toContain("Output File:");
    expect(text).toContain("use poll_task to observe");
    const match = text.match(/Task ID: (\S+)/);
    expect(match).not.toBeNull();
    return match![1]!;
  };

  it("returns immediately from a background dispatch and exposes poll_task", async () => {
    const toolList = await client.listTools();
    expect(toolList.tools.map((t) => t.name)).toContain("poll_task");

    const startedAt = Date.now();
    const taskId = await startBackgroundTask();
    // The gate never resolves here, so a foreground call would hang forever.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(background.activeCount).toBe(1);
    // The adapter's first output chunk lands asynchronously after dispatch.
    // Since P-R14-3 the file is created eagerly (empty) at registration, so
    // existence alone no longer proves the run started — wait for content.
    await waitFor(() => fs.readFileSync(outputFilePathOf(taskId), "utf-8").includes("started"));
    expect(fs.readFileSync(outputFilePathOf(taskId), "utf-8")).toContain("started");
    const persisted = fs.readFileSync(registry.registryFilePath, "utf-8");
    expect(persisted).toContain(taskId);
  });

  it("polls running → completed with incremental output and a terminal result", async () => {
    const gate = new ReleaseGate();
    adapter.gate = gate;
    const taskId = await startBackgroundTask();
    await waitFor(
      () =>
        fs.existsSync(outputFilePathOf(taskId)) &&
        fs.readFileSync(outputFilePathOf(taskId), "utf-8").includes("started\n"),
    );

    const first = await client.callTool({
      name: "poll_task",
      arguments: { taskId },
    });
    const firstOutcome = JSON.parse(
      (first.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { status: string; outputTail: string };
    expect(firstOutcome.status).toBe("running");
    expect(firstOutcome.outputTail).toContain("started\n");

    // Second poll still running while the gate stays closed.
    const second = await client.callTool({ name: "poll_task", arguments: { taskId } });
    expect(
      JSON.parse((second.content as Array<{ type: string; text: string }>)[0]!.text),
    ).toMatchObject({ status: "running" });

    gate.open();

    let terminal: { status: string; result?: { summary?: string }; outputTail: string };
    for (let attempt = 0; attempt < 50; attempt++) {
      const poll = await client.callTool({ name: "poll_task", arguments: { taskId } });
      terminal = JSON.parse(
        (poll.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as typeof terminal;
      if (terminal.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(terminal!.status).toBe("completed");
    expect(terminal!.result?.summary).toBe("Background finished");
    expect(terminal!.outputTail).toContain("finished\n");
  });

  it("reports a structured NOT_FOUND for an unknown taskId", async () => {
    const res = await client.callTool({
      name: "poll_task",
      arguments: { taskId: "bgtask_does_not_exist" },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: string;
      taskId: string;
    };
    expect(payload.error).toBe("NOT_FOUND");
    expect(payload.taskId).toBe("bgtask_does_not_exist");
  });

  it("long-polls with maxWaitMs until the terminal result arrives in a single call", async () => {
    const gate = new ReleaseGate();
    adapter.gate = gate;
    const taskId = await startBackgroundTask();
    await waitFor(
      () =>
        fs.existsSync(outputFilePathOf(taskId)) &&
        fs.readFileSync(outputFilePathOf(taskId), "utf-8").includes("started\n"),
    );
    // Terminal state lands well inside the long-poll budget, but after a
    // short delay so the call must genuinely block on the event wake.
    setTimeout(() => gate.open(), 300);

    const startedAt = Date.now();
    // maxWaitMs must stay under the vitest 20s test budget: on a starved
    // machine one missed event wake recovers via the poller's own re-check at
    // the next pollOnce, and the call then returns by this deadline instead of
    // losing a race against the suite-level timeout.
    const res = await client.callTool({
      name: "poll_task",
      arguments: { taskId, maxWaitMs: 15_000 },
    });
    const outcome = JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text) as {
      status: string;
      result?: { summary?: string };
    };
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.summary).toBe("Background finished");
    // One blocking call covered the gate delay; repeated client polls would
    // each return early with "running".
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });

  it("aborts pending background tasks on graceful shutdown and records the outcome", async () => {
    adapter.gate = new ReleaseGate();
    const taskId = await startBackgroundTask();

    await clientTransport.close();
    await serverTransport.close();

    // Under the full suite (coverage + parallel workers) the abort can take
    // noticeably longer than the previous 5s budget.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (background.activeCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(background.activeCount).toBe(0);
    const stored = await registry.readStoredResult(taskId);
    expect(stored?.status).toBe("failed");
  });

  it("pauses a running task and resumes the SAME session via continue_task(fromCheckpoint)", async () => {
    adapter.gate = new ReleaseGate();
    const taskId = await startBackgroundTask();
    await waitFor(() => fs.readFileSync(outputFilePathOf(taskId), "utf-8").includes("started\n"));

    const pauseRes = await client.callTool({ name: "pause_task", arguments: { taskId } });
    expect(pauseRes.isError).toBeFalsy();
    const pauseOutcome = JSON.parse(
      (pauseRes.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as {
      taskId: string;
      status: string;
      cancelReason: string;
      checkpointId?: string;
      result?: { status: string; sessionId?: string };
    };
    expect(pauseOutcome.taskId).toBe(taskId);
    expect(pauseOutcome.status).toBe("cancelled");
    expect(pauseOutcome.cancelReason).toBe("paused");
    expect(pauseOutcome.result?.status).toBe("failed");
    expect(pauseOutcome.result?.sessionId).toBeTruthy();
    expect(pauseOutcome.checkpointId).toBeTruthy();

    const stored = await registry.readStoredResult(taskId);
    expect(stored?.status).toBe("failed");
    expect(stored?.sessionId).toBe(pauseOutcome.result?.sessionId);

    // Resume the paused work on the same Bridge session with the checkpoint baton.
    adapter.gate.open();
    const continueRes = await client.callTool({
      name: "continue_task",
      arguments: {
        sessionId: pauseOutcome.result!.sessionId!,
        task: "Resume and finish the paused work",
        fromCheckpoint: pauseOutcome.checkpointId,
      },
    });
    const continueText = (continueRes.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(continueRes.isError).toBeFalsy();
    expect(continueText).toContain("Status: SUCCESS");
    // The salvaged partial output was injected at the head of the continuation.
    expect(adapter.receivedTasks[1]).toContain("Recovered Checkpoint");
    expect(adapter.receivedTasks[1]).toContain("started");

    // One-shot baton: a second resume attempt with the same checkpoint fails closed.
    const replay = await client.callTool({
      name: "continue_task",
      arguments: {
        sessionId: pauseOutcome.result!.sessionId!,
        task: "Second resume attempt",
        fromCheckpoint: pauseOutcome.checkpointId,
      },
    });
    expect(replay.isError).toBe(true);
    expect((replay.content as Array<{ type: string; text: string }>)[0]!.text).toContain(
      "already consumed",
    );
  });

  it("keeps priority/deps inert on synchronous dispatches (zero regression)", async () => {
    adapter.gate.open();
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Quick sync job",
        priority: 9,
        deps: ["bgtask_ignored_on_sync"],
      },
    });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ type: string; text: string }>)[0]!.text).toContain(
      "Status: SUCCESS",
    );
  });
});

describe("mcp background M7b queue (cap, deps, priority)", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let server: McpServer;
  let adapter: GatedAdapter;
  let runner: MultiAgentRunner;
  let registry: BackgroundTaskRegistry;
  let background: BackgroundDispatchService;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_mcp_queue_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    // The bridge-level cap is an env property read at service construction.
    process.env.AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS = "1";
    const appRegistry = new AgentRegistry();
    const sessionManager = new SessionManager({ persist: false });
    adapter = new GatedAdapter();
    appRegistry.register(adapter);
    runner = new MultiAgentRunner(appRegistry, sessionManager);
    registry = new BackgroundTaskRegistry({ homeDir });
    background = new BackgroundDispatchService(registry);

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startMcpServer({
      runner,
      backgroundService: background,
      transport: serverTransport,
    });
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    delete process.env.AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS;
    try {
      await clientTransport.close();
      await serverTransport.close();
      await server.close();
    } catch {
      // ignore
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const waitFor = async (condition: () => boolean, timeoutMs = 15_000): Promise<void> => {
    // 15s default: the full `npm run check` suite runs this file under
    // coverage + parallel workers, which can slow event delivery well past
    // the previous 5s and turn green tests into flaky timeouts.
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const outputFilePathOf = (taskId: string): string =>
    registry.getRegisteredTask(taskId)?.outputFile ??
    path.join(homeDir, "tasks", `${taskId}.output`);

  const dispatchBackground = async (
    extraArgs: Record<string, unknown>,
  ): Promise<{ taskId: string; text: string }> => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Queued job",
        role: "worker",
        background: true,
        ...extraArgs,
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const match = text.match(/Task ID: (\S+)/);
    expect(match).not.toBeNull();
    return { taskId: match![1]!, text };
  };

  const pollJson = async (taskId: string): Promise<Record<string, unknown>> => {
    const res = await client.callTool({ name: "poll_task", arguments: { taskId } });
    return JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text) as Record<
      string,
      unknown
    >;
  };

  it("reports queued/blocked with queuePosition and blockedBy until the dependency completes", async () => {
    const dep = await dispatchBackground({});
    await waitFor(() =>
      fs.readFileSync(outputFilePathOf(dep.taskId), "utf-8").includes("started\n"),
    );

    const child = await dispatchBackground({ deps: [dep.taskId] });
    expect(child.text).toContain("Status: QUEUED (blocked by deps:");
    expect(child.text).toContain(dep.taskId);

    const blocked = await pollJson(child.taskId);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedBy).toEqual([dep.taskId]);
    expect(blocked.queuePosition).toBe(1);

    adapter.gate.open();
    // Two sequential runner dispatches (dep → child) under the Windows per-call
    // runner overhead documented in vitest.config.ts.
    await waitFor(
      () => registry.readStoredResultSync(child.taskId)?.status === "completed",
      10_000,
    );
    const finalOutcome = (await pollJson(child.taskId)) as {
      status: string;
      result?: { summary?: string };
    };
    expect(finalOutcome.status).toBe("completed");
    expect(finalOutcome.result?.summary).toBe("Background finished");
  });

  it("runs queued dispatches in priority order as slots free up", async () => {
    const first = await dispatchBackground({});
    const low = await dispatchBackground({ priority: 5 });
    const high = await dispatchBackground({ priority: 0 });

    expect(first.text).toContain("Status: RUNNING");
    expect(low.text).toContain("Status: QUEUED (waiting for a free concurrency slot)");
    expect(high.text).toContain("Status: QUEUED (waiting for a free concurrency slot)");

    const lowQueued = await pollJson(low.taskId);
    expect(lowQueued.status).toBe("queued");
    const highQueued = await pollJson(high.taskId);
    expect(highQueued.status).toBe("queued");
    // Priority 0 outranks priority 5 regardless of enqueue order.
    expect(highQueued.queuePosition).toBeLessThan(lowQueued.queuePosition as number);

    adapter.gate.open();
    // Three sequential runner dispatches (first → high → low), each paying the
    // Windows per-call runner overhead documented in vitest.config.ts, so the
    // chain needs a larger budget than the 5s waitFor default.
    await waitFor(
      () =>
        registry.readStoredResultSync(first.taskId)?.status === "completed" &&
        registry.readStoredResultSync(high.taskId)?.status === "completed" &&
        registry.readStoredResultSync(low.taskId)?.status === "completed",
      15_000,
    );
  });

  it("fails a dispatch immediately with DEP_FAILED when its dependency already failed", async () => {
    // The gated adapter only fails on abort; drive a failing dep through a
    // client-cancel of the background task instead.
    const dep = await dispatchBackground({});
    await waitFor(() =>
      fs.readFileSync(outputFilePathOf(dep.taskId), "utf-8").includes("started\n"),
    );
    const cancelRes = await client.callTool({
      name: "cancel_task",
      arguments: { taskId: dep.taskId, reason: "dep poisoned" },
    });
    const cancelOutcome = JSON.parse(
      (cancelRes.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { status: string };
    expect(cancelOutcome.status).toBe("cancelled");

    const child = await dispatchBackground({ deps: [dep.taskId] });
    expect(child.text).toContain("Status: FAILED (DEP_FAILED");
    expect(child.text).toContain(dep.taskId);
    const outcome = await pollJson(child.taskId);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome.result)).toContain("DEP_FAILED");
  });

  it("rejects unknown deps with a structured DEP_UNKNOWN error and no task record", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Orphan dependency",
        background: true,
        deps: ["bgtask_never_dispatched"],
      },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: string;
      taskId: string;
      invalidDeps: string[];
    };
    expect(payload.error).toBe("DEP_UNKNOWN");
    expect(payload.invalidDeps).toEqual(["bgtask_never_dispatched"]);
    // No orphan registration line was persisted for the rejected dispatch —
    // in this test NO dispatch was ever accepted, so the registry file itself
    // must not even exist.
    const registryPath = registry.registryFilePath;
    expect(
      !fs.existsSync(registryPath) ||
        !fs.readFileSync(registryPath, "utf-8").includes("bgtask_never_dispatched"),
    ).toBe(true);
  });

  it("resolves the bridge cap from AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS", () => {
    expect(
      resolveMaxConcurrentBackgroundTasks({ AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS: "3" }),
    ).toBe(3);
    expect(resolveMaxConcurrentBackgroundTasks({})).toBeUndefined();
    expect(
      resolveMaxConcurrentBackgroundTasks({ AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS: "  " }),
    ).toBeUndefined();
    expect(
      resolveMaxConcurrentBackgroundTasks({ AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS: "zero" }),
    ).toBeUndefined();
    expect(
      resolveMaxConcurrentBackgroundTasks({ AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS: "0" }),
    ).toBeUndefined();
  });
});
