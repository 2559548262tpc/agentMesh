import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAgentMeshHome } from "./session.js";
import type { AgentTier } from "./config.js";

/**
 * M2 model-health routing: one append-only JSONL record per dispatch outcome
 * or stall event, persisted next to the metrics store
 * (<agentmeshHome>/health.jsonl, same resolution convention as metrics.jsonl).
 * Aggregated per-agent+model state (counts, latency percentiles, decayed
 * health score, quarantine) is DERIVED from the event log at snapshot time,
 * so persistence stays append-only and a restart reproduces the same state.
 *
 * Score formula (time-decayed failure rate with a recency prior):
 *   S     = Σ_success 0.5 ^ (ageMs / halfLifeMs)   — half-life default 24h
 *   F     = Σ_failure 0.5 ^ (ageMs / halfLifeMs)
 *   score = 1 - F / (S + F + 1)                   — 1.0 when no events exist
 * The +1 is a recency prior (one virtual recent success): it keeps unproven
 * models at 1.0, bounds a single fresh failure at 0.5, and — because every
 * real event's weight decays toward 0 while the prior does not — lets the
 * score of an idle model relax back toward 1.0, so old failures fade without
 * any manual bookkeeping.
 *
 * Quarantine (circuit breaker, derived — never persisted as state):
 *   quarantined := consecutiveFailures >= failureThreshold
 *               && nowMs - lastFailureAtMs < cooldownMs
 * A model with >= failureThreshold (default 3) consecutive failures is
 * excluded from health-ordered candidate resolution until the cooldown
 * (default 30min) elapses; a success resets the consecutive counter. If every
 * candidate is quarantined they are reinstated as a last resort with a
 * warning — health only reorders, it never permanently disables.
 */

export type ModelHealthFailureKind = "error" | "stall";

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_QUARANTINE_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_HEALTH_HALF_LIFE_MS = 24 * 60 * 60_000;
/** Rolling latency-sample bound per agent+model (p50/p95 input). */
export const MAX_DURATION_SAMPLES = 100;

const HEALTH_FILE_NAME = "health.jsonl";

/** Resolves the health JSONL path exactly like the metrics file resolution. */
export function resolveHealthFilePath(homeDir?: string): string {
  return path.join(homeDir ?? resolveAgentMeshHome(), HEALTH_FILE_NAME);
}

export interface ModelHealthStoreOptions {
  /** AgentMesh home directory; defaults to the session-storage home resolution. */
  homeDir?: string;
  /** Explicit file path override (wins over homeDir). */
  filePath?: string;
  /** Consecutive failures that quarantine a model (default 3, min 1). */
  failureThreshold?: number;
  /** Quarantine cooldown before automatic lift (default 30min). */
  cooldownMs?: number;
  /** Score decay half-life in ms (default 24h). */
  halfLifeMs?: number;
}

/** One terminal dispatch outcome attributed to an agent+model pair. */
export interface ModelOutcomeRecord {
  agent: string;
  model: string;
  durationMs?: number;
  /** Background task id, used to attribute watchdog stall events. */
  taskId?: string;
  /** Injectable event clock (epoch ms); defaults to Date.now(). */
  atMs?: number;
}

/** Watchdog stall event; agent/model are unknown at emit time and are attributed via taskId. */
export interface StallEventRecord {
  taskId: string;
  atMs?: number;
}

/** Append-only JSONL line shapes (discriminated on `type`). */
interface SuccessLine {
  type: "success";
  agent: string;
  model: string;
  durationMs?: number;
  taskId?: string;
  atMs: number;
}

interface FailureLine {
  type: "failure";
  kind: ModelHealthFailureKind;
  agent: string;
  model: string;
  durationMs?: number;
  taskId?: string;
  atMs: number;
}

interface StallLine {
  type: "stall";
  taskId: string;
  atMs: number;
}

