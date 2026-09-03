import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPidAlive, readTaskQueuedDurationMs } from "../../src/core/background.js";
import { createSimulationHarness, stringField, type SimulationHarness } from "./harness.js";

/**
 * S10 (M7b lifecycle: dependency DAG + priority queue) — the queue primitives
 * over the M1 fake-vendor surface (ROADMAP_v0.4 M7b × M1).
 *
 * Every dispatch/poll goes through the REAL in-process MCP surface
 * (delegate_task/poll_task via InMemoryTransport) with REAL fake-vendor child
 * processes, and the bridge runs under the documented
 * AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS=1 cap so queue draining is
 * strictly sequential and observable.
 *
 * Pinned behaviors:
 * 1. a dep → dependent → grandchild chain dispatches as QUEUED (blocked),
 *    poll_task reports blocked with blockedBy + queuePosition, and the drain
 *    runs the chain strictly in dependency order (a dependent never starts
 *    before its dependency's terminal SUCCESS);
 * 2. the queued→running transition emits a genuine task.started event after
 *    the dependency's task.completed (the long-poller wake contract);
 * 3. queued latency is observable through readTaskQueuedDurationMs;
 * 4. with two queued priority candidates the lower priority number starts
 *    first regardless of enqueue order, and every drained dispatch reaps its
 *    vendor child.
 */

/** Full delegate_task response (task id + status line) for queue assertions. */
async function dispatch(
  harness: SimulationHarness,
  task: string,
  extra: { priority?: number; deps?: string[] } = {},
): Promise<{ taskId: string; text: string }> {
  const res = await harness.client.callTool({
    name: "delegate_task",
    arguments: {
      agent: "codex",
      task,
      cwd: harness.workDir,
      role: "worker",
      mode: "cli",
      background: true,
      ...extra,
    },
  });
  if (res.isError) {
    throw new Error(`delegate_task failed: ${JSON.stringify(res.content)}`);
  }
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  const taskId = text.match(/Task ID: (\S+)/)?.[1];
  if (!taskId) {
    throw new Error(`delegate_task response carried no Task ID: ${text}`);
  }
  return { taskId, text };
}

