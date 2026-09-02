import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startMcpServer } from "../../src/mcp/server.js";
import { BackgroundDispatchService } from "../../src/mcp/tools.js";
import { BackgroundTaskRegistry, isPidAlive } from "../../src/core/background.js";
import { CheckpointStore } from "../../src/core/checkpoint.js";
import { createAgentMeshEventBus } from "../../src/core/events.js";
import type { AgentMeshEvent } from "../../src/core/events.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { CodexAdapter } from "../../src/agents/codex.js";
import { getActivityHandle } from "../../src/core/executor.js";

/**
 * Shared wiring for the M1 fake-vendor simulation suite (ROADMAP_v0.4 M1).
 *
 * Every scenario dispatches through the REAL in-process MCP surface
 * (delegate_task / poll_task via InMemoryTransport — the same wiring the
 * existing mcp tests use) with the REAL CodexAdapter, whose binary is pointed
 * at scripts/fake-vendors/fake-vendor.mjs through the documented CODEX_BIN
 * override and a Windows .cmd shim unwrapped by the production executor
 * (the same shim pattern as tests/agents/adapters.integ.ts).
 *
 * Isolation contract: sessions are in-memory, the task registry, checkpoints
 * and dispatch cwd all live under per-harness temp directories, and dispose()
 * force-reaps any vendor child still alive before removing them. No real
 * vendor credentials, no network, no quota.
 */

/** Serialized poll_task response (boundary cast target; validated by JSON.parse). */
export type PollPayload = Record<string, unknown> & {
  status?: string;
  nextOffset?: number;
  hasMore?: boolean;
  outputSinceOffset?: string;
  result?: Record<string, unknown>;
};

export interface SimulationHarness {
  /** Temp AgentMesh home: task registry, outputs and checkpoints live here. */
  readonly homeDir: string;
  /** Temp dispatch cwd (no git repo, no .agentmesh config). */
  readonly workDir: string;
  readonly registry: BackgroundTaskRegistry;
  readonly background: BackgroundDispatchService;
  /** Every bus event emitted since harness creation (task.started/stalled/...). */
  readonly events: AgentMeshEvent[];
  readonly client: Client;
  /** Current value of the registry's injectable logical clock. */
  nowMs(): number;
  /** Moves the logical clock forward for watchdog sweeps (real timers untouched). */
  advanceClock(deltaMs: number): void;
  /** Resolves once the executor registered a vendor child pid for the task. */
  waitForChildPid(taskId: string, timeoutMs?: number): Promise<number>;
  /** Resolves once the predicate holds; throws on timeout. */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /**
   * Background dispatch through delegate_task; returns the parsed task id.
   * `timeoutMs` rides the real delegate_task schema when provided (S8 slow).
   */
  dispatchBackground(task: string, options?: { timeoutMs?: number }): Promise<string>;
  /** Absolute path of the task's tee'd output capture file. */
  outputFileOf(taskId: string): string;
  /** poll_task through the MCP client with a JSON payload boundary cast. */
  pollTask(
    taskId: string,
    options?: { sinceOffset?: number; maxWaitMs?: number },
  ): Promise<PollPayload>;
  /**
   * Closes both linked transports. The MCP-level cancellation path: the
   * transport close triggers the server's graceful shutdown, which aborts
   * every running background dispatch through its controller.
   */
  closeTransports(): Promise<void>;
  /** Kills the full process tree of a pid (Windows taskkill /T /F; POSIX SIGKILL). */
  killTree(pid: number): void;
  /** Stops in-flight work, reaps children, closes transports, removes temp dirs. */
  dispose(): Promise<void>;
}

const FAKE_VENDOR_SCRIPT = fileURLToPath(
  new URL("../../scripts/fake-vendors/fake-vendor.mjs", import.meta.url),
);

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Installs the fake vendor as the Codex binary: copies the real
 * scripts/fake-vendors/fake-vendor.mjs next to a shim that the production
 * executor can resolve. On Windows the shim must match the npm-generated
 * .cmd pattern the executor unwraps (see resolveCommandInvocation); on POSIX
 * a plain exec wrapper is used. Returns the shim path for the *_BIN override.
 */
async function installFakeVendorBin(binDir: string): Promise<string> {
  await fsp.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "fake-vendor.mjs");
  await fsp.copyFile(FAKE_VENDOR_SCRIPT, scriptPath);

  if (process.platform === "win32") {
    const shimPath = path.join(binDir, "fake-codex.cmd");
    await fsp.writeFile(shimPath, '@ECHO off\nnode "%~dp0\\fake-vendor.mjs" %*\n', "utf8");
    return shimPath;
  }
  const shimPath = path.join(binDir, "fake-codex");
  await fsp.writeFile(
    shimPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-vendor.mjs" "$@"\n`,
    "utf8",
  );
  await fsp.chmod(shimPath, 0o755);
  return shimPath;
}