/** Tombstone clearing recorded state so a manual reset keeps the log append-only. */
interface ResetLine {
  type: "reset";
  agent?: string;
  model?: string;
  atMs: number;
}

type HealthLine = SuccessLine | FailureLine | StallLine | ResetLine;

/** Aggregated, derived health record for one agent+model pair. */
export interface ModelHealthEntry {
  agent: string;
  model: string;
  /** Time-decayed health score in [0,1); 1.0 when no events exist (recency prior). */
  score: number;
  successCount: number;
  errorCount: number;
  stallCount: number;
  p50DurationMs: number;
  p95DurationMs: number;
  consecutiveFailures: number;
  lastFailureAt?: string;
  quarantined: boolean;
  /** ISO instant the (re)quarantine started, i.e. the latest failure time. */
  quarantinedAt?: string;
  /** Remaining quarantine cooldown in ms; present only while quarantined. */
  cooldownRemainingMs?: number;
}

export interface ModelHealthSnapshot {
  nowMs: number;
  entries: ModelHealthEntry[];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Narrows one raw JSONL line into a HealthLine. Returns undefined for
 * malformed lines; corrupt lines are skipped by the caller, never fatal.
 */
function parseHealthLine(line: string): HealthLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const atMs = epochMs(candidate.atMs);
    if (atMs === undefined) return undefined;
    const type = candidate.type;
    if (type === "stall") {
      const taskId = nonEmptyString(candidate.taskId);
      return taskId ? { type: "stall", taskId, atMs } : undefined;
    }
    if (type === "reset") {
      return {
        type: "reset",
        agent: nonEmptyString(candidate.agent),
        model: nonEmptyString(candidate.model),
        atMs,
      };
    }
    const agent = nonEmptyString(candidate.agent);
    const model = nonEmptyString(candidate.model);
    const durationMs = nonNegativeNumber(candidate.durationMs);
    const taskId = nonEmptyString(candidate.taskId);
    if (type === "success") {
      if (!agent || !model) return undefined;
      return {
        type: "success",
        agent,
        model,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(taskId ? { taskId } : {}),
        atMs,
      };
    }
    if (type === "failure") {
      const kind = candidate.kind;
      if (!agent || !model) return undefined;
      if (kind !== "error" && kind !== "stall") return undefined;
      return {
        type: "failure",
        kind,
        agent,
        model,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(taskId ? { taskId } : {}),
        atMs,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads all persisted health lines. Missing file → empty (cold start); corrupt
 * lines are skipped fail-closed with a stderr warning, mirroring the metrics
 * reader behavior.
 */
export function readHealthLines(
  options: { homeDir?: string; filePath?: string } = {},
): HealthLine[] {
  const filePath = options.filePath ?? resolveHealthFilePath(options.homeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines: HealthLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseHealthLine(line);
    if (parsed) {
      lines.push(parsed);
    } else {
      process.stderr.write(
        `AgentMesh model health '${filePath}' contains a corrupt line; it was skipped.\n`,
      );
    }
  }
  return lines;
}

function appendHealthLine(
  line: HealthLine,
  options: { homeDir?: string; filePath?: string } = {},
): boolean {
  const filePath = options.filePath ?? resolveHealthFilePath(options.homeDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, "utf-8");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `AgentMesh model health could not be appended to '${filePath}': ${message}\n`,
    );
    return false;
  }
}

/** Appends one watchdog stall event (best-effort; see appendTaskMetrics for the same boundary). */
export function appendStallEvent(
  event: StallEventRecord,
  options: { homeDir?: string; filePath?: string } = {},
): boolean {
  return appendHealthLine(
    { type: "stall", taskId: event.taskId, atMs: event.atMs ?? Date.now() },
    options,
  );
}

/** Nearest-rank percentile over an ascending-sorted sample (mirrors metrics.ts). */
function percentile(sortedAsc: number[], ratio: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(ratio * sortedAsc.length)));
  return sortedAsc[rank - 1]!;
}

