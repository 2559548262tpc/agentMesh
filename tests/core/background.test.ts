import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackgroundTaskNotFoundError,
  BackgroundTaskRegistry,
  isPidAlive,
  readTaskQueuedDurationMs,
} from "../../src/core/background.js";
import { BackgroundDispatchService, DepValidationError } from "../../src/mcp/tools.js";
import {
  executeCommand,
  forgetActivityHandle,
  getActivityHandle,
} from "../../src/core/executor.js";
import type { AgentResult } from "../../src/agents/types.js";

describe("core/background registry", () => {
  let homeDir: string;
  let nowMs: number;
  const alivePids = new Set<number>();

  const makeRegistry = () =>
    new BackgroundTaskRegistry({
      homeDir,
      now: () => nowMs,
      isPidAlive: (pid) => alivePids.has(pid),
    });

  const register = (
    registry: BackgroundTaskRegistry,
    taskId: string,
    overrides: Partial<{ pid: number; outputFile: string }> = {},
  ) => {
    const record = {
      taskId,
      pid: overrides.pid ?? process.pid,
      startedAtMs: nowMs,
      outputFile: overrides.outputFile ?? path.join(registry.tasksDirectory, `${taskId}.output`),
    };
    fs.mkdirSync(path.dirname(record.outputFile), { recursive: true });
    if (!fs.existsSync(record.outputFile)) {
      fs.writeFileSync(record.outputFile, "", "utf-8");
    }
    registry.registerTask(record);
    return record;
  };

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_bg_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    nowMs = 1_000_000;
    alivePids.clear();
    alivePids.add(process.pid);
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("persists registrations as JSONL under <home>/tasks/registry.jsonl", () => {
    const registry = makeRegistry();
    register(registry, "bg_a1");

    const raw = fs.readFileSync(registry.registryFilePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ taskId: "bg_a1", pid: process.pid });
  });

  it("resolves tasks across registry instances (restart recovery)", () => {
    const first = makeRegistry();
    register(first, "bg_restart");

    const second = makeRegistry();
    expect(second.getRegisteredTask("bg_restart")?.outputFile).toContain("bg_restart.output");
  });

  it("reaps only entries whose owning pid died and returns the cleanup list", async () => {
    const registry = makeRegistry();
    register(registry, "bg_live", { pid: process.pid });
    register(registry, "bg_dead", { pid: 999_999 });

    const reaped = await registry.scanAndReapOrphans();

    expect(reaped.map((entry) => entry.taskId)).toEqual(["bg_dead"]);
    // P-R14-3: reaped records are dead-lettered (orphanedAtMs set), not
    // dropped, so poll_task can still report "interrupted" for them.
    const remaining = fs
      .readFileSync(registry.registryFilePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { taskId: string; orphanedAtMs?: number });
    expect(remaining.map((parsed) => parsed.taskId).sort()).toEqual(["bg_dead", "bg_live"]);
    const dead = remaining.find((parsed) => parsed.taskId === "bg_dead");
    expect(dead?.orphanedAtMs).toBeTypeOf("number");
    const live = remaining.find((parsed) => parsed.taskId === "bg_live");
    expect(live?.orphanedAtMs).toBeUndefined();
  });

  it("reads output incrementally at a byte offset", async () => {
    const registry = makeRegistry();
    const record = register(registry, "bg_inc");
    await fsp.appendFile(record.outputFile, "hello\n", "utf-8");

    const first = await registry.pollOnce("bg_inc", 0);
    expect(first).toMatchObject({
      status: "running",
      outputSinceOffset: "hello\n",
      nextOffset: 6,
      hasMore: false,
    });

    await fsp.appendFile(record.outputFile, "world", "utf-8");
    const second = await registry.pollOnce("bg_inc", first.nextOffset);
    expect(second.outputSinceOffset).toBe("world");
    expect(second.nextOffset).toBe(11);
  });

  it("returns an empty delta with hasMore:false when the offset exceeds the file", async () => {
    const registry = makeRegistry();
    const record = register(registry, "bg_short");
    await fsp.appendFile(record.outputFile, "abc", "utf-8");

    const outcome = await registry.pollTask({ taskId: "bg_short", sinceOffset: 9999 });

    expect(outcome.outputSinceOffset).toBe("");
    expect(outcome.hasMore).toBe(false);
    expect(outcome.nextOffset).toBe(9999);
  });

  it("reports running before completion and completed after the result record", async () => {
    const registry = makeRegistry();
    register(registry, "bg_term");

    const running = await registry.pollOnce("bg_term", 0);
    expect(running.status).toBe("running");
    expect(running.result).toBeUndefined();

    await registry.writeStoredResult({
      taskId: "bg_term",
      status: "completed",
      summary: "done",
      completedAtMs: nowMs,
    });

    const done = await registry.pollOnce("bg_term", 0);
    expect(done.status).toBe("completed");
    expect(done.result?.summary).toBe("done");
  });

  it("infers failed when a registered task's owning process died without a result", async () => {
    const registry = makeRegistry();
    const deadPid = 123_456;
    register(registry, "bg_crash", { pid: deadPid });

    // Not tracked in this instance's active map: restart-style lookup only.
    const otherView = makeRegistry();
    const outcome = await otherView.pollOnce("bg_crash", 0);
    expect(outcome.status).toBe("failed");
    expect(alivePids.has(deadPid)).toBe(false);
  });

  it("flags stalled exactly once per task at the threshold boundary (injectable clock)", () => {
    const registry = makeRegistry();
    const notified: string[] = [];
    const lastOutputAtByTask = new Map<string, number>();
    registry.enableStalledWatchdog({
      getActivityHandle: (taskId) => ({
        getLastOutputAtMs: () => lastOutputAtByTask.get(taskId),
      }),
      thresholdMs: 600_000,
      onStalled: (taskId) => notified.push(taskId),
    });
    lastOutputAtByTask.set("bg_stall", nowMs);
    register(registry, "bg_stall");

    // 1ms short of the threshold: no stall yet.
    expect(registry.checkStalledTasks(nowMs + 599_999)).toEqual([]);
    expect(registry.isStallNotified("bg_stall")).toBe(false);

    expect(registry.checkStalledTasks(nowMs + 600_000)).toEqual(["bg_stall"]);
    expect(notified).toEqual(["bg_stall"]);
    // Deduped: the same task never notifies twice.
    expect(registry.checkStalledTasks(nowMs + 1_200_000)).toEqual([]);
    expect(notified).toEqual(["bg_stall"]);

    const polled = registry.getRegisteredTask("bg_stall");
    expect(polled).toBeDefined();
  });

  it("surfaces the stall flag through poll_task status", async () => {
    const registry = makeRegistry();
    const lastOutputAtByTask = new Map<string, number>();
    registry.enableStalledWatchdog({
      getActivityHandle: (taskId) => ({
        getLastOutputAtMs: () => lastOutputAtByTask.get(taskId),
      }),
      thresholdMs: 100,
    });
    lastOutputAtByTask.set("bg_pollstall", nowMs);
    register(registry, "bg_pollstall");

    registry.checkStalledTasks(nowMs + 100);
    const outcome = await registry.pollOnce("bg_pollstall", 0);
    expect(outcome.status).toBe("stalled");
  });

  it("runs the watchdog timer only while active tasks exist", () => {
    const registry = makeRegistry();
    registry.enableStalledWatchdog({});
    expect(registry.isWatchdogRunning).toBe(false);

    register(registry, "bg_timer");
    expect(registry.isWatchdogRunning).toBe(true);

    // A tick with no active tasks stops the timer.
    registry.releaseTask("bg_timer");
    registry.checkStalledTasks(nowMs);
    expect(registry.isWatchdogRunning).toBe(false);
  });

  it("throws a structured NOT_FOUND error for an unknown taskId", async () => {
    const registry = makeRegistry();
    await expect(registry.pollOnce("bg_missing", 0)).rejects.toBeInstanceOf(
      BackgroundTaskNotFoundError,
    );
  });

  it("keeps scanning when the registry file contains corrupt lines", async () => {
    const registry = makeRegistry();
    register(registry, "bg_ok");
    fs.appendFileSync(registry.registryFilePath, "{broken json\n", "utf-8");

    expect(registry.getRegisteredTask("bg_ok")).toBeDefined();
    const reaped = await registry.scanAndReapOrphans();
    expect(reaped).toHaveLength(0);
  });

  it("uses the cross-platform liveness probe idiom", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // Pids near the theoretical maximum are safe to treat as absent.
    expect(isPidAlive(4_000_000_000)).toBe(false);
  });
});

