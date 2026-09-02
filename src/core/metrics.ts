import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRole } from "../agents/types.js";
import { resolveAgentMeshHome } from "./session.js";

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

const METRICS_FILE_NAME = "metrics.jsonl";

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
  return path.join(homeDir ?? resolveAgentMeshHome(), METRICS_FILE_NAME);
}

/**
 * Appends one metrics record as a JSONL line. Best-effort by design (same
 * boundary as context-artifact persistence): an I/O failure warns on stderr
 * and returns false instead of failing the turn that produced the metric.
 */
export function appendTaskMetrics(
  record: TaskMetrics,
  options: { homeDir?: string } = {},
): boolean {
  const filePath = resolveMetricsFilePath(options.homeDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
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
      startedAt,
      endedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads all persisted metrics records. Missing file → empty (cold start);
 * corrupt lines are skipped fail-closed with a stderr warning, mirroring the
 * corrupt-session quarantine warning style.
 */
export function readTaskMetrics(
  options: { homeDir?: string; filePath?: string } = {},
): TaskMetrics[] {
  const filePath = options.filePath ?? resolveMetricsFilePath(options.homeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const records: TaskMetrics[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseTaskMetricsLine(line);
    if (parsed) {
      records.push(parsed);
    } else {
      process.stderr.write(
        `AgentMesh task metrics '${filePath}' contains a corrupt line; it was skipped.\n`,
      );
    }
  }
  return records;
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