/** Event weight with time-based half-life decay; older events weigh less. */
export function healthEventWeight(eventAtMs: number, nowMs: number, halfLifeMs: number): number {
  const ageMs = Math.max(0, nowMs - eventAtMs);
  return 0.5 ** (ageMs / halfLifeMs);
}

function healthKey(agent: string, model: string): string {
  return `${agent}\u0000${model}`;
}

interface MutableEntry {
  agent: string;
  model: string;
  successWeight: number;
  failureWeight: number;
  successCount: number;
  errorCount: number;
  stallCount: number;
  durations: number[];
  consecutiveFailures: number;
  lastFailureAtMs?: number;
}

function resetMatches(
  entries: Map<string, MutableEntry>,
  target: { agent?: string; model?: string },
): void {
  for (const [key, entry] of [...entries.entries()]) {
    const agentMatch = !target.agent || entry.agent === target.agent;
    const modelMatch = !target.model || entry.model === target.model;
    if (agentMatch && modelMatch) entries.delete(key);
  }
}

/**
 * Folds the append-only event log into per-agent+model health entries.
 * Watchdog stall lines (taskId only) are attributed to the agent+model of the
 * terminal dispatch record sharing that taskId, mirroring the M0 metrics
 * aggregation join. A kind="stall" failure line whose taskId already has a
 * stall event line is not double-counted (the stall event covers it).
 * Pure: time enters only through `nowMs`.
 */
