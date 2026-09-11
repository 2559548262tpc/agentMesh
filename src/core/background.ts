import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import {
  defaultStorage,
  homeTasksDirectory,
  resolveAgentMeshHome,
  taskOutputFilePath,
  taskRegistryFilePath,
  taskResultFilePath,
} from "./storage.js";
import { appendTaskMetrics } from "./metrics.js";
import type { WorkflowLane } from "./metrics.js";
import { appendStallEvent } from "./health.js";
import type { AgentMeshEventBus } from "./events.js";

/**
 * T1.4 background task registry.
 *
 * Persists one JSONL line per dispatched background task so a restarted bridge
 * can distinguish live work from orphans left behind by a dead process. The
 * registry is deliberately dumb storage plus pure decision helpers: completion
 * is inferred either from a `<taskId>.result.json` record written by the
 * completion callback or, absent that, from process liveness. Output bytes are
 * read incrementally at a byte offset (same semantics as [CC]
 * utils/task/diskOutput.ts) so poll_task never re-reads what the caller
 * already consumed.
 */

/** Output silence after which an active background task is reported as stalled. */
export const STALLED_OUTPUT_THRESHOLD_MS = 10 * 60_000;

/**
 * Output silence after which a stalled background task is auto-terminated
 * with a checkpoint (P5 T5.3): stalled work is first made observable, then —
 * if the orchestrator does not intervene within the grace window — reaped so
 * unattended runs cannot accumulate forever.
 */
export const STALLED_TERMINATE_THRESHOLD_MS = 30 * 60_000;

/**
 * Grace period after which an unfinished registration owned by a foreign live
 * bridge is presumed abandoned and reaped at startup (P5 T5.3 GC, [CC]
 * evictAfter style). Conservative on purpose: records inside the window are
 * preserved because another live process may still be working on them.
 */
export const ORPHAN_GC_GRACE_MS = 24 * 60 * 60_000;
/** Dead-lettered orphan records kept for poll_task interrupted-lookups (P-R14-3). */
export const MAX_RETAINED_ORPHANS = 100;

/** How often the stalled watchdog inspects active tasks while any exist. */
export const WATCHDOG_INTERVAL_MS = 30_000;

/** Lane value guard for registry lines (mirrors the TaskMetrics lane union in metrics.ts). */
const REGISTRY_LANE_VALUES: readonly WorkflowLane[] = ["fast", "standard", "gated", "full"];

/** Wait between two output-file polls inside one poll_task call. */
export const POLL_INTERVAL_MS = 100;

/** Upper bound a single poll_task call may spend waiting for progress. */
export const POLL_MAX_WAIT_MS = 500;

/**
 * ISS-5 hard cap on any poll_task long-poll budget: a caller-requested
 * maxWaitMs beyond this ceiling previously blocked past MCP client timeouts
 * (`-32001 Request timed out`), defeating the long-poll contract. The cap
 * stays safely under the common 30s host/MCP window; callers wanting a longer
 * horizon loop poll_task calls instead of one oversized block.
 */
export const POLL_MAX_WAIT_CAP_MS = 25_000;

/** Cap for one incremental output read (mirrors [CC] DEFAULT_MAX_READ_BYTES). */
export const MAX_POLL_READ_BYTES = 8 * 1024 * 1024;

/** One persisted background-task registration line in registry.jsonl. */
export interface BackgroundTaskRecord {
  taskId: string;
  /**
   * Owning bridge-process pid. Orphan detection keys on this pid: when the
   * owning bridge dies, its incomplete registrations are reaped on next
   * startup. The vendor child pid is intentionally not used because it is not
   * observable at the MCP dispatch boundary before spawn.
   */
  pid: number;
  /** Registration instant (epoch ms). */
  startedAtMs: number;
  /** Absolute path of the tee'd stdout/stderr capture file. */
  outputFile: string;
  /**
   * Set when a startup orphan scan found the owning process dead without a
   * terminal result (P-R14-3): the record is retained as dead-letter evidence
   * so poll_task can report 'interrupted by restart' instead of NOT_FOUND.
   * Orphaned records are pruned by age/count on subsequent scans.
   */
  orphanedAtMs?: number;
  /**
   * M7b queue marker: present only while the dispatch is registered but held
   * out of execution (concurrency cap reached or dependencies unmet). The
   * persisted marker is what lets a restarted bridge re-derive the queue
   * state from registry.jsonl; it is cleared when the task starts or leaves
   * the queue (cancel / DEP_FAILED).
   */
  state?: "queued";
  /** Queue ordering key (lower runs first). Only meaningful while queued. */
  priority?: number;
  /** Instant the dispatch entered the queue (epoch ms); the tiebreaker after priority. */
  enqueuedAtMs?: number;
  /** Task ids that must reach terminal SUCCESS before this dispatch may start. */
  deps?: string[];
  /** Actual execution start instant (epoch ms); differs from startedAtMs when queued first. */
  dispatchedAtMs?: number;
  /**
   * v0.5 Batch 2 #8 triage lane (design §5), stamped by the workflow engine at
   * registration so the watchdog stall metrics line can attribute the lane.
   * Absent for dispatches outside a workflow run (direct MCP delegate_task).
   */
  lane?: WorkflowLane;
}