describe("core/executor task activity tee", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_tee_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("tees stdout/stderr to the task output file and tracks activity", async () => {
    const taskId = "bg_tee_1";
    const outputFile = path.join(homeDir, "tasks", `${taskId}.output`);
    const script = [
      "process.stdout.write('OUT-1\\n');",
      "setTimeout(() => { process.stderr.write('ERR-1\\n'); }, 80);",
      "setTimeout(() => { process.stdout.write('OUT-2\\n'); }, 160);",
    ].join("");

    try {
      await executeCommand(process.execPath, ["-e", script], {
        taskActivity: { taskId, outputFile },
      });

      const teeContent = await fsp.readFile(outputFile, "utf-8");
      expect(teeContent).toContain("OUT-1\n");
      expect(teeContent).toContain("ERR-1\n");
      expect(teeContent).toContain("OUT-2\n");

      const handle = getActivityHandle(taskId);
      expect(handle).toBeDefined();
      expect(handle?.getLastOutputAtMs()).toBeGreaterThan(0);
      expect(handle?.getChildPid()).toBeGreaterThan(0);
    } finally {
      forgetActivityHandle(taskId);
    }
    expect(getActivityHandle(taskId)).toBeUndefined();
  });

  it("keeps no activity record when the spawn itself fails", async () => {
    const taskId = "bg_tee_missing";
    await expect(
      executeCommand("definitely-missing-executable-agentmesh", [], {}),
    ).rejects.toBeInstanceOf(Error);
    expect(getActivityHandle(taskId)).toBeUndefined();
  });
});