export function foldModelHealth(
  lines: HealthLine[],
  options: { nowMs: number; failureThreshold: number; cooldownMs: number; halfLifeMs: number },
): ModelHealthEntry[] {
  const { nowMs, failureThreshold, cooldownMs, halfLifeMs } = options;

  const attribution = new Map<string, { agent: string; model: string }>();
  const stallTaskIds = new Set<string>();
  for (const line of lines) {
    if (line.type === "stall") {
      stallTaskIds.add(line.taskId);
      continue;
    }
    if (line.type === "success" || line.type === "failure") {
      if (line.taskId) attribution.set(line.taskId, { agent: line.agent, model: line.model });
    }
  }

  const entries = new Map<string, MutableEntry>();
  const entryFor = (agent: string, model: string): MutableEntry => {
    const key = healthKey(agent, model);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        agent,
        model,
        successWeight: 0,
        failureWeight: 0,
        successCount: 0,
        errorCount: 0,
        stallCount: 0,
        durations: [],
        consecutiveFailures: 0,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  for (const line of lines) {
    switch (line.type) {
      case "reset":
        resetMatches(entries, line);
        break;
      case "success": {
        const entry = entryFor(line.agent, line.model);
        entry.successCount += 1;
        entry.successWeight += healthEventWeight(line.atMs, nowMs, halfLifeMs);
        entry.consecutiveFailures = 0;
        if (line.durationMs !== undefined) {
          entry.durations.push(line.durationMs);
          if (entry.durations.length > MAX_DURATION_SAMPLES) entry.durations.shift();
        }
        break;
      }
      case "failure": {
        // Dedup: a watchdog-stalled task records both a stall event line and a
        // kind="stall" terminal failure line; count the stall once.
        if (line.kind === "stall" && line.taskId && stallTaskIds.has(line.taskId)) break;
        const entry = entryFor(line.agent, line.model);
        if (line.kind === "error") entry.errorCount += 1;
        else entry.stallCount += 1;
        entry.failureWeight += healthEventWeight(line.atMs, nowMs, halfLifeMs);
        entry.consecutiveFailures += 1;
        entry.lastFailureAtMs = line.atMs;
        if (line.durationMs !== undefined) {
          entry.durations.push(line.durationMs);
          if (entry.durations.length > MAX_DURATION_SAMPLES) entry.durations.shift();
        }
        break;
      }
      case "stall": {
        const attributed = attribution.get(line.taskId);
        if (!attributed) break;
        const entry = entryFor(attributed.agent, attributed.model);
        entry.stallCount += 1;
        entry.failureWeight += healthEventWeight(line.atMs, nowMs, halfLifeMs);
        entry.consecutiveFailures += 1;
        entry.lastFailureAtMs = line.atMs;
        break;
      }
    }
  }

  return [...entries.values()]
    .map((entry) => {
      // score = 1 - F / (S + F + 1): the +1 recency prior (one virtual recent
      // success) keeps unproven models at 1.0 and lets an idle model's score
      // relax back toward 1.0 as all real event weights decay away.
      const score = 1 - entry.failureWeight / (entry.successWeight + entry.failureWeight + 1);
      const sortedAsc = [...entry.durations].sort((a, b) => a - b);
      const quarantined =
        entry.consecutiveFailures >= failureThreshold &&
        entry.lastFailureAtMs !== undefined &&
        nowMs - entry.lastFailureAtMs < cooldownMs;
      return {
        agent: entry.agent,
        model: entry.model,
        score,
        successCount: entry.successCount,
        errorCount: entry.errorCount,
        stallCount: entry.stallCount,
        p50DurationMs: percentile(sortedAsc, 0.5),
        p95DurationMs: percentile(sortedAsc, 0.95),
        consecutiveFailures: entry.consecutiveFailures,
        ...(entry.lastFailureAtMs !== undefined
          ? { lastFailureAt: new Date(entry.lastFailureAtMs).toISOString() }
          : {}),
        quarantined,
        ...(quarantined && entry.lastFailureAtMs !== undefined
          ? {
              quarantinedAt: new Date(entry.lastFailureAtMs).toISOString(),
              cooldownRemainingMs: cooldownMs - (nowMs - entry.lastFailureAtMs),
            }
          : {}),
      };
    })
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
}

/**
 * Aggregates one agent's per-model entries into a single ordering signal for
 * candidate resolution. Conservative on purpose: the score is the agent's
 * worst recorded model, and the agent only counts as quarantined when every
 * model observed for it is quarantined (a healthy sibling model is still
 * dispatchable).
 */
export function resolveAgentHealthCandidate(
  entries: ModelHealthEntry[],
  agent: string,
): { score: number; quarantined: boolean } | undefined {
  const owned = entries.filter((entry) => entry.agent === agent);
  if (owned.length === 0) return undefined;
  return {
    score: Math.min(...owned.map((entry) => entry.score)),
    quarantined: owned.every((entry) => entry.quarantined),
  };
}

/** Candidate input for health-ordered resolution (declared config metadata). */
export interface HealthWeightedCandidate {
  key: string;
  tier?: AgentTier;
  costLevel?: number;
}

export interface HealthOrderedCandidates {
  /** Ordered candidates; quarantined entries excluded unless nothing else remains. */
  candidates: HealthWeightedCandidate[];
  /** Present when every candidate was quarantined and was reinstated as a last resort. */
  warning?: string;
}

export interface HealthCandidateSignal {
  score: number;
  quarantined: boolean;
}

/**
 * Pure, deterministic candidate ordering: tier match first (candidates whose
 * declared tier equals the reference tier), then health score (healthy
 * candidates first, higher score first), then declared costLevel ascending
 * (unmetered entries last, declaration order kept for ties — the sort is
 * stable). Quarantined candidates are excluded entirely; only when nothing
 * else remains are they reinstated (original order, tier/costLevel sorted)
 * and flagged through the returned warning.
 */
export function orderCandidatesByHealth(params: {
  candidates: HealthWeightedCandidate[];
  referenceTier?: AgentTier;
  healthOf?: (key: string) => HealthCandidateSignal | undefined;
}): HealthOrderedCandidates {
  const { candidates, referenceTier, healthOf } = params;
  const tierRank = (candidate: HealthWeightedCandidate): number =>
    candidate.tier !== undefined && candidate.tier === referenceTier ? 0 : 1;
  const costRank = (candidate: HealthWeightedCandidate): number =>
    candidate.costLevel ?? Number.POSITIVE_INFINITY;

  const partitioned = {
    healthy: [] as HealthWeightedCandidate[],
    quarantined: [] as HealthWeightedCandidate[],
  };
  for (const candidate of candidates) {
    const signal = healthOf?.(candidate.key);
    if (signal?.quarantined) partitioned.quarantined.push(candidate);
    else partitioned.healthy.push(candidate);
  }

  const healthySorted = [...partitioned.healthy].sort(
    (a, b) =>
      tierRank(a) - tierRank(b) ||
      (healthOf?.(b.key)?.score ?? 1) - (healthOf?.(a.key)?.score ?? 1) ||
      costRank(a) - costRank(b),
  );
  if (healthySorted.length > 0) return { candidates: healthySorted };

  const quarantinedSorted = [...partitioned.quarantined].sort(
    (a, b) => tierRank(a) - tierRank(b) || costRank(a) - costRank(b),
  );
  if (quarantinedSorted.length === 0) return { candidates: [] };
  return {
    candidates: quarantinedSorted,
    warning: `All ${quarantinedSorted.length} upgrade candidate(s) are currently quarantined by model health; they were reinstated as a last resort.`,
  };
}

/**
 * Append-only model health store. State is derived per snapshot from the
 * JSONL event log, so instances hold only configuration and are cheap to
 * share; persistence boundaries (best-effort append, fail-closed corrupt-line
 * reads) mirror metrics.ts.
 */
export class ModelHealthStore {
  private readonly filePath: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfLifeMs: number;

  constructor(options: ModelHealthStoreOptions = {}) {
    this.filePath = options.filePath ?? resolveHealthFilePath(options.homeDir);
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_QUARANTINE_COOLDOWN_MS);
    this.halfLifeMs =
      options.halfLifeMs !== undefined && options.halfLifeMs > 0
        ? options.halfLifeMs
        : DEFAULT_HEALTH_HALF_LIFE_MS;
  }

  /** Records one successful dispatch (resets the consecutive-failure counter). */
  public recordSuccess(record: ModelOutcomeRecord): boolean {
    return appendHealthLine(
      {
        type: "success",
        agent: record.agent,
        model: record.model,
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
        atMs: record.atMs ?? Date.now(),
      },
      { filePath: this.filePath },
    );
  }

  /** Records one dispatch failure; kind "stall" marks silence/timeout failures. */
  public recordFailure(kind: ModelHealthFailureKind, record: ModelOutcomeRecord): boolean {
    return appendHealthLine(
      {
        type: "failure",
        kind,
        agent: record.agent,
        model: record.model,
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
        atMs: record.atMs ?? Date.now(),
      },
      { filePath: this.filePath },
    );
  }

  /** Records one watchdog stall event (taskId-keyed; attributed at snapshot time). */
  public recordStall(event: StallEventRecord): boolean {
    return appendStallEvent(event, { filePath: this.filePath });
  }

  /**
   * Appends a reset tombstone: subsequent snapshots clear the matching state
   * (agent+model pair, all models of an agent, one model across agents, or
   * everything when neither is given). Used by tests and `agentmesh health
   * --reset`.
   */
  public resetModelHealth(target: { agent?: string; model?: string; atMs?: number } = {}): boolean {
    return appendHealthLine(
      {
        type: "reset",
        ...(target.agent ? { agent: target.agent } : {}),
        ...(target.model ? { model: target.model } : {}),
        atMs: target.atMs ?? Date.now(),
      },
      { filePath: this.filePath },
    );
  }

  /** Derives the current per-model health snapshot from the event log. */
  public snapshot(nowMs: number = Date.now()): ModelHealthSnapshot {
    const entries = foldModelHealth(readHealthLines({ filePath: this.filePath }), {
      nowMs,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      halfLifeMs: this.halfLifeMs,
    });
    return { nowMs, entries };
  }
}