/** Terminal outcome written by the completion callback to <taskId>.result.json. */
export interface StoredTaskResult {
  taskId: string;
  status: "completed" | "failed";
  summary?: string;
  finalAnswer?: string;
  error?: string;
  exitCode?: number;
  /**
   * M7b pause/resume handle: the Bridge session that executed the dispatch,
   * persisted so pause_task/continue_task can resume the same session without
   * the orchestrator bookkeeping the mapping itself. Absent for dispatches
   * that never reached a vendor turn (queued-cancelled, DEP_FAILED).
   */
  sessionId?: string;
  completedAtMs: number;
}

export type PollTaskStatus =
  | "running"
  | "queued"
  | "blocked"
  | "completed"
  | "failed"
  | "stalled"
  | "interrupted";

export interface PollTaskOutcome {
  taskId: string;
  status: PollTaskStatus;
  /** New output bytes since sinceOffset. */
  outputSinceOffset: string;
  /** Byte offset the caller should pass as the next sinceOffset. */
  nextOffset: number;
  /** True when unread bytes remain beyond nextOffset. */
  hasMore: boolean;
  /** Present once the task reached a terminal state. */
  result?: StoredTaskResult;
  /** Dead-letter timestamp when the owning bridge died before completion (P-R15-1). */
  interruptedAtMs?: number;
  /** Re-dispatch guidance accompanying an interrupted status. */
  guidance?: string;
  /**
   * M7b: 1-based rank among the bridge's queued (not-yet-started) dispatches,
   * ordered by (priority, enqueue time). Present only while queued/blocked.
   */
  queuePosition?: number;
  /** M7b: dep ids that have not reached terminal SUCCESS yet (status "blocked"). */
  blockedBy?: string[];
}

export interface PollTaskOptions {
  taskId: string;
  sinceOffset?: number;
  maxWaitMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Event-driven wake hook (Plan 2026-09-01): resolves as soon as the task
   * has activity (bus event or output-file change). When absent, pollTask
   * keeps the legacy fixed-interval sleep loop — zero behavior change.
   */
  waitForActivity?: (taskId: string) => Promise<void>;
}