describe("core/background orphan dead-lettering (P-R14-3)", () => {
  let homeDir: string;
  let nowMs: number;
  const alivePids = new Set<number>();

  const makeRegistry = () =>
    new BackgroundTaskRegistry({
      homeDir,
      now: () => nowMs,
      isPidAlive: (pid) => alivePids.has(pid),
    });

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-orphan-"));
    nowMs = 1_000_000;
    alivePids.clear();
    alivePids.add(process.pid);
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates the declared output file eagerly at registration", () => {
    const registry = makeRegistry();
    const outputFile = path.join(registry.tasksDirectory, "bgtask_eager.output");
    registry.registerTask({
      taskId: "bgtask_eager",
      pid: process.pid,
      startedAtMs: nowMs,
      outputFile,
    });
    expect(fs.existsSync(outputFile)).toBe(true);
  });

  it("dead-letters orphans on startup scan so poll_task can report interrupted", async () => {
    const registry = makeRegistry();
    const outputFile = path.join(registry.tasksDirectory, "bgtask_killed.output");
    registry.registerTask({
      taskId: "bgtask_killed",
      pid: process.pid,
      startedAtMs: nowMs,
      outputFile,
    });

    // Simulate a restart: fresh registry instance, owning pid no longer alive.
    nowMs += 5_000;
    const restarted = makeRegistry();
    alivePids.delete(process.pid);
    const reaped = await restarted.scanAndReapOrphans();
    expect(reaped.map((r) => r.taskId)).toContain("bgtask_killed");

    // The record must be dead-lettered, not silently dropped.
    const interrupted = restarted.getInterruptedTask("bgtask_killed");
    expect(interrupted).toBeDefined();
    expect(interrupted?.orphanedAtMs).toBe(nowMs);
    expect(interrupted?.outputFile).toBe(outputFile);

    // A live task registered by the new process is never touched by scans.
    restarted.registerTask({
      taskId: "bgtask_live",
      pid: process.pid,
      startedAtMs: nowMs,
      outputFile: path.join(restarted.tasksDirectory, "bgtask_live.output"),
    });
    alivePids.add(process.pid);
    const secondScan = await restarted.scanAndReapOrphans();
    expect(secondScan.map((r) => r.taskId)).not.toContain("bgtask_live");
    expect(restarted.getInterruptedTask("bgtask_live")).toBeUndefined();
  });
});

