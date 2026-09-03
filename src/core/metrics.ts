import type { AgentRole } from "../agents/types.js";
import { defaultStorage, homeMetricsFilePath, resolveAgentMeshHome } from "./storage.js";

/**
 * M0 metrics-first: one append-only JSONL record per task dispatch or stall
 * event, persisted next to the session storage (<agentmeshHome>/metrics.jsonl)
 * following the registry.jsonl convention. Records are derived at the terminal
 * turn boundary (runner.recordTurn) from data AgentMesh already collects —
 * vendor-reported usage, duration and cancel/timeout evidence — so no second
 * metering path exists. Stall events are appended by the background watchdog,
 * which is the only component that observes them.
 */

export type TaskMetricsOutcome = "ok" | "error" | "stalled" | "cancelled" | "timeout";

/**
 * Per-dispatch metrics record. `role`/`agent`/`model` are optional because a
 * watchdog stall line is emitted before the dispatch result is known; absent
 * values are grouped under "unknown" instead of being fabricated.
 */
export interface TaskMetrics {
  /** Background task id (registry.jsonl key) when the dispatch ran in background. */
  taskId?: string;
  /** Owning Bridge Session id, for joins against session history. */
  sessionId?: string;
  role?: AgentRole;
  agent?: string;
  /** Effective requested model (explicit override or project-config default). */
  model?: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  /** Reserved retry counter; the runner seam currently has no retry signal. */
  retries: number;
  stallEvents: number;
  cancelEvents: number;
  outcome: TaskMetricsOutcome;
  /**
   * M7b queued→started latency in ms; present only when the dispatch waited in
   * the background queue (concurrency cap or unmet deps). Immediate starts leave
   * it absent so pre-M7b records stay byte-compatible.
   */
  queuedMs?: number;
  /** ISO timestamps; `startedAt` is derived from endedAt - durationMs. */
  startedAt: string;
  endedAt: string;
}

export type MetricsWindow = "all" | "24h" | "7d";

/** Aggregated statistics for one group key (a model or a role). */
export interface MetricsGroupStats {
  key: string;
  /** Dispatch records in the group; watchdog stall lines are not tasks. */
  taskCount: number;
  tokensIn: number;
  tokensOut: number;
  p50DurationMs: number;
  p95DurationMs: number;
  /** Share of dispatches that carry at least one retry (0 when no tasks). */
  retryRate: number;
  /** Stall events (own + watchdog-attributed via taskId) per dispatch. */
  stallRate: number;
  cancelCount: number;
  outcomes: Record<TaskMetricsOutcome, number>;
}

export interface MetricsAggregate {
  window: MetricsWindow;
  taskCount: number;
  /** Watchdog stall lines whose taskId matched no in-window dispatch record. */
  unattributedStallEvents: number;
  byModel: MetricsGroupStats[];
  byRole: MetricsGroupStats[];
}

const WINDOW_MS: Record<Exclude<MetricsWindow, "all">, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

const TASK_METRICS_OUTCOMES: readonly TaskMetricsOutcome[] = [
  "ok",
  "error",
  "stalled",
  "cancelled",
  "timeout",
];

const AGENT_ROLES: readonly AgentRole[] = ["worker", "reviewer", "tester"];

/** Resolves the metrics JSONL path exactly like the session storage home resolution. */
export function resolveMetricsFilePath(homeDir?: string): string {
  return homeMetricsFilePath(homeDir ?? resolveAgentMeshHome());
}

/**
 * Appends one metrics record as a JSONL line (through the shared StorageService).
 * Best-effort by design (same boundary as context-artifact persistence): an
 * I/O failure warns on stderr and returns false instead of failing the turn
 * that produced the metric.
 */
export function appendTaskMetrics(
  record: TaskMetrics,
  options: { homeDir?: string } = {},
): boolean {
  const filePath = resolveMetricsFilePath(options.homeDir);
  try {
    defaultStorage.appendLine(filePath, JSON.stringify(record), { store: "metrics" });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `AgentMesh task metrics could not be appended to '${filePath}': ${message}\n`,
    );
    return false;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

/**
 * Narrows one raw JSONL line into a TaskMetrics record. Returns undefined for
 * malformed lines: a required field missing/invalid, or an out-of-union
 * outcome/role. Corrupt lines are skipped by the caller, never fatal.
 */
function parseTaskMetricsLine(line: string): TaskMetrics | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const outcome = TASK_METRICS_OUTCOMES.find(
      (candidateOutcome) => candidateOutcome === candidate.outcome,
    );
    if (!outcome) return undefined;
    const startedAt = optionalIsoTimestamp(candidate.startedAt);
    const endedAt = optionalIsoTimestamp(candidate.endedAt);
    if (!startedAt || !endedAt) return undefined;
    const parsedRole = AGENT_ROLES.find((candidateRole) => candidateRole === candidate.role);
    if (candidate.role !== undefined && !parsedRole) return undefined;
    return {
      taskId: optionalString(candidate.taskId),
      sessionId: optionalString(candidate.sessionId),
      role: parsedRole,
      agent: optionalString(candidate.agent),
      model: optionalString(candidate.model),
      tokensIn: nonNegativeNumber(candidate.tokensIn),
      tokensOut: nonNegativeNumber(candidate.tokensOut),
      durationMs: nonNegativeNumber(candidate.durationMs),
      retries: nonNegativeNumber(candidate.retries),
      stallEvents: nonNegativeNumber(candidate.stallEvents),
      cancelEvents: nonNegativeNumber(candidate.cancelEvents),
      outcome,
      // M7b: absent on immediate-start records — never fabricated as 0.
      ...(typeof candidate.queuedMs === "number" &&
      Number.isFinite(candidate.queuedMs) &&
      candidate.queuedMs >= 0
        ? { queuedMs: candidate.queuedMs }
        : {}),
      startedAt,
      endedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads all persisted metrics records (through the shared StorageService).
 * Missing file → empty (cold start); any read failure → empty; corrupt lines
 * are skipped fail-closed with a stderr warning, mirroring the
 * corrupt-session quarantine warning style.
 */
export function readTaskMetrics(
  options: { homeDir?: string; filePath?: string } = {},
): TaskMetrics[] {
  const filePath = options.filePath ?? resolveMetricsFilePath(options.homeDir);
  try {
    return defaultStorage.readJsonLines(filePath, parseTaskMetricsLine, (corruptPath) => {
      process.stderr.write(
        `AgentMesh task metrics '${corruptPath}' contains a corrupt line; it was skipped.\n`,
      );
    });
  } catch {
    return [];
  }
}

/** Nearest-rank percentile over an ascending-sorted sample. */
function percentile(sortedAsc: number[], ratio: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(ratio * sortedAsc.length)));
  return sortedAsc[rank - 1]!;
}