/** Raised when poll_task references a taskId unknown to memory and registry. */
export class BackgroundTaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Background task '${taskId}' was not found in the registry.`);
    this.name = "BackgroundTaskNotFoundError";
    this.taskId = taskId;
  }
}

/** Raised by scanAndReapOrphans when the registry file cannot be parsed. */
export class BackgroundRegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BackgroundRegistryError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Cross-platform pid liveness probe (signal 0: ESRCH = gone, EPERM = alive but foreign). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface OutputRangeRead {
  content: string;
  nextOffset: number;
  hasMore: boolean;
}

/** Reads at most maxBytes of filePath starting at byte offset ([CC] diskOutput semantics). */
async function readOutputRange(
  filePath: string,
  offset: number,
  maxBytes: number,
): Promise<OutputRangeRead> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", nextOffset: offset, hasMore: false };
    }
    throw err;
  }
  try {
    const total = (await handle.stat()).size;
    if (offset >= total) {
      return { content: "", nextOffset: offset, hasMore: false };
    }
    const length = Math.min(maxBytes, total - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      // A chunk boundary can split a multi-byte UTF-8 sequence; the replacement
      // char it produces is the documented cost of offset-based reads.
      content: buffer.toString("utf8"),
      nextOffset: offset + bytesRead,
      hasMore: offset + bytesRead < total,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the last maxBytes of a task output file for checkpoint capture (P5
 * T5.2). Missing files degrade to an empty snapshot; oversized files keep
 * only the tail, which is where the most recent work lives.
 */
export async function readTailSnapshot(filePath: string, maxBytes: number): Promise<string> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, "r");
  } catch {
    return "";
  }
  try {
    const total = (await handle.stat()).size;
    const length = Math.min(maxBytes, total);
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, total - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close();
  }
}

function parseRegistryLine(line: string): BackgroundTaskRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.taskId !== "string" ||
      typeof candidate.pid !== "number" ||
      typeof candidate.startedAtMs !== "number" ||
      typeof candidate.outputFile !== "string"
    ) {
      return undefined;
    }
    // Lane guard mirrors the TaskMetrics lane union (metrics.ts); old registry
    // lines predate the field and keep it absent.
    const parsedLane = REGISTRY_LANE_VALUES.find((lane) => lane === candidate.lane);
    return {
      taskId: candidate.taskId,
      pid: candidate.pid,
      startedAtMs: candidate.startedAtMs,
      outputFile: candidate.outputFile,
      // Dead-letter marker (P-R14-3); old registry lines predate it.
      ...(typeof candidate.orphanedAtMs === "number"
        ? { orphanedAtMs: candidate.orphanedAtMs }
        : {}),
      // M7b queue fields; old registry lines predate them.
      ...(candidate.state === "queued" ? { state: "queued" as const } : {}),
      ...(typeof candidate.priority === "number" ? { priority: candidate.priority } : {}),
      ...(typeof candidate.enqueuedAtMs === "number"
        ? { enqueuedAtMs: candidate.enqueuedAtMs }
        : {}),
      ...(Array.isArray(candidate.deps)
        ? { deps: candidate.deps.filter((dep): dep is string => typeof dep === "string") }
        : {}),
      ...(typeof candidate.dispatchedAtMs === "number"
        ? { dispatchedAtMs: candidate.dispatchedAtMs }
        : {}),
      ...(parsedLane ? { lane: parsedLane } : {}),
    };
  } catch {
    return undefined;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Narrows one parsed result-file document into a StoredTaskResult. Returns
 * undefined for malformed input; a corrupt result file is treated as absent
 * (liveness decides instead), never fatal.
 */
function parseStoredResult(parsed: unknown): StoredTaskResult | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.taskId !== "string" ||
    (candidate.status !== "completed" && candidate.status !== "failed") ||
    typeof candidate.completedAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    taskId: candidate.taskId,
    status: candidate.status,
    summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
    finalAnswer: typeof candidate.finalAnswer === "string" ? candidate.finalAnswer : undefined,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
    exitCode: typeof candidate.exitCode === "number" ? candidate.exitCode : undefined,
    sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
    completedAtMs: candidate.completedAtMs,
  };
}

/** M7b queue order: priority ascending (lower runs first), then enqueue instant. */
function compareQueueOrder(a: BackgroundTaskRecord, b: BackgroundTaskRecord): number {
  const priorityDelta = (a.priority ?? 0) - (b.priority ?? 0);
  if (priorityDelta !== 0) return priorityDelta;
  return (a.enqueuedAtMs ?? a.startedAtMs) - (b.enqueuedAtMs ?? b.startedAtMs);
}

/**
 * M7b metrics seam: queued→started latency for a background dispatch that
 * waited in the concurrency/dependency queue. Defined only when the record
 * carries both the enqueue and the actual dispatch instants (immediate starts
 * never queue, so they report undefined and the metrics record stays as
 * before). Reads the latest persisted registry record for the taskId.
 */
export function readTaskQueuedDurationMs(
  taskId: string,
  options: { homeDir?: string } = {},
): number | undefined {
  const homeDir = options.homeDir ?? resolveAgentMeshHome();
  const registryFile = taskRegistryFilePath(homeDir);
  let latest: BackgroundTaskRecord | undefined;
  for (const record of defaultStorage.readJsonLines(registryFile, parseRegistryLine)) {
    if (record.taskId === taskId) latest = record;
  }
  const { enqueuedAtMs, dispatchedAtMs } = latest ?? {};
  if (enqueuedAtMs === undefined || dispatchedAtMs === undefined) return undefined;
  return Math.max(0, dispatchedAtMs - enqueuedAtMs);
}

export interface StalledWatchdogOptions {
  /**
   * Resolves the activity handle executor.ts keeps per running background task.
   * Returning undefined falls back to the registration timestamp baseline.
   */
  getActivityHandle?: (taskId: string) => { getLastOutputAtMs(): number | undefined } | undefined;
  intervalMs?: number;
  thresholdMs?: number;
  /** Advisory callback invoked at most once per task (deduplicated). */
  onStalled?: (taskId: string) => void;
  /**
   * P5 T5.3 second-stage callback: fired at most once per task when its
   * silence has lasted terminateThresholdMs past the stalled notification.
   * The registry only reports; termination + checkpointing belong to the
   * owner of the abort controllers (BackgroundDispatchService).
   */
  onStalledTerminate?: (taskId: string) => void;
  /** Silence duration past the stalled notification before onStalledTerminate fires. */
  terminateThresholdMs?: number;
}

export interface BackgroundRegistryOptions {
  homeDir?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  /** Optional in-process bus; when absent the registry behaves exactly as before. */
  eventBus?: AgentMeshEventBus;
}

export class BackgroundTaskRegistry {
  private readonly homeDir: string;
  private readonly tasksDir: string;
  private readonly registryFile: string;
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly _eventBus: AgentMeshEventBus | undefined;
  private readonly active = new Map<string, BackgroundTaskRecord>();
  private readonly released = new Set<string>();
  private readonly stalledNotified = new Set<string>();
  /** Instant each task was first notified as stalled (epoch ms, injectable clock). */
  private readonly stalledSince = new Map<string, number>();
  private readonly terminatedNotified = new Set<string>();
  private watchdogConfig: StalledWatchdogOptions | undefined;
  private watchdogTimer: NodeJS.Timeout | undefined;

  constructor(options: BackgroundRegistryOptions = {}) {
    this.homeDir = options.homeDir ?? resolveAgentMeshHome();
    this.tasksDir = homeTasksDirectory(this.homeDir);
    this.registryFile = taskRegistryFilePath(this.homeDir);
    this.now = options.now ?? Date.now;
    this.pidAlive = options.isPidAlive ?? isPidAlive;
    this._eventBus = options.eventBus;
  }

  /** The bus wired at construction, if any (read by the MCP notifier). */
  public get eventBus(): AgentMeshEventBus | undefined {
    return this._eventBus;
  }

  /**
   * Looks up a dead-lettered orphan record (owning process died without a
   * terminal result). Returns undefined for live/unknown tasks — callers use
   * this after their normal lookups miss, to distinguish "never existed" from
   * "interrupted by a bridge restart" (P-R14-3).
   */
  public getInterruptedTask(taskId: string): BackgroundTaskRecord | undefined {
    const record = this.readPersistedRecords().find(
      (candidate) => candidate.taskId === taskId && candidate.orphanedAtMs,
    );
    return record ? { ...record } : undefined;
  }

  /** Directory holding registry.jsonl, output captures and result records. */
  public get tasksDirectory(): string {
    return this.tasksDir;
  }

  public get registryFilePath(): string {
    return this.registryFile;
  }

  public outputFilePath(taskId: string): string {
    return taskOutputFilePath(this.homeDir, taskId);
  }

  private resultFilePath(taskId: string): string {
    return taskResultFilePath(this.homeDir, taskId);
  }

  /**
   * Registers and persists one background task. The JSONL append happens
   * synchronously before the caller starts async work so a crash immediately
   * after launch still leaves a recoverable trace.
   */
  public registerTask(record: BackgroundTaskRecord): void {
    defaultStorage.ensureDirectory(this.tasksDir);
    // Eagerly create the declared output capture (P-R14-3): the dispatch
    // response promises this path, so it must exist even if the vendor never
    // writes a byte before a crash.
    defaultStorage.writeFile(record.outputFile, "", { store: "tasks", flag: "a" });
    defaultStorage.appendLine(this.registryFile, JSON.stringify(record), { store: "tasks" });
    this.active.set(record.taskId, { ...record });
    this.ensureWatchdogTimer();
    this._eventBus?.emit({
      type: "task.started",
      taskId: record.taskId,
      outputFile: record.outputFile,
      startedAtMs: record.startedAtMs,
    });
  }

  /** Memory-first lookup with a registry.jsonl fallback (restart recovery). */
  public getRegisteredTask(taskId: string): BackgroundTaskRecord | undefined {
    const live = this.active.get(taskId);
    if (live) return { ...live };
    for (const record of this.readPersistedRecords()) {
      if (record.taskId === taskId) return record;
    }
    return undefined;
  }

  private readPersistedRecords(): BackgroundTaskRecord[] {
    // Corrupt lines are skipped silently, never fatal: the registry must stay
    // readable (same convention as before; parseRegistryLine returns undefined
    // for malformed input).
    return defaultStorage.readJsonLines(this.registryFile, parseRegistryLine);
  }

  /**
   * M7b queue bookkeeping: a queue-state transition updates the owning record
   * in memory and re-publishes registry.jsonl (deduped, last record per taskId
   * wins) so a restarted bridge re-derives the queue from disk. The rewrite is
   * synchronous on purpose: transitions run inside the single-threaded
   * dispatch decision path, so no interleaved registration append can be
   * lost between the read and the publish.
   */
  private rewriteRecord(
    taskId: string,
    mutate: (record: BackgroundTaskRecord) => BackgroundTaskRecord,
  ): BackgroundTaskRecord | undefined {
    const inActive = this.active.get(taskId);
    const current =
      inActive ??
      [...this.readPersistedRecords()].reverse().find((record) => record.taskId === taskId);
    if (!current) return undefined;
    const updated = mutate({ ...current });
    if (inActive) this.active.set(taskId, updated);
    const deduped = new Map<string, BackgroundTaskRecord>();
    for (const record of this.readPersistedRecords()) deduped.set(record.taskId, record);
    deduped.set(taskId, updated);
    const records = [...deduped.values()];
    defaultStorage.writeFileAtomicSync(
      this.registryFile,
      records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""),
      { store: "tasks" },
    );
    return updated;
  }

  /** Marks a registered dispatch as queued (persists the queue marker). */
  public markTaskQueued(
    taskId: string,
    meta: { priority?: number; deps?: string[]; enqueuedAtMs: number },
  ): void {
    this.rewriteRecord(taskId, (record) => ({
      ...record,
      state: "queued",
      enqueuedAtMs: meta.enqueuedAtMs,
      ...(meta.priority !== undefined ? { priority: meta.priority } : {}),
      ...(meta.deps !== undefined ? { deps: [...meta.deps] } : {}),
    }));
  }

  /**
   * Marks a queued dispatch as started: clears the queue marker, stamps the
   * actual execution start, and (for queued→running transitions only) emits a
   * genuine task.started event so long-pollers blocked on a queued task wake.
   * Immediate-start dispatches already emitted task.started at registration
   * and are deliberately not re-announced.
   */
  public markTaskStarted(taskId: string): void {
    const wasQueued = this.getRegisteredTask(taskId)?.state === "queued";
    const updated = this.rewriteRecord(taskId, (record) => ({
      ...record,
      state: undefined,
      dispatchedAtMs: this.now(),
    }));
    if (wasQueued && updated) {
      this._eventBus?.emit({
        type: "task.started",
        taskId,
        outputFile: updated.outputFile,
        startedAtMs: updated.dispatchedAtMs ?? updated.startedAtMs,
      });
    }
  }

  /** Clears the queue marker when a task leaves the queue without starting (cancel / DEP_FAILED). */
  public markTaskDequeued(taskId: string): void {
    this.rewriteRecord(taskId, (record) => ({ ...record, state: undefined }));
  }

  /**
   * Queue view for one task: membership (queued = runnable, blocked = unmet
   * dependencies), its 1-based position, and the dep ids that have not reached
   * terminal SUCCESS yet. Returns undefined for tasks that are not queued.
   */
  public async getQueueStatus(
    taskId: string,
  ): Promise<{ state: "queued" | "blocked"; position: number; blockedBy: string[] } | undefined> {
    const queued = this.listQueuedRecords();
    const index = queued.findIndex((record) => record.taskId === taskId);
    if (index < 0) return undefined;
    const blockedBy: string[] = [];
    for (const dep of queued[index]!.deps ?? []) {
      const depResult = await this.readStoredResult(dep);
      if (!depResult || depResult.status !== "completed") blockedBy.push(dep);
    }
    return {
      state: blockedBy.length > 0 ? "blocked" : "queued",
      position: index + 1,
      blockedBy,
    };
  }

  /** Every record currently marked queued (own active map + persisted restart view), in run order. */
  private listQueuedRecords(): BackgroundTaskRecord[] {
    const queued = new Map<string, BackgroundTaskRecord>();
    for (const record of this.readPersistedRecords()) {
      if (record.state === "queued") queued.set(record.taskId, record);
    }
    for (const record of this.active.values()) {
      if (record.state === "queued") queued.set(record.taskId, record);
    }
    return [...queued.values()].sort(compareQueueOrder);
  }

  public async readStoredResult(taskId: string): Promise<StoredTaskResult | undefined> {
    let raw: string | undefined;
    try {
      raw = await defaultStorage.readTextFileAsync(this.resultFilePath(taskId));
    } catch {
      return undefined;
    }
    if (raw === undefined) return undefined;
    try {
      return parseStoredResult(JSON.parse(raw));
    } catch {
      // A half-written result file is treated as absent; liveness decides instead.
      return undefined;
    }
  }

  /**
   * Synchronous twin of readStoredResult for the M7b dispatch-decision path:
   * dependency ruling and queued-cancel recording run inside the single-threaded
   * launch/cancel decision and must observe the terminal state without an
   * interleaving await.
   */
  public readStoredResultSync(taskId: string): StoredTaskResult | undefined {
    return parseStoredResult(defaultStorage.readJson(this.resultFilePath(taskId)));
  }

  /**
   * Synchronous twin of writeStoredResult for the same decision path: the
   * DEP_FAILED and queued-cancel outcomes must be durably visible before the
   * launch/cancel call returns, so a poll_task issued right after can never
   * observe a stale "running" window.
   */
  public writeStoredResultSync(result: StoredTaskResult): void {
    defaultStorage.writeFileAtomicSync(this.resultFilePath(result.taskId), JSON.stringify(result), {
      store: "tasks",
    });
    this._eventBus?.emit({
      type: "task.completed",
      taskId: result.taskId,
      status: result.status,
      exitCode: result.exitCode,
    });
  }

  /** Completion callback target: persists the terminal outcome atomically enough for readers. */
  public async writeStoredResult(result: StoredTaskResult): Promise<void> {
    // Atomic temp+rename publish (shared StorageService) so pollTask readers
    // never observe a half-written result.
    await defaultStorage.writeFileAtomicAsync(
      this.resultFilePath(result.taskId),
      JSON.stringify(result),
      { store: "tasks" },
    );
    this._eventBus?.emit({
      type: "task.completed",
      taskId: result.taskId,
      status: result.status,
      exitCode: result.exitCode,
    });
  }

  /** Tasks still tracked in this process without a stored terminal result. */
  public listActiveTasks(): BackgroundTaskRecord[] {
    return [...this.active.values()]
      .filter((record) => !defaultStorage.exists(this.resultFilePath(record.taskId)))
      .map((record) => ({ ...record }));
  }

  /** True when the task already produced a stored terminal result. */
  public hasStoredResult(taskId: string): boolean {
    return defaultStorage.exists(this.resultFilePath(taskId));
  }

  /**
   * Startup orphan sweep (P5 T5.3, classify-before-act). Three rulings:
   * 1. owning pid dead → orphan, reaped (output/result files remain on disk
   *    for post-mortem inspection);
   * 2. finished task owned by a live bridge → tracking no longer needed, reaped;
   * 3. live foreign owner with no result but older than the GC grace period →
   *    presumed abandoned, reaped with the age recorded. Records owned by
   *    ANOTHER live bridge inside the grace window are left untouched — this
   *    process must never terminate another instance's work.
   */
  public async scanAndReapOrphans(): Promise<BackgroundTaskRecord[]> {
    const records = this.readPersistedRecords();
    if (records.length === 0) return [];
    const kept: BackgroundTaskRecord[] = [];
    const reaped: BackgroundTaskRecord[] = [];
    // P-R15-1 follow-up (r16 问题 2): only records WITHOUT a terminal result
    // get the interrupted dead-letter. A dead process's COMPLETED task is not
    // interrupted — it keeps its record unmarked so the result file stays
    // discoverable and the panel never shows a false "被打断" badge.
    const completedByDeadProcess: BackgroundTaskRecord[] = [];
    for (const record of records) {
      const hasResult = defaultStorage.exists(this.resultFilePath(record.taskId));
      if (!this.pidAlive(record.pid)) {
        if (hasResult) {
          completedByDeadProcess.push(record);
        } else {
          reaped.push(record);
        }
        continue;
      }
      // A finished task owned by a live bridge needs no further tracking.
      if (hasResult && !this.active.has(record.taskId)) {
        completedByDeadProcess.push(record);
        continue;
      }
      if (
        !this.active.has(record.taskId) &&
        record.pid !== process.pid &&
        this.now() - record.startedAtMs >= ORPHAN_GC_GRACE_MS
      ) {
        completedByDeadProcess.push(record);
        continue;
      }
      kept.push(record);
    }
    if (reaped.length > 0) {
      // P-R14-3: orphaned records are dead-lettered (marked, not dropped) so a
      // later poll_task reports "interrupted by restart" with the declared
      // output path instead of a bare NOT_FOUND. Prune by age and count.
      const now = this.now();
      const marked = reaped.map((record) => ({ ...record, orphanedAtMs: now }));
      const retainedOrphans = [...this.readPersistedRecords()]
        .filter((record) => record.orphanedAtMs)
        .sort((a, b) => (b.orphanedAtMs ?? 0) - (a.orphanedAtMs ?? 0))
        .slice(0, MAX_RETAINED_ORPHANS - 1);
      await this.rewriteRegistry([
        ...kept,
        ...completedByDeadProcess,
        ...retainedOrphans,
        ...marked,
      ]);
    }
    return reaped;
  }

  private async rewriteRegistry(records: BackgroundTaskRecord[]): Promise<void> {
    // Atomic temp+rename rewrite (shared StorageService, Windows copy fallback).
    await defaultStorage.writeFileAtomicAsync(
      this.registryFile,
      records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""),
      { store: "tasks" },
    );
  }

  /**
   * Installs the stalled watchdog configuration and starts its timer. The
   * timer only keeps running while at least one active task exists.
   */
  public enableStalledWatchdog(options: StalledWatchdogOptions): void {
    this.watchdogConfig = options;
    this.ensureWatchdogTimer();
  }

  /** Observable for tests/diagnostics: whether the watchdog timer currently runs. */
  public get isWatchdogRunning(): boolean {
    return this.watchdogTimer !== undefined;
  }

  private ensureWatchdogTimer(): void {
    // The watchdog timer exists only while there is something to watch.
    if (!this.watchdogConfig || this.watchdogTimer || this.active.size === 0) return;
    const intervalMs = this.watchdogConfig.intervalMs ?? WATCHDOG_INTERVAL_MS;
    this.watchdogTimer = setInterval(() => this.runWatchdogTick(), intervalMs);
    this.watchdogTimer.unref();
  }

  private runWatchdogTick(): void {
    if (this.active.size === 0) {
      this.stopWatchdogTimer();
      return;
    }
    this.checkStalledTasks(this.now());
  }

  private stopWatchdogTimer(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  /**
   * Pure-ish stall sweep with an injectable clock: flags every active task
   * whose last observed output instant is at least the threshold old. Each
   * task is notified at most once (dedup set, [AB] scheduleTurnWatchdog style).
   * A second stage (P5 T5.3) fires onStalledTerminate once per task when the
   * silence has lasted terminateThresholdMs past that notification.
   */
  public checkStalledTasks(nowMs: number): string[] {
    const thresholdMs = this.watchdogConfig?.thresholdMs ?? STALLED_OUTPUT_THRESHOLD_MS;
    const terminateMs = this.watchdogConfig?.terminateThresholdMs ?? STALLED_TERMINATE_THRESHOLD_MS;
    const newlyStalled: string[] = [];
    for (const [taskId, record] of this.active) {
      if (this.terminatedNotified.has(taskId)) continue;
      if (defaultStorage.exists(this.resultFilePath(taskId))) continue;
      // Queued dispatches produce no output by definition (no vendor process
      // has been started); stall detection must not flag them.
      if (record.state === "queued") continue;
      const handle = this.watchdogConfig?.getActivityHandle?.(taskId);
      const lastOutputAtMs = handle?.getLastOutputAtMs() ?? record.startedAtMs;
      const silence = nowMs - lastOutputAtMs;
      if (this.stalledNotified.has(taskId)) {
        const since = this.stalledSince.get(taskId) ?? nowMs;
        if (terminateMs > 0 && nowMs - since >= terminateMs) {
          this.terminatedNotified.add(taskId);
          this.stalledSince.delete(taskId);
          this.watchdogConfig?.onStalledTerminate?.(taskId);
        }
        continue;
      }
      if (silence >= thresholdMs) {
        this.stalledNotified.add(taskId);
        this.stalledSince.set(taskId, nowMs);
        newlyStalled.push(taskId);
        this.watchdogConfig?.onStalled?.(taskId);
        this._eventBus?.emit({ type: "task.stalled", taskId });
        // M0 metrics: the watchdog is the only stall observer, so it appends
        // the stall event line (role/agent/model unknown at this point; the
        // aggregator attributes it to the dispatch record via taskId). The
        // Batch 2 #8 triage lane rides along when the workflow engine stamped
        // it on the registry record.
        appendTaskMetrics(
          {
            taskId,
            ...(record.lane ? { lane: record.lane } : {}),
            outcome: "stalled",
            stallEvents: 1,
            tokensIn: 0,
            tokensOut: 0,
            durationMs: 0,
            retries: 0,
            cancelEvents: 0,
            startedAt: new Date(record.startedAtMs).toISOString(),
            endedAt: new Date(nowMs).toISOString(),
          },
          { homeDir: this.homeDir },
        );
        // M2 health: same taskId-keyed stall evidence; the health snapshot
        // attributes it to agent+model via the terminal dispatch record.
        appendStallEvent({ taskId }, { homeDir: this.homeDir });
      }
    }
    if (this.active.size === 0) this.stopWatchdogTimer();
    return newlyStalled;
  }

  /** True once the watchdog has flagged this task as stalled in this process. */
  public isStallNotified(taskId: string): boolean {
    return this.stalledNotified.has(taskId);
  }

  /** Drops in-process tracking after the task promise settled. */
  public releaseTask(taskId: string): void {
    this.active.delete(taskId);
    this.released.add(taskId);
    this.stalledSince.delete(taskId);
    if (this.active.size === 0) this.stopWatchdogTimer();
  }

  /** True when releaseTask already ran for this taskId in this process. */
  public isReleased(taskId: string): boolean {
    return this.released.has(taskId);
  }

  /**
   * Resolves once the task shows activity (Plan 2026-09-01): a lifecycle bus
   * event, or any change to the output capture file — the vendor child writes
   * that file directly, so an fs.watch is the only in-process "output arrived"
   * signal. Internally time-bounded so the poller's own deadline logic stays
   * in charge even when nothing happens.
   */
  public async waitForActivity(
    taskId: string,
    timeoutMs: number = WATCHDOG_INTERVAL_MS,
  ): Promise<void> {
    const record = this.getRegisteredTask(taskId);
    // Lost-wakeup guard: arm the bus waiter BEFORE checking the stored result.
    // writeStoredResult writes the result file and only then emits, so a
    // completion landing before the check is already visible on disk, and one
    // landing after is caught by the waiter armed below. A waiter orphaned by
    // the fast path self-cleans via its own timeout and resolves harmlessly.
    const busWaiter = this._eventBus?.waitForEvent(taskId, timeoutMs);
    if (this.hasStoredResult(taskId)) return;
    let watcher: fs.FSWatcher | undefined;
    let dirWatcher: fs.FSWatcher | undefined;
    let fileTimer: NodeJS.Timeout | undefined;
    const fileChanged = new Promise<void>((resolve) => {
      if (!record) return resolve();
      try {
        watcher = fs.watch(record.outputFile, { persistent: false }, () => resolve());
        watcher.on("error", () => resolve());
      } catch {
        // Output file missing or unwatchable: bus/dir/deadline path covers it.
      }
      try {
        // Busless fallback: the terminal result lands in the tasks directory,
        // not in the output file, so a directory watch is the only disk-level
        // terminal signal. Spurious wakes from sibling tasks are harmless —
        // the next pollOnce re-checks the real state.
        dirWatcher = fs.watch(this.tasksDir, { persistent: false }, () => resolve());
        dirWatcher.on("error", () => resolve());
      } catch {
        // Tasks dir unwatchable: bus/deadline path covers it.
      }
      fileTimer = setTimeout(() => resolve(), timeoutMs);
      fileTimer.unref?.();
    });
    try {
      if (busWaiter) {
        await Promise.race([busWaiter, fileChanged]);
      } else {
        await fileChanged;
      }
    } finally {
      if (fileTimer) clearTimeout(fileTimer);
      watcher?.close();
      dirWatcher?.close();
    }
  }

  /** One poll step: status resolution plus incremental output read. */
  public async pollOnce(taskId: string, sinceOffset: number): Promise<PollTaskOutcome> {
    const record = this.getRegisteredTask(taskId);
    if (!record) {
      // ISS-6: a reaped/expired registry line must not orphan a persisted
      // terminal result. The result file survives registry rewrites (reaping
      // only drops the record), so poll_task returns the terminal outcome
      // instead of a bare NOT_FOUND when the files are still on disk.
      const persisted = await this.readStoredResult(taskId);
      if (persisted) {
        return {
          taskId,
          status: persisted.status,
          outputSinceOffset: "",
          nextOffset: Math.max(0, sinceOffset),
          hasMore: false,
          result: persisted,
        };
      }
      throw new BackgroundTaskNotFoundError(taskId);
    }
    const stored = await this.readStoredResult(taskId);
    const read = await readOutputRange(
      record.outputFile,
      Math.max(0, sinceOffset),
      MAX_POLL_READ_BYTES,
    );
    if (read.content.length > 0) {
      this._eventBus?.emit({ type: "task.output", taskId });
    }
    // P-R15-1: a dead-lettered record means the owning bridge died without a
    // terminal result. That is NOT a task failure — surface the interruption
    // with the declared output path so the orchestrator can re-dispatch.
    if (record.orphanedAtMs) {
      return {
        taskId,
        status: "interrupted",
        outputSinceOffset: read.content,
        nextOffset: read.nextOffset,
        hasMore: read.hasMore,
        interruptedAtMs: record.orphanedAtMs,
        guidance:
          "The bridge process owning this task died (crash or kill) before completion. Partial output above (if any); re-dispatch the task (same idempotencyKey if one was used) to re-execute.",
      };
    }
    let status: PollTaskStatus;
    if (stored) {
      status = stored.status;
    } else if (this.isStallNotified(taskId)) {
      status = "stalled";
    } else if (
      record.state === "queued" &&
      (record.pid === process.pid || this.pidAlive(record.pid))
    ) {
      // M7b: registered but deliberately held out of execution (concurrency cap
      // or unmet dependencies). A dead owner falls through to the liveness
      // ruling below — the next startup scan dead-letters it as interrupted.
      const queueStatus = await this.getQueueStatus(taskId);
      if (queueStatus) {
        return {
          taskId,
          status: queueStatus.state,
          outputSinceOffset: read.content,
          nextOffset: read.nextOffset,
          hasMore: read.hasMore,
          queuePosition: queueStatus.position,
          ...(queueStatus.blockedBy.length > 0 ? { blockedBy: queueStatus.blockedBy } : {}),
        };
      }
      status = "running";
    } else if (this.active.has(taskId)) {
      status = "running";
    } else {
      // Registered but neither active nor terminal here: decide by owner liveness.
      status = this.pidAlive(record.pid) ? "running" : "failed";
    }
    return {
      taskId,
      status,
      outputSinceOffset: read.content,
      nextOffset: read.nextOffset,
      hasMore: read.hasMore,
      ...(stored ? { result: stored } : {}),
    };
  }

  /**
   * Polls until a terminal/stalled state or maxWaitMs elapse. Without a
   * waitForActivity hook it sleep-polls intervalMs between attempts
   * (default 100ms/500ms); with one, the wait is event-driven — a single
   * sleep of the remaining budget only serves as the deadline guard, so a
   * long maxWaitMs call blocks until activity instead of re-polling.
   * Queued/blocked dispatches (M7b) also keep the call waiting: the
   * queued→running transition emits a task.started event that wakes the poll.
   */
  public async pollTask(options: PollTaskOptions): Promise<PollTaskOutcome> {
    const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    // ISS-5: the effective budget is capped so a long-poll call can never
    // outlive the MCP client's own request timeout.
    const maxWaitMs = Math.min(options.maxWaitMs ?? POLL_MAX_WAIT_MS, POLL_MAX_WAIT_CAP_MS);
    const sleep = options.sleep ?? defaultSleep;
    // The wait budget is wall-clock bounded on purpose: the injectable logical
    // clock drives status decisions and must never stretch a caller's poll.
    const deadline = Date.now() + maxWaitMs;
    let outcome = await this.pollOnce(options.taskId, options.sinceOffset ?? 0);
    while (
      (outcome.status === "running" ||
        outcome.status === "queued" ||
        outcome.status === "blocked") &&
      Date.now() < deadline
    ) {
      if (options.waitForActivity) {
        // Event-driven wake: the remaining budget is the losing race member,
        // so a never-firing hook cannot stretch the caller's poll.
        const remainingMs = Math.max(deadline - Date.now(), 0);
        await Promise.race([options.waitForActivity(options.taskId), sleep(remainingMs)]);
      } else {
        await sleep(intervalMs);
      }
      outcome = await this.pollOnce(options.taskId, options.sinceOffset ?? 0);
    }
    return outcome;
  }
}