function killTreePosix(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function killTreeWindows(pid: number): void {
  try {
    execFileSync("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // Already gone or taskkill unavailable; the POSIX fallback is meaningless here.
  }
}

export interface CreateSimulationHarnessOptions {
  /** Test label used in temp dir prefixes for post-mortem inspection. */
  readonly label?: string;
}

/**
 * Builds one isolated in-process simulation: temp home + cwd, an injectable
 * logical clock on the task registry, a temp-bound checkpoint store (the
 * default store would write into the real AgentMesh home), the real Codex
 * adapter bound to the fake vendor CLI, and the real MCP server/client pair.
 */
export async function createSimulationHarness(
  options: CreateSimulationHarnessOptions = {},
): Promise<SimulationHarness> {
  const prefix = options.label ? `agentmesh-sim-${options.label}-` : "agentmesh-sim-";
  const homeDir = makeTempDir(`${prefix}home-`);
  const workDir = makeTempDir(`${prefix}cwd-`);
  const binDir = makeTempDir(`${prefix}bin-`);
  const shimPath = await installFakeVendorBin(binDir);
  const originalCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = shimPath;

  // Injectable clock: the watchdog sweeps are driven manually against the
  // production thresholds (stall 10min / terminate +30min), exactly like the
  // P5 T5.3 unit test — no production default is touched.
  let clockMs = Date.now();
  const eventBus = createAgentMeshEventBus();
  const events: AgentMeshEvent[] = [];
  eventBus.subscribe((event) => {
    events.push(event);
  });

  const registry = new BackgroundTaskRegistry({ homeDir, eventBus, now: () => clockMs });
  const checkpointStore = new CheckpointStore({ homeDir });
  const background = new BackgroundDispatchService(registry, { checkpointStore });
  const appRegistry = new AgentRegistry();
  appRegistry.register(new CodexAdapter());
  const runner = new MultiAgentRunner(appRegistry, new SessionManager({ persist: false }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startMcpServer({
    runner,
    backgroundService: background,
    transport: serverTransport,
  });
  const client = new Client({ name: "simulation-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const trackedPids = new Set<number>();

  const closeTransportsSafe = async (): Promise<void> => {
    try {
      await clientTransport.close();
      await serverTransport.close();
      await server.close();
    } catch {
      // Closing an already-closed transport/server is expected in cancel scenarios.
    }
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("simulation waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const killTree = (pid: number): void => {
    if (process.platform === "win32") killTreeWindows(pid);
    else killTreePosix(pid);
  };

  return {
    homeDir,
    workDir,
    registry,
    background,
    events,
    client,
    nowMs: () => clockMs,
    advanceClock(deltaMs: number) {
      clockMs += deltaMs;
    },
    async waitForChildPid(taskId: string, timeoutMs = 15_000): Promise<number> {
      await waitFor(() => getActivityHandle(taskId)?.getChildPid() !== undefined, timeoutMs);
      const pid = getActivityHandle(taskId)?.getChildPid();
      if (pid === undefined) throw new Error(`no child pid registered for ${taskId}`);
      trackedPids.add(pid);
      return pid;
    },
    waitFor,
    async dispatchBackground(task: string, dispatchOptions = {}): Promise<string> {
      const res = await client.callTool({
        name: "delegate_task",
        arguments: {
          agent: "codex",
          task,
          cwd: workDir,
          role: "worker",
          mode: "cli",
          background: true,
          ...(dispatchOptions.timeoutMs !== undefined
            ? { timeoutMs: dispatchOptions.timeoutMs }
            : {}),
        },
      });
      if (res.isError) {
        throw new Error(`delegate_task failed: ${JSON.stringify(res.content)}`);
      }
      const content = res.content as Array<{ type: string; text: string }>;
      const match = (content[0]?.text ?? "").match(/Task ID: (\S+)/);
      const taskId = match?.[1];
      if (!taskId) {
        throw new Error(`delegate_task response carried no Task ID: ${content[0]?.text ?? ""}`);
      }
      return taskId;
    },
    outputFileOf: (taskId: string) => registry.outputFilePath(taskId),
    async pollTask(taskId, pollOptions = {}) {
      const res = await client.callTool({
        name: "poll_task",
        arguments: {
          taskId,
          ...(pollOptions.sinceOffset !== undefined
            ? { sinceOffset: pollOptions.sinceOffset }
            : {}),
          ...(pollOptions.maxWaitMs !== undefined ? { maxWaitMs: pollOptions.maxWaitMs } : {}),
        },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      // Boundary cast: poll_task serializes the documented PollTaskOutcome shape.
      return JSON.parse(content[0]?.text ?? "{}") as PollPayload;
    },
    async closeTransports(): Promise<void> {
      await closeTransportsSafe();
    },
    killTree,
    async dispose(): Promise<void> {
      // Stop any still-running dispatch so its child cannot outlive the test.
      if (background.activeCount > 0) {
        await background.abortAll("simulation harness teardown").catch(() => undefined);
      }
      await waitFor(() => background.activeCount === 0, 10_000).catch(() => undefined);
      for (const pid of trackedPids) {
        if (isPidAlive(pid)) killTree(pid);
      }
      trackedPids.clear();
      if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = originalCodexBin;
      await closeTransportsSafe();
      for (const dir of [homeDir, workDir, binDir]) {
        // Windows: a just-exited vendor child's cwd handle can lag the exit
        // event, failing the removal with EBUSY/ENOTEMPTY; retry briefly
        // instead of failing teardown.
        for (let attempt = 0; ; attempt += 1) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
            break;
          } catch (err) {
            if (attempt >= 10) throw err;
            await sleep(300);
          }
        }
      }
    },
  };
}

/** Narrowed field readers for serialized payloads (no casts at call sites). */
export function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