function emptyOutcomeCounts(): Record<TaskMetricsOutcome, number> {
  return { ok: 0, error: 0, stalled: 0, cancelled: 0, timeout: 0 };
}

interface GroupAccumulator {
  taskCount: number;
  tokensIn: number;
  tokensOut: number;
  durations: number[];
  retriedCount: number;
  stallEvents: number;
  cancelCount: number;
  outcomes: Record<TaskMetricsOutcome, number>;
}

function newGroupAccumulator(): GroupAccumulator {
  return {
    taskCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    durations: [],
    retriedCount: 0,
    stallEvents: 0,
    cancelCount: 0,
    outcomes: emptyOutcomeCounts(),
  };
}

function finalizeGroup(key: string, accumulator: GroupAccumulator): MetricsGroupStats {
  const sortedAsc = [...accumulator.durations].sort((a, b) => a - b);
  return {
    key,
    taskCount: accumulator.taskCount,
    tokensIn: accumulator.tokensIn,
    tokensOut: accumulator.tokensOut,
    p50DurationMs: percentile(sortedAsc, 0.5),
    p95DurationMs: percentile(sortedAsc, 0.95),
    retryRate: accumulator.taskCount === 0 ? 0 : accumulator.retriedCount / accumulator.taskCount,
    stallRate: accumulator.taskCount === 0 ? 0 : accumulator.stallEvents / accumulator.taskCount,
    cancelCount: accumulator.cancelCount,
    outcomes: { ...accumulator.outcomes },
  };
}

function buildGroups(
  dispatches: TaskMetrics[],
  keyOf: (record: TaskMetrics) => string,
  stallEventsByTaskId: Map<string, number>,
): MetricsGroupStats[] {
  const groups = new Map<string, GroupAccumulator>();
  const attributedTaskIds = new Set<string>();
  for (const record of dispatches) {
    const key = keyOf(record);
    const group = groups.get(key) ?? newGroupAccumulator();
    let attributedStallEvents = 0;
    if (record.taskId) {
      const watchdogEvents = stallEventsByTaskId.get(record.taskId);
      if (watchdogEvents !== undefined) {
        attributedStallEvents = watchdogEvents;
        attributedTaskIds.add(record.taskId);
      }
    }
    group.taskCount += 1;
    group.tokensIn += record.tokensIn;
    group.tokensOut += record.tokensOut;
    group.durations.push(record.durationMs);
    if (record.retries > 0) group.retriedCount += 1;
    group.stallEvents += record.stallEvents + attributedStallEvents;
    group.cancelCount += record.cancelEvents;
    group.outcomes[record.outcome] += 1;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => finalizeGroup(key, group))
    .sort((a, b) => b.taskCount - a.taskCount || a.key.localeCompare(b.key));
}

/**
 * Aggregates records for the requested time window. Watchdog stall lines
 * (outcome "stalled") are events, not tasks: they are attributed to the
 * dispatch record sharing their taskId; leftovers surface as
 * `unattributedStallEvents`. `nowMs` is injectable for deterministic tests.
 */
export function aggregateTaskMetrics(
  records: TaskMetrics[],
  options: { window?: MetricsWindow; nowMs?: number } = {},
): MetricsAggregate {
  const window = options.window ?? "all";
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = window === "all" ? Number.NEGATIVE_INFINITY : nowMs - WINDOW_MS[window];
  const inWindow = records.filter((record) => {
    const endedAtMs = Date.parse(record.endedAt);
    return Number.isFinite(endedAtMs) && endedAtMs >= cutoffMs;
  });

  const stallEventsByTaskId = new Map<string, number>();
  let standaloneStallEvents = 0;
  for (const record of inWindow) {
    if (record.outcome !== "stalled") continue;
    const events = Math.max(record.stallEvents, 1);
    if (!record.taskId) {
      standaloneStallEvents += events;
      continue;
    }
    stallEventsByTaskId.set(record.taskId, (stallEventsByTaskId.get(record.taskId) ?? 0) + events);
  }

  const dispatches = inWindow.filter((record) => record.outcome !== "stalled");
  const byModel = buildGroups(
    dispatches,
    (record) => record.model ?? "unknown",
    stallEventsByTaskId,
  );
  const byRole = buildGroups(dispatches, (record) => record.role ?? "unknown", stallEventsByTaskId);

  let unattributedStallEvents = standaloneStallEvents;
  for (const [taskId, events] of stallEventsByTaskId) {
    if (!dispatches.some((record) => record.taskId === taskId)) {
      unattributedStallEvents += events;
    }
  }

  return {
    window,
    taskCount: dispatches.length,
    unattributedStallEvents,
    byModel,
    byRole,
  };
}