describe("core/background M7b queue state", () => {
  let homeDir: string;
  let nowMs: number;
  const alivePids = new Set<number>();

  const makeRegistry = () =>
    new BackgroundTaskRegistry({
      homeDir,
      now: () => nowMs,
      isPidAlive: (pid) => alivePids.has(pid),
    });

  const register = (registry: BackgroundTaskRegistry, taskId: string) => {
    const outputFile = path.join(registry.tasksDirectory, `${taskId}.output`);
    registry.registerTask({
      taskId,
      pid: process.pid,
      startedAtMs: nowMs,
      outputFile,
    });
  };

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-queue-"));
    nowMs = 1_000_000;
    alivePids.clear();
    alivePids.add(process.pid);
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("orders queued dispatches by priority then enqueue time (poll_task queuePosition)", async () => {
    const registry = makeRegistry();
    register(registry, "bg_low");
    register(registry, "bg_high");
    register(registry, "bg_mid");
    nowMs += 10;
    registry.markTaskQueued("bg_low", { priority: 5, enqueuedAtMs: nowMs });
    nowMs += 10;
    registry.markTaskQueued("bg_high", { priority: 0, enqueuedAtMs: nowMs });
    nowMs += 10;
    registry.markTaskQueued("bg_mid", { priority: 2, enqueuedAtMs: nowMs });

    const low = await registry.pollOnce("bg_low", 0);
    expect(low.status).toBe("queued");
    expect(low.queuePosition).toBe(3);
    const high = await registry.pollOnce("bg_high", 0);
    expect(high.status).toBe("queued");
    expect(high.queuePosition).toBe(1);
    const mid = await registry.pollOnce("bg_mid", 0);
    expect(mid.status).toBe("queued");
    expect(mid.queuePosition).toBe(2);
  });

  it("re-derives the queue from registry.jsonl after a restart", async () => {
    const first = makeRegistry();
    register(first, "bg_persist");
    first.markTaskQueued("bg_persist", { priority: 4, deps: ["bg_dep"], enqueuedAtMs: nowMs });

    const restarted = makeRegistry();
    const outcome = await restarted.pollOnce("bg_persist", 0);
    expect(outcome.status).toBe("blocked");
    expect(outcome.queuePosition).toBe(1);
    expect(outcome.blockedBy).toEqual(["bg_dep"]);
  });

  it("reports blocked while deps are unmet and queued once they complete", async () => {
    const registry = makeRegistry();
    register(registry, "bg_wait");
    register(registry, "bg_dep");
    registry.markTaskQueued("bg_wait", { priority: 0, deps: ["bg_dep"], enqueuedAtMs: nowMs });

    const blocked = await registry.pollOnce("bg_wait", 0);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedBy).toEqual(["bg_dep"]);

    await registry.writeStoredResult({
      taskId: "bg_dep",
      status: "completed",
      completedAtMs: nowMs,
    });
    const runnable = await registry.pollOnce("bg_wait", 0);
    expect(runnable.status).toBe("queued");
    expect(runnable.blockedBy).toBeUndefined();

    // queued → started: the marker clears and the dispatch latency is readable.
    nowMs += 7_500;
    registry.markTaskStarted("bg_wait");
    const running = await registry.pollOnce("bg_wait", 0);
    expect(running.status).toBe("running");
    expect(readTaskQueuedDurationMs("bg_wait", { homeDir })).toBe(7_500);
  });

  it("never flags queued dispatches as stalled (no vendor process exists yet)", () => {
    const registry = makeRegistry();
    const notified: string[] = [];
    registry.enableStalledWatchdog({
      thresholdMs: 100,
      onStalled: (taskId) => notified.push(taskId),
    });
    register(registry, "bg_queued_quiet");
    registry.markTaskQueued("bg_queued_quiet", { priority: 0, enqueuedAtMs: nowMs });

    expect(registry.checkStalledTasks(nowMs + 1_000_000)).toEqual([]);
    expect(notified).toEqual([]);
  });
});

