/**
 * In-process typed event bus for the communication surface (Plan 2026-09-01).
 * Scope guard: this bus NEVER crosses process boundaries — `agentmesh ui`
 * runs in a separate process and uses fs.watch + SSE instead. Disk stays the
 * persistence layer; the bus only removes sleep-polling inside one process.
 */

/** Lifecycle events emitted by BackgroundTaskRegistry. */
export type AgentMeshEvent =
  | { type: "task.started"; taskId: string; outputFile: string; startedAtMs: number }
  | { type: "task.output"; taskId: string }
  | {
      type: "task.completed";
      taskId: string;
      status: "completed" | "failed";
      exitCode?: number;
    }
  | { type: "task.stalled"; taskId: string };

export type AgentMeshEventListener = (event: AgentMeshEvent) => void;

export interface AgentMeshEventBus {
  emit(event: AgentMeshEvent): void;
  /** Returns an unsubscribe function. Listener exceptions are isolated. */
  subscribe(listener: AgentMeshEventListener): () => void;
  /**
   * Resolves with the first event matching taskId, or null after timeoutMs.
   * Timeout resolves (never rejects) so callers can race it against deadlines.
   */
  waitForEvent(taskId: string, timeoutMs: number): Promise<AgentMeshEvent | null>;
}

export function createAgentMeshEventBus(): AgentMeshEventBus {
  const listeners = new Set<AgentMeshEventListener>();
  const waiters = new Map<string, Array<(event: AgentMeshEvent | null) => void>>();

  const emit = (event: AgentMeshEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber must never break emit — the registry stays
        // functional regardless of observer failures.
      }
    }
    const taskWaiters = waiters.get(event.taskId);
    if (taskWaiters) {
      waiters.delete(event.taskId);
      for (const resolve of taskWaiters) resolve(event);
    }
  };

  const subscribe = (listener: AgentMeshEventListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const waitForEvent = (taskId: string, timeoutMs: number): Promise<AgentMeshEvent | null> =>
    new Promise((resolve) => {
      const taskWaiters = waiters.get(taskId) ?? [];
      taskWaiters.push(resolve);
      waiters.set(taskId, taskWaiters);
      const timer = setTimeout(() => {
        const pending = waiters.get(taskId);
        if (!pending) return; // already resolved by an event
        const index = pending.indexOf(resolve);
        if (index >= 0) pending.splice(index, 1);
        if (pending.length === 0) waiters.delete(taskId);
        resolve(null);
      }, timeoutMs);
      // Unref so a dangling wait never holds the process open at shutdown.
      timer.unref?.();
    });

  return { emit, subscribe, waitForEvent };
}