describe("S10 M7b DAG and priority: the queue drains real fake-vendor dispatches in order", () => {
  let harness: SimulationHarness | undefined;
  const originalCap = process.env.AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS;

  beforeEach(() => {
    // The bridge-level cap is an env property read at service construction
    // (the documented AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS override).
    process.env.AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS = "1";
  });

  afterEach(async () => {
    if (originalCap === undefined) {
      delete process.env.AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS;
    } else {
      process.env.AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS = originalCap;
    }
    await harness?.dispose();
    harness = undefined;
  });

  it("holds a dep-chain blocked and drains it strictly in dependency order", async () => {
    harness = await createSimulationHarness({ label: "s10" });
    // The root must outlive the two ~500ms blocked polls below, so it streams
    // for roughly 2.5s before finishing; the dependents are short turns.
    const depTurn =
      "fake-vendor-sim: mode=ok, delay-ms=2500, interval-ms=100, heartbeats=3, out-chars=60";
    const turn =
      "fake-vendor-sim: mode=ok, delay-ms=80, interval-ms=50, heartbeats=2, out-chars=60";

    const dep = await dispatch(harness, `Root dependency task.\n${depTurn}`);
    expect(dep.text).toContain("Status: RUNNING");
    const depPid = await harness.waitForChildPid(dep.taskId);

    const child = await dispatch(harness, `Dependent task.\n${turn}`, { deps: [dep.taskId] });
    expect(child.text).toContain("Status: QUEUED (blocked by deps:");
    expect(child.text).toContain(dep.taskId);
    const grandchild = await dispatch(harness, `Grandchild task.\n${turn}`, {
      deps: [child.taskId],
    });
    expect(grandchild.text).toContain("Status: QUEUED (blocked by deps:");
    expect(grandchild.text).toContain(child.taskId);

    // poll_task reports blocked with the unmet dep ids and the queue rank.
    const blockedChild = await harness.pollTask(child.taskId);
    expect(blockedChild.status).toBe("blocked");
    expect(blockedChild.blockedBy).toEqual([dep.taskId]);
    expect(blockedChild.queuePosition).toBe(1);
    const blockedGrandchild = await harness.pollTask(grandchild.taskId);
    expect(blockedGrandchild.status).toBe("blocked");
    expect(blockedGrandchild.blockedBy).toEqual([child.taskId]);
    expect(blockedGrandchild.queuePosition).toBe(2);

    // The root completes on its own; the drain then runs child → grandchild.
    const depTerminal = await harness.pollTask(dep.taskId, { maxWaitMs: 20_000 });
    expect(depTerminal.status).toBe("completed");
    const childTerminal = await harness.pollTask(child.taskId, { maxWaitMs: 20_000 });
    expect(childTerminal.status).toBe("completed");
    expect(stringField(childTerminal.result, "summary")).toContain("DONE:");
    const grandchildTerminal = await harness.pollTask(grandchild.taskId, { maxWaitMs: 20_000 });
    expect(grandchildTerminal.status).toBe("completed");
    expect(stringField(grandchildTerminal.result, "summary")).toContain("DONE:");

    // Strict ordering proof via the bus event log (the sim harness freezes the
    // registry's injectable logical clock, so event append order — not record
    // timestamps — is the clock-independent ordering evidence). Dispatches
    // announce task.started at registration (the "accepted" announcement), so
    // the LAST started occurrence per task is its genuine execution start: the
    // drained chain must observe completed(dep) < started(child) <
    // completed(child) < started(grandchild).
    const events = harness.events;
    const lastEventIndex = (type: string, taskId: string): number => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]!;
        if (event.type === type && event.taskId === taskId) return i;
      }
      return -1;
    };
    const depCompletedAt = lastEventIndex("task.completed", dep.taskId);
    const childStartedAt = lastEventIndex("task.started", child.taskId);
    const childCompletedAt = lastEventIndex("task.completed", child.taskId);
    const grandchildStartedAt = lastEventIndex("task.started", grandchild.taskId);
    expect(depCompletedAt).toBeGreaterThanOrEqual(0);
    expect(childStartedAt).toBeGreaterThan(depCompletedAt);
    expect(childCompletedAt).toBeGreaterThan(childStartedAt);
    expect(grandchildStartedAt).toBeGreaterThan(childCompletedAt);
    expect(harness.registry.getRegisteredTask(child.taskId)?.state).toBeUndefined();

    // M7b metrics seam: the child's queued latency is observable.
    expect(
      readTaskQueuedDurationMs(child.taskId, { homeDir: harness.homeDir }),
    ).toBeGreaterThanOrEqual(0);

    // Windows process discipline: the root's vendor child was reaped.
    await harness.waitFor(() => !isPidAlive(depPid));
  });

  it("starts queued dispatches in priority order (lower first) as the cap frees", async () => {
    harness = await createSimulationHarness({ label: "s10" });
    // The cap holder must outlive the two ~500ms queued polls below.
    const firstTurn =
      "fake-vendor-sim: mode=ok, delay-ms=2500, interval-ms=100, heartbeats=3, out-chars=60";
    const turn =
      "fake-vendor-sim: mode=ok, delay-ms=80, interval-ms=50, heartbeats=2, out-chars=60";

    const first = await dispatch(harness, `First task.\n${firstTurn}`);
    expect(first.text).toContain("Status: RUNNING");
    const firstPid = await harness.waitForChildPid(first.taskId);

    const low = await dispatch(harness, `Low priority task.\n${turn}`, { priority: 5 });
    expect(low.text).toContain("Status: QUEUED (waiting for a free concurrency slot)");
    const high = await dispatch(harness, `High priority task.\n${turn}`, { priority: 0 });
    expect(high.text).toContain("Status: QUEUED (waiting for a free concurrency slot)");

    // Rank: priority 0 outranks priority 5 regardless of enqueue order.
    const highPoll = await harness.pollTask(high.taskId);
    expect(highPoll.status).toBe("queued");
    expect(highPoll.queuePosition).toBe(1);
    const lowPoll = await harness.pollTask(low.taskId);
    expect(lowPoll.status).toBe("queued");
    expect(lowPoll.queuePosition).toBe(2);

    // The chain drains first → high → low under the cap of 1.
    for (const dispatched of [first, high, low]) {
      const terminal = await harness.pollTask(dispatched.taskId, { maxWaitMs: 20_000 });
      expect(terminal.status).toBe("completed");
    }

    // Drain order via the bus event log (clock-independent, and using the LAST
    // started occurrence per task = the genuine execution start, see above):
    // the cap holder completes first, then priority 0 starts before priority 5.
    const events = harness.events;
    const lastEventIndexOf = (type: string, taskId: string): number => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]!;
        if (event.type === type && event.taskId === taskId) return i;
      }
      return -1;
    };
    const firstCompletedAt = lastEventIndexOf("task.completed", first.taskId);
    const highStartedAt = lastEventIndexOf("task.started", high.taskId);
    const lowStartedAt = lastEventIndexOf("task.started", low.taskId);
    expect(firstCompletedAt).toBeGreaterThanOrEqual(0);
    expect(highStartedAt).toBeGreaterThan(firstCompletedAt);
    expect(lowStartedAt).toBeGreaterThan(highStartedAt);

    // The cap holder's vendor child was reaped.
    await harness.waitFor(() => !isPidAlive(firstPid));
  });
});