describe("core/background M7b dispatch service (queue, cap, deps)", () => {
  let homeDir: string;
  let registry: BackgroundTaskRegistry;
  let service: BackgroundDispatchService;

  const OK_RESULT: AgentResult = {
    status: "success",
    agent: "codex",
    summary: "ok",
    output: "out",
    exitCode: 0,
    durationMs: 1,
  };

  /** Run callback that finishes only when its gate opens or the signal aborts. */
  const gatedRun =
    (gate: Promise<void>) =>
    async (signal: AbortSignal): Promise<AgentResult> => {
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (signal.aborted) {
        return {
          ...OK_RESULT,
          status: "failed",
          summary: "cancelled",
          error: "cancelled",
          exitCode: 1,
        };
      }
      return OK_RESULT;
    };

  const registerForLaunch = (taskId: string): string => {
    const outputFile = path.join(registry.tasksDirectory, `${taskId}.output`);
    registry.registerTask({
      taskId,
      pid: process.pid,
      startedAtMs: Date.now(),
      outputFile,
    });
    return outputFile;
  };

  const waitFor = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-svc-"));
    registry = new BackgroundTaskRegistry({ homeDir });
    service = new BackgroundDispatchService(registry);
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("rejects self and unknown deps with structured errors and no registry leak", () => {
    registerForLaunch("bg_self_dep");
    const before = fs.readFileSync(registry.registryFilePath, "utf-8");

    expect(() =>
      service.launch({
        taskId: "bg_self_dep",
        outputFile: "x",
        run: async () => OK_RESULT,
        deps: ["bg_self_dep"],
      }),
    ).toThrowError(DepValidationError);
    try {
      service.launch({
        taskId: "bg_self_dep",
        outputFile: "x",
        run: async () => OK_RESULT,
        deps: ["bg_self_dep"],
      });
    } catch (err) {
      const depError = err as DepValidationError;
      expect(depError.code).toBe("DEP_SELF");
      expect(depError.invalidDeps).toEqual(["bg_self_dep"]);
    }

    expect(() =>
      service.launch({
        taskId: "bg_self_dep",
        outputFile: "x",
        run: async () => OK_RESULT,
        deps: ["bg_never_seen"],
      }),
    ).toThrowError(DepValidationError);
    try {
      service.launch({
        taskId: "bg_self_dep",
        outputFile: "x",
        run: async () => OK_RESULT,
        deps: ["bg_never_seen"],
      });
    } catch (err) {
      const depError = err as DepValidationError;
      expect(depError.code).toBe("DEP_UNKNOWN");
      expect(depError.invalidDeps).toEqual(["bg_never_seen"]);
    }

    // Rejected launches must not leave a registry record behind.
    expect(fs.readFileSync(registry.registryFilePath, "utf-8")).toBe(before);
  });

  it("fails a dispatch immediately with DEP_FAILED when a dependency already failed", async () => {
    registerForLaunch("bg_dep_failed");
    await registry.writeStoredResult({
      taskId: "bg_dep_failed",
      status: "failed",
      error: "vendor exploded",
      completedAtMs: Date.now(),
    });
    const outputFile = registerForLaunch("bg_dependent");

    const outcome = service.launch({
      taskId: "bg_dependent",
      outputFile,
      run: async () => OK_RESULT,
      deps: ["bg_dep_failed"],
    });

    expect(outcome.started).toBe(false);
    expect(outcome.depFailed).toEqual(["bg_dep_failed"]);
    const stored = registry.readStoredResultSync("bg_dependent");
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("DEP_FAILED");
    expect(stored?.error).toContain("bg_dep_failed");
    // The terminal state is visible to poll_task immediately (no running window).
    const polled = await registry.pollOnce("bg_dependent", 0);
    expect(polled.status).toBe("failed");
  });

  it("queues behind a saturated cap, starts in priority order, and frees slots on completion", async () => {
    service = new BackgroundDispatchService(registry, { maxConcurrentTasks: 1 });
    let releaseRunning!: () => void;
    const runningGate = new Promise<void>((resolve) => (releaseRunning = resolve));
    let releaseHigh!: () => void;
    const highGate = new Promise<void>((resolve) => (releaseHigh = resolve));

    const firstOutput = registerForLaunch("bg_cap_first");
    service.launch({
      taskId: "bg_cap_first",
      outputFile: firstOutput,
      run: gatedRun(runningGate),
    });
    expect(service.activeCount).toBe(1);
    expect(service.queuedCount).toBe(0);

    const lowOutput = registerForLaunch("bg_cap_low");
    service.launch({
      taskId: "bg_cap_low",
      outputFile: lowOutput,
      priority: 5,
      run: async () => OK_RESULT,
    });
    const highOutput = registerForLaunch("bg_cap_high");
    service.launch({
      taskId: "bg_cap_high",
      outputFile: highOutput,
      priority: 0,
      run: gatedRun(highGate),
    });
    expect(service.queuedCount).toBe(2);
    expect(registry.getRegisteredTask("bg_cap_low")?.state).toBe("queued");

    // Priority 0 outranks priority 5 regardless of enqueue order.
    releaseRunning();
    await waitFor(() => service.activeCount === 1 && service.queuedCount === 1);
    expect(registry.readStoredResultSync("bg_cap_first")?.status).toBe("completed");
    expect(registry.getRegisteredTask("bg_cap_high")?.state).toBeUndefined();
    expect(registry.getRegisteredTask("bg_cap_low")?.state).toBe("queued");

    releaseHigh();
    await waitFor(() => service.activeCount === 0 && service.queuedCount === 0);
    expect(registry.readStoredResultSync("bg_cap_high")?.status).toBe("completed");
    expect(registry.readStoredResultSync("bg_cap_low")?.status).toBe("completed");
  });

  it("drains a dep-blocked queued dispatch once its dependency completes", async () => {
    let releaseDep!: () => void;
    const depGate = new Promise<void>((resolve) => (releaseDep = resolve));
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve));

    const depOutput = registerForLaunch("bg_dag_dep");
    service.launch({
      taskId: "bg_dag_dep",
      outputFile: depOutput,
      run: gatedRun(depGate),
    });
    const childOutput = registerForLaunch("bg_dag_child");
    const outcome = service.launch({
      taskId: "bg_dag_child",
      outputFile: childOutput,
      run: gatedRun(childGate),
      deps: ["bg_dag_dep"],
    });

    // Unmet deps queue the child even though no cap is configured.
    expect(outcome.started).toBe(false);
    expect(outcome.blockedBy).toEqual(["bg_dag_dep"]);
    expect(service.queuedCount).toBe(1);

    releaseDep();
    await waitFor(() => service.queuedCount === 0 && service.activeCount === 1);
    expect(registry.readStoredResultSync("bg_dag_dep")?.status).toBe("completed");
    expect(registry.getRegisteredTask("bg_dag_child")?.state).toBeUndefined();
    expect(registry.getRegisteredTask("bg_dag_child")?.dispatchedAtMs).toBeTypeOf("number");

    releaseChild();
    await waitFor(() => service.activeCount === 0);
    expect(registry.readStoredResultSync("bg_dag_child")?.status).toBe("completed");
    expect(readTaskQueuedDurationMs("bg_dag_child", { homeDir })).toBeGreaterThanOrEqual(0);
  });

  it("cancels a queued dispatch without ever running it and DEP_FAILs its dependents", async () => {
    service = new BackgroundDispatchService(registry, { maxConcurrentTasks: 1 });
    let releaseRunning!: () => void;
    const runningGate = new Promise<void>((resolve) => (releaseRunning = resolve));

    const firstOutput = registerForLaunch("bg_q_first");
    service.launch({
      taskId: "bg_q_first",
      outputFile: firstOutput,
      run: gatedRun(runningGate),
    });
    const queuedOutput = registerForLaunch("bg_q_target");
    service.launch({
      taskId: "bg_q_target",
      outputFile: queuedOutput,
      run: async () => OK_RESULT,
    });
    const dependentOutput = registerForLaunch("bg_q_dependent");
    service.launch({
      taskId: "bg_q_dependent",
      outputFile: dependentOutput,
      run: async () => OK_RESULT,
      deps: ["bg_q_target"],
    });
    expect(service.queuedCount).toBe(2);

    const cancelOutcome = await service.cancel("bg_q_target", "no longer needed");
    expect(cancelOutcome.status).toBe("cancelled");
    expect(cancelOutcome.alreadyTerminal).toBe(false);
    expect(cancelOutcome.checkpointId).toBeUndefined();
    expect(cancelOutcome.result?.error).toContain("cancelled while queued");
    // The cancelled dep resolves its queued dependent as DEP_FAILED at the drain.
    await waitFor(() => service.queuedCount === 0);
    expect(registry.readStoredResultSync("bg_q_dependent")?.error).toContain("DEP_FAILED");
    expect(registry.readStoredResultSync("bg_q_target")?.status).toBe("failed");
    // The running dispatch was untouched by the queued cancel.
    expect(service.activeCount).toBe(1);
    releaseRunning();
    await waitFor(() => service.activeCount === 0);
    expect(registry.readStoredResultSync("bg_q_first")?.status).toBe("completed");
  });

  it("drains queued dispatches with a terminal cancelled outcome on abortAll", async () => {
    service = new BackgroundDispatchService(registry, { maxConcurrentTasks: 1 });
    // The gate never opens: abortAll aborts the run, which unblocks gatedRun.
    const runningGate = new Promise<void>(() => {});

    const runningOutput = registerForLaunch("bg_sd_running");
    service.launch({
      taskId: "bg_sd_running",
      outputFile: runningOutput,
      run: gatedRun(runningGate),
    });
    const queuedOutput = registerForLaunch("bg_sd_queued");
    service.launch({
      taskId: "bg_sd_queued",
      outputFile: queuedOutput,
      run: async () => OK_RESULT,
    });
    expect(service.queuedCount).toBe(1);

    await service.abortAll("server shutting down");

    expect(service.activeCount).toBe(0);
    expect(service.queuedCount).toBe(0);
    expect(registry.readStoredResultSync("bg_sd_running")?.status).toBe("failed");
    const queuedResult = registry.readStoredResultSync("bg_sd_queued");
    expect(queuedResult?.status).toBe("failed");
    expect(queuedResult?.error).toContain("cancelled while queued");
    expect(queuedResult?.error).toContain("server shutting down");
    // No zombie queue markers survive the shutdown.
    expect(registry.getRegisteredTask("bg_sd_queued")?.state).toBeUndefined();
  });
});
