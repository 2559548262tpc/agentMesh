import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import type { BridgeSession, SessionHistoryEntry, TimelineEntry } from "../core/types.js";
import type { BackgroundTaskRecord, StoredTaskResult } from "../core/background.js";
import { isPidAlive } from "../core/background.js";
import { loadProjectConfig } from "../core/config.js";

// ---------------------------------------------------------------------------
// Read-only data access layer for the UI visualization panel.
//
// Every function takes `homeDir` as an explicit parameter instead of calling
// resolveAgentMeshHome(), which lets tests inject a temporary directory and
// avoids any coupling to the real agentmesh home.  No writes, no locks, no
// SessionManager instantiation — only fs reads.
// ---------------------------------------------------------------------------

/** Cap for a single incremental output read (mirrors background.ts MAX_POLL_READ_BYTES). */
const MAX_POLL_READ_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Data source inspection (v3 §7.1)
// ---------------------------------------------------------------------------

/** Result of checking whether the session data directory/file is usable. */
export interface DataSourceInspection {
  homeDir: string;
  sessionsFile: string;
  /** Chinese-description anomalies; empty when the source is healthy. */
  warnings: string[];
}

/**
 * v3: validates the session data source pointed at by `homeDir`. Checks the
 * directory exists, sessions.json is readable, and its JSON parses. Returns
 * human-readable Chinese warnings so the panel can surface why the local task
 * directory is abnormal without blocking rendering.
 */
export function inspectDataSource(homeDir: string): DataSourceInspection {
  const sessionsFile = nodePath.join(homeDir, "sessions.json");
  const warnings: string[] = [];

  if (!fs.existsSync(homeDir) || !fs.statSync(homeDir).isDirectory()) {
    warnings.push("任务目录不存在");
    return { homeDir, sessionsFile, warnings };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionsFile, "utf-8");
  } catch {
    warnings.push("无法读取 sessions.json 文件");
    return { homeDir, sessionsFile, warnings };
  }

  try {
    JSON.parse(raw);
  } catch {
    warnings.push("sessions.json 文件损坏，JSON 解析失败");
  }

  return { homeDir, sessionsFile, warnings };
}

export interface SessionSummary {
  id: string;
  agent: string;
  role: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  lastStatus: string | null;
  lastActivityAt: string | null;
  totalTokens: number;
  lastModelId?: string;
  /** True when at least one turn carries vendor usage (r18: 0 tokens on an old session means 未计量, not 没用). */
  hasUsage?: boolean;
  /** Distinct files with recorded changes across the session's turns (r18: the honest did-work signal). */
  changedFiles?: string[];
  /** First line of the orchestrator's dispatch prompt — the task this session worked on (r18). */
  taskTitle?: string;
}

export interface TaskSummary {
  taskId: string;
  status: string;
  startedAtMs: number;
  outputFile: string;
  orphanedAtMs: number | undefined;
  result: StoredTaskResult | undefined;
}

export interface TaskOutputRead {
  taskId: string;
  status: string;
  output: string;
  nextOffset: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readSessionsFile(homeDir: string): BridgeSession[] {
  const sessionsPath = nodePath.join(homeDir, "sessions.json");
  const parsed = readJsonFile(sessionsPath);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is BridgeSession =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === "string",
  );
}

function sumTokens(history: SessionHistoryEntry[]): number {
  let total = 0;
  for (const entry of history) {
    total += entry.usage?.totalTokens ?? 0;
  }
  return total;
}

function findLastRequestedModel(history: SessionHistoryEntry[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const model = history[i]!.requestedModel;
    if (model !== undefined) return model;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Timeline derivation
// ---------------------------------------------------------------------------

const MAX_TASK_LENGTH = 500;

function isWorkerEntry(entry: SessionHistoryEntry): boolean {
  return !!(entry.finalAnswer || entry.summary || entry.evidence || entry.findings);
}

export function buildTimeline(session: BridgeSession): TimelineEntry[] {
  const history = session.history ?? [];
  return history.map((entry) => {
    const base: TimelineEntry = {
      timestamp: entry.timestamp,
      status: entry.status,
      role: entry.role,
      task: entry.task.length > MAX_TASK_LENGTH ? entry.task.slice(0, MAX_TASK_LENGTH) : entry.task,
      from: isWorkerEntry(entry) ? "worker" : "orchestrator",
    };
    // r18: 主模型给组员的完整提示词原文（前端折叠展示，不受 MAX_TASK_LENGTH 截断）。
    if (entry.task.length > MAX_TASK_LENGTH) base.taskFull = entry.task;
    if (entry.summary !== undefined) base.summary = entry.summary;
    if (entry.finalAnswer !== undefined) base.finalAnswer = entry.finalAnswer;
    if (entry.usage !== undefined) base.usage = entry.usage;
    if (entry.requestedModel !== undefined) base.modelId = entry.requestedModel;
    return base;
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Reads all sessions and returns summary records sorted by updatedAt descending. */
export function listSessions(homeDir: string): SessionSummary[] {
  const sessions = readSessionsFile(homeDir);
  return sessions
    .map((s) => {
      const history = s.history ?? [];
      const lastEntry = history.at(-1);
      const lastModelId = findLastRequestedModel(history);
      // r18: the honest did-work signal — distinct files with recorded changes.
      const changedFiles = [
        ...new Set(
          history.flatMap((entry) => {
            const paths = [
              ...(entry.evidence?.repositoryAfter?.changedPaths ?? []),
              ...(entry.evidence?.testFilesModified ?? []),
            ];
            return paths;
          }),
        ),
      ].slice(0, 50);
      const hasUsage = history.some((entry) => entry.usage !== undefined);
      const summary: SessionSummary = {
        id: s.id,
        agent: s.agent,
        role: s.role,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        turnCount: history.length,
        lastStatus: lastEntry?.status ?? null,
        lastActivityAt: lastEntry?.timestamp ?? null,
        totalTokens: sumTokens(history),
        taskTitle: history[0]?.task.split(/\r?\n/)[0]?.slice(0, 60),
        changedFiles: changedFiles.length ? changedFiles : undefined,
        ...(hasUsage ? { hasUsage } : {}),
      };
      if (lastModelId !== undefined) summary.lastModelId = lastModelId;
      return summary;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * r18: groups sessions by project directory (cwd) — one archival group per
 * task/project, newest activity first. Collapsed rendering is the panel's job;
 * this only provides the stable grouping key and per-group aggregates.
 */
export interface ProjectGroup {
  project: string;
  label: string;
  sessions: SessionSummary[];
  totalTokens: number;
  meteredCount: number;
  lastActivityAt: string;
}

export function groupSessionsByProject(sessions: SessionSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const key = session.cwd || "(未知目录)";
    let group = groups.get(key);
    if (!group) {
      const normalized = key.replace(/\\/g, "/");
      const label = normalized.split("/").filter(Boolean).pop() || key;
      group = {
        project: key,
        label,
        sessions: [],
        totalTokens: 0,
        meteredCount: 0,
        lastActivityAt: session.updatedAt,
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.totalTokens += session.totalTokens ?? 0;
    if (session.hasUsage) group.meteredCount++;
    if (new Date(session.updatedAt).getTime() > new Date(group.lastActivityAt).getTime()) {
      group.lastActivityAt = session.updatedAt;
    }
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

/** Returns a single session by id, or undefined if not found. */
export function getSession(homeDir: string, id: string): BridgeSession | undefined {
  const sessions = readSessionsFile(homeDir);
  return sessions.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

function parseRegistryLines(homeDir: string): BackgroundTaskRecord[] {
  const registryPath = nodePath.join(homeDir, "tasks", "registry.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf-8");
  } catch {
    return [];
  }
  const records: BackgroundTaskRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      const c = parsed as Record<string, unknown>;
      if (
        typeof c.taskId === "string" &&
        typeof c.pid === "number" &&
        typeof c.startedAtMs === "number" &&
        typeof c.outputFile === "string"
      ) {
        records.push({
          taskId: c.taskId,
          pid: c.pid,
          startedAtMs: c.startedAtMs,
          outputFile: c.outputFile,
          ...(typeof c.orphanedAtMs === "number" ? { orphanedAtMs: c.orphanedAtMs } : {}),
        });
      }
    } catch {
      // Corrupt lines are skipped — mirrors background.ts readPersistedRecords.
    }
  }
  return records;
}

async function readStoredResult(
  homeDir: string,
  taskId: string,
): Promise<StoredTaskResult | undefined> {
  const resultPath = nodePath.join(homeDir, "tasks", `${taskId}.result.json`);
  const raw = await fsp.readFile(resultPath, "utf-8").catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const c = parsed as Record<string, unknown>;
    if (
      typeof c.taskId === "string" &&
      (c.status === "completed" || c.status === "failed") &&
      typeof c.completedAtMs === "number"
    ) {
      return {
        taskId: c.taskId,
        status: c.status,
        summary: typeof c.summary === "string" ? c.summary : undefined,
        finalAnswer: typeof c.finalAnswer === "string" ? c.finalAnswer : undefined,
        error: typeof c.error === "string" ? c.error : undefined,
        exitCode: typeof c.exitCode === "number" ? c.exitCode : undefined,
        completedAtMs: c.completedAtMs,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derives task status for display. Mirrors BackgroundTaskRegistry.pollOnce in
 * background.ts with one deliberate divergence: a stored terminal result wins
 * over the orphanedAtMs dead-letter marker. The scan that sets the marker
 * keys on owner-pid liveness alone, so a bridge restart after a task already
 * finished leaves completed records carrying the mark; showing those as
 * "interrupted" would mislabel finished work. P-R15-1's own contract defines
 * the dead letter as "owning bridge died without a terminal result", so the
 * result file is the stronger evidence.
 *   1. StoredTaskResult exists → completed/failed
 *   2. orphanedAtMs set (no result) → interrupted
 *   3. No result, pid alive → running
 *   4. No result, pid dead → failed (same as pollOnce)
 */
function deriveTaskStatus(
  record: BackgroundTaskRecord,
  result: StoredTaskResult | undefined,
): string {
  if (result) return result.status;
  if (record.orphanedAtMs !== undefined) return "interrupted";
  return isPidAlive(record.pid) ? "running" : "failed";
}

/** Lists all background tasks with derived status, sorted by startedAtMs descending. */
export async function listTasks(homeDir: string): Promise<TaskSummary[]> {
  const records = parseRegistryLines(homeDir);
  // The registry is append-only and the orphan scan re-appends marked lines,
  // so one taskId can appear multiple times. Keep the last line per taskId and
  // carry over the earliest dead-letter marker so the interruption evidence
  // survives the dedupe.
  const byTaskId = new Map<string, BackgroundTaskRecord>();
  for (const record of records) {
    const existing = byTaskId.get(record.taskId);
    if (existing?.orphanedAtMs !== undefined && record.orphanedAtMs === undefined) {
      byTaskId.set(record.taskId, { ...record, orphanedAtMs: existing.orphanedAtMs });
    } else {
      byTaskId.set(record.taskId, record);
    }
  }
  const summaries: TaskSummary[] = [];
  for (const record of byTaskId.values()) {
    const result = await readStoredResult(homeDir, record.taskId);
    summaries.push({
      taskId: record.taskId,
      status: deriveTaskStatus(record, result),
      startedAtMs: record.startedAtMs,
      outputFile: record.outputFile,
      orphanedAtMs: record.orphanedAtMs,
      result,
    });
  }
  return summaries.sort((a, b) => b.startedAtMs - a.startedAtMs);
}

/** Checks whether a taskId exists in the registry. */
export function taskExists(homeDir: string, taskId: string): boolean {
  const records = parseRegistryLines(homeDir);
  return records.some((r) => r.taskId === taskId);
}

/** Reads a task's output incrementally from a byte offset. */
export async function readTaskOutput(
  homeDir: string,
  taskId: string,
  offset: number,
): Promise<TaskOutputRead> {
  const records = parseRegistryLines(homeDir);
  const record = records.find((r) => r.taskId === taskId);
  if (!record) throw new TaskNotFoundError(taskId);

  const result = await readStoredResult(homeDir, taskId);
  const status = deriveTaskStatus(record, result);

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(record.outputFile, "r");
  } catch {
    // Missing output file degrades to empty output — same as background.ts readOutputRange.
    return { taskId, status, output: "", nextOffset: offset, hasMore: false };
  }
  try {
    const total = (await handle.stat()).size;
    if (offset >= total) {
      return { taskId, status, output: "", nextOffset: offset, hasMore: false };
    }
    const length = Math.min(MAX_POLL_READ_BYTES, total - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      taskId,
      status,
      output: buffer.toString("utf8"),
      nextOffset: offset + bytesRead,
      hasMore: offset + bytesRead < total,
    };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Budget / summary
// ---------------------------------------------------------------------------

export interface BudgetInfo {
  perSessionTokenCap: number;
  maxSessionUsed: number;
  maxSessionId: string;
}

export interface SummaryData {
  sessionCount: number;
  taskCounts: {
    running: number;
    interrupted: number;
    completed: number;
    failed: number;
    stalled: number;
    total: number;
  };
  totalTokens: number;
  lastEventAt: string | null;
  budget: BudgetInfo | null;
  dataHome: string;
}

/** Gathers summary statistics across sessions and tasks. */
export async function getSummary(
  homeDir: string,
  startDir: string | undefined,
): Promise<SummaryData> {
  const sessions = readSessionsFile(homeDir);
  let totalTokens = 0;
  let lastEventAt: string | null = null;

  for (const session of sessions) {
    const history = session.history ?? [];
    for (const entry of history) {
      totalTokens += entry.usage?.totalTokens ?? 0;
      if (entry.timestamp > (lastEventAt ?? "")) {
        lastEventAt = entry.timestamp;
      }
    }
  }

  const tasks = await listTasks(homeDir);
  const taskCounts = {
    running: 0,
    interrupted: 0,
    completed: 0,
    failed: 0,
    stalled: 0,
    total: tasks.length,
  };
  for (const t of tasks) {
    if (t.status === "running") taskCounts.running++;
    else if (t.status === "interrupted") taskCounts.interrupted++;
    else if (t.status === "completed") taskCounts.completed++;
    else if (t.status === "failed") taskCounts.failed++;
    else if (t.status === "stalled") taskCounts.stalled++;
  }

  let budget: BudgetInfo | null = null;
  if (startDir) {
    const loaded = loadProjectConfig(startDir);
    if (loaded?.config.budget?.perSessionTokenCap !== undefined) {
      const cap = loaded.config.budget.perSessionTokenCap;
      let maxUsed = 0;
      let maxSid = "";
      for (const s of sessions) {
        const tokens = sumTokens(s.history ?? []);
        if (tokens > maxUsed) {
          maxUsed = tokens;
          maxSid = s.id;
        }
      }
      budget = { perSessionTokenCap: cap, maxSessionUsed: maxUsed, maxSessionId: maxSid };
    }
  }

  return {
    sessionCount: sessions.length,
    taskCounts,
    totalTokens,
    lastEventAt,
    budget,
    dataHome: homeDir,
  };
}

// ---------------------------------------------------------------------------
// Agent statistics (agent x role aggregation)
// ---------------------------------------------------------------------------

export interface AgentStat {
  agent: string;
  role: string;
  turns: number;
  successCount: number;
  failedCount: number;
  /** successCount / turns, 0-1; 0 when the group has no turns. */
  successRate: number;
  /** Mean of evidence.durationMs across turns that report it; null when none do. */
  avgDurationMs: number | null;
  totalTokens: number;
}

/** Aggregates every session's history turns by (agent, role) pair. */
export function getStats(homeDir: string): AgentStat[] {
  const groups = new Map<
    string,
    {
      agent: string;
      role: string;
      turns: number;
      success: number;
      durations: number[];
      tokens: number;
    }
  >();
  for (const session of readSessionsFile(homeDir)) {
    const history = session.history ?? [];
    const key = `${session.agent}\u0000${session.role}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        agent: session.agent,
        role: session.role,
        turns: 0,
        success: 0,
        durations: [],
        tokens: 0,
      };
      groups.set(key, group);
    }
    for (const entry of history) {
      group.turns++;
      if (entry.status === "success") group.success++;
      if (typeof entry.evidence?.durationMs === "number")
        group.durations.push(entry.evidence.durationMs);
      group.tokens += entry.usage?.totalTokens ?? 0;
    }
  }
  return [...groups.values()]
    .map((g) => ({
      agent: g.agent,
      role: g.role,
      turns: g.turns,
      successCount: g.success,
      failedCount: g.turns - g.success,
      successRate: g.turns === 0 ? 0 : g.success / g.turns,
      avgDurationMs:
        g.durations.length === 0
          ? null
          : Math.round(g.durations.reduce((a, b) => a + b, 0) / g.durations.length),
      totalTokens: g.tokens,
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.role.localeCompare(b.role));
}

// ---------------------------------------------------------------------------
// Task aggregation (r19 → v2: three-level task tree board)
// ---------------------------------------------------------------------------

export interface BoardSubtaskTerminal {
  bgTaskId: string;
  bgStatus: string;
}

export interface BoardReview {
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  checkedAt: string | null;
  conclusion?: string;
  /** Concise human-readable findings (the issues surfaced by the checker). */
  findings: string[];
  /**
   * true = the verdict comes from an inferred checker (no recorded
   * contextSources reference). The UI must render an "inferred" marker.
   */
  inferred?: boolean;
}

export interface BoardUsageSplit {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
}

export interface BoardSubtaskOutput {
  summary?: string;
  finalAnswer?: string;
  status: string;
  finishedAt: string | null;
  /** Distinct files with recorded changes across the session's turns (≤50). */
  changedFiles: string[];
}

export interface BoardMcpCall {
  index: number;
  /** The dispatch parameter (entry.task) sent to the delegated agent. */
  task: string;
  status: string;
  finishedAt: string;
  /** Adjacent-entry time delta, or evidence.durationMs when present. */
  durationMs?: number;
  transport?: string;
  exitCode?: number;
  model?: string;
}

export interface BoardSubtask {
  sessionId: string;
  title: string;
  agent: string;
  model?: string;
  status: "running" | "passed" | "failed" | "pending_review";
  totalTokens: number;
  usageSplit?: BoardUsageSplit;
  instruction: string;
  instructionFull?: string;
  output?: BoardSubtaskOutput;
  /** v3 §7.2: one record per session history entry representing an MCP call. */
  mcpCalls: BoardMcpCall[];
  startedAt: string;
  updatedAt: string;
  terminal: BoardSubtaskTerminal | null;
  review: BoardReview | null;
  /** true = only exists in the background registry as an in-flight live task. */
  live: boolean;
  /**
   * true = attributed to this task by the v6 fallback (round-marker + cwd +
   * nearest time window), not by a recorded contextSources reference. The UI
   * must render an "inferred" badge on such subtasks.
   */
  inferred?: boolean;
}

export type BoardRoleName = "worker" | "reviewer" | "tester";

export interface BoardGroup {
  groupId: string;
  title: string;
  status: "running" | "passed" | "failed" | "pending_review";
  totalTokens: number;
  startedAt: string;
  updatedAt: string;
  /** Buckets keyed by role; empty buckets are omitted. */
  roles: Partial<Record<BoardRoleName, BoardSubtask[]>>;
}

/**
 * The synthesized group that hosts live (not-yet-claimed) background tasks,
 * always placed first in the board's group list (§6.2 rule 5).
 */
const LIVE_GROUP_ID = "__live__";
const LIVE_GROUP_TITLE = "实时任务";

function sessionContextSources(session: BridgeSession): string[] {
  return (session.history ?? []).flatMap((entry) => entry.contextSources ?? []);
}

/**
 * v3 §7.4 dirty-data filter: hides a Bridge Session when it carries no usable
 * evidence of real work — empty history, or every entry is a bare dispatch with
 * no task text and no finalAnswer/summary/evidence. A session that failed but
 * has output evidence (summary/finalAnswer/evidence) in ANY entry — not only the
 * last one — is kept. Live subtasks are never filtered.
 */
function isCleanSession(session: BridgeSession): boolean {
  const history = session.history ?? [];
  if (history.length === 0) return false;
  const anyEvidence = history.some(
    (entry) =>
      (entry.task ?? "").trim() !== "" ||
      entry.finalAnswer !== undefined ||
      entry.summary !== undefined ||
      entry.evidence !== undefined,
  );
  if (!anyEvidence) return false;
  const hasOutputEvidence = history.some(
    (entry) =>
      entry.summary !== undefined ||
      entry.finalAnswer !== undefined ||
      entry.evidence !== undefined,
  );
  const anyFailed = history.some((entry) => entry.status === "failed");
  if (anyFailed && !hasOutputEvidence) return false;
  return true;
}

const STATUS_RANK: Record<BoardSubtask["status"], number> = {
  running: 3,
  failed: 2,
  pending_review: 1,
  passed: 0,
};

/** Sums the per-component token usage across a session's turns; undefined when unmetered. */
function sumUsageSplit(history: SessionHistoryEntry[]): BoardUsageSplit | undefined {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cached = 0;
  let any = false;
  for (const entry of history) {
    const u = entry.usage;
    if (!u) continue;
    any = true;
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    reasoning += u.reasoningOutputTokens ?? 0;
    cached += (u.cachedInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0);
  }
  if (!any) return undefined;
  return { input, output, reasoning, cached };
}

function deriveVerdictFromEntry(e: SessionHistoryEntry): BoardReview["verdict"] {
  if (e.status === "failed") return "FAIL";
  const summary = (e.summary ?? "").slice(0, 200).toUpperCase();
  const finalAnswer = (e.finalAnswer ?? "").slice(0, 200).toUpperCase();
  if (/\bFAIL\b/.test(summary) || /\bFAIL\b/.test(finalAnswer)) return "FAIL";
  if (/\bPASS\b/.test(summary) || /\bPASS\b/.test(finalAnswer)) return "PASS";
  return "UNKNOWN";
}

/**
 * Builds a BoardReview from a checker's own history turn (recorded fact —
 * used both for exact binding and for a checker's self-described conclusion).
 */
function reviewFromEntry(e: SessionHistoryEntry): BoardReview {
  const review: BoardReview = {
    verdict: deriveVerdictFromEntry(e),
    checkedAt: e.timestamp,
    findings: (e.findings ?? []).map((f) => f.issue).filter(Boolean),
  };
  const conclusion = e.summary ?? e.finalAnswer;
  if (conclusion !== undefined) review.conclusion = conclusion;
  return review;
}

/** Latest usable checker turn of a session, or null. */
function latestCheckerTurn(history: SessionHistoryEntry[]): SessionHistoryEntry | null {
  let latest: SessionHistoryEntry | null = null;
  for (const entry of history ?? []) {
    if (entry.status === "success" || entry.status === "failed") {
      if (!latest || entry.timestamp > latest.timestamp) latest = entry;
    }
  }
  return latest;
}

/**
 * Derives the review for a single subtask: the conclusion of checker sessions
 * in the same group whose contextSources reference this subtask's sessionId
 * (VERDICT derivation reuses the v1 rules — §6.2 rule 4).
 */
function deriveSubtaskReview(sessionId: string, taskSessions: BridgeSession[]): BoardReview | null {
  const checkers = taskSessions.filter(
    (s) => s.role === "reviewer" && sessionContextSources(s).includes(sessionId),
  );
  let latestCheck: { ts: string; entry: SessionHistoryEntry } | null = null;
  for (const c of checkers) {
    for (const entry of c.history ?? []) {
      if (entry.status === "success" || entry.status === "failed") {
        if (!latestCheck || entry.timestamp > latestCheck.ts) {
          latestCheck = { ts: entry.timestamp, entry };
        }
      }
    }
  }
  if (!latestCheck) return null;
  return reviewFromEntry(latestCheck.entry);
}

/**
 * v3 §7.2: maps a session's history turns to MCP call records. Each entry is
 * one call: task = the dispatch parameter, status = entry status, timestamp =
 * finishedAt, duration = evidence.durationMs or the delta to the previous
 * entry's timestamp, transport/exitCode from evidence, model from requestedModel.
 */
function buildMcpCalls(history: SessionHistoryEntry[]): BoardMcpCall[] {
  const calls: BoardMcpCall[] = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]!;
    const call: BoardMcpCall = {
      index: i,
      task: entry.task,
      status: entry.status,
      finishedAt: entry.timestamp,
    };
    if (
      typeof entry.evidence?.durationMs === "number" &&
      Number.isFinite(entry.evidence.durationMs)
    ) {
      call.durationMs = entry.evidence.durationMs;
    } else if (i > 0) {
      const prev = new Date(history[i - 1]!.timestamp).getTime();
      const cur = new Date(entry.timestamp).getTime();
      if (Number.isFinite(prev) && Number.isFinite(cur)) {
        const delta = cur - prev;
        if (delta >= 0) call.durationMs = delta;
      }
    }
    if (entry.evidence?.transportUsed !== undefined) call.transport = entry.evidence.transportUsed;
    if (entry.evidence?.exitCode !== undefined) call.exitCode = entry.evidence.exitCode;
    if (entry.requestedModel !== undefined) call.model = entry.requestedModel;
    calls.push(call);
  }
  return calls;
}

/**
 * Builds one subtask from a single Bridge Session (the minimal unit — see
 * ORCHESTRATION.md §6.2 rule 3). `taskSessions` is the group's full session
 * set, used to resolve the review bound to this subtask.
 */
function buildSubtask(session: BridgeSession, taskSessions: BridgeSession[]): BoardSubtask {
  const history = session.history ?? [];
  const lastEntry = history.at(-1);
  const model = findLastRequestedModel(history);

  const firstTask = history[0]?.task ?? "";
  const title = firstTask.split(/\r?\n/)[0]?.slice(0, 60) || session.id;
  const instruction = firstTask;
  const instructionFull = instruction.length > 500 ? instruction : undefined;

  // Output = the last role==="worker" entry of this session.
  let outputEntry: SessionHistoryEntry | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "worker") {
      outputEntry = history[i];
      break;
    }
  }
  const changedFiles = [
    ...new Set(
      history.flatMap((e) => [
        ...(e.evidence?.repositoryAfter?.changedPaths ?? []),
        ...(e.evidence?.testFilesModified ?? []),
      ]),
    ),
  ].slice(0, 50);

  // Worker subtasks carry the conclusion of a contextSources-bound checker
  // (§6.2 rule 4). Checker subtasks describe themselves: their own latest
  // turn IS the recorded review conclusion, so the 检查结论 card fills from
  // it instead of looking for a meta-review that never exists.
  const isChecker = session.role === "reviewer" || session.role === "tester";
  const ownTurn = isChecker ? latestCheckerTurn(history) : null;
  const review = ownTurn ? reviewFromEntry(ownTurn) : deriveSubtaskReview(session.id, taskSessions);
  const checkers = taskSessions.filter(
    (s) => s.role === "reviewer" && sessionContextSources(s).includes(session.id),
  );
  const hasOutput =
    outputEntry !== undefined &&
    (outputEntry.summary !== undefined || outputEntry.finalAnswer !== undefined);

  let status: BoardSubtask["status"];
  if (session.role === "worker") {
    // v1 worker status derivation (§6.2 rule: 沿用现有).
    if (lastEntry?.status === "failed" || review?.verdict === "FAIL") {
      status = "failed";
    } else if (review?.verdict === "PASS") {
      status = "passed";
    } else if (hasOutput && checkers.length === 0) {
      status = "pending_review";
    } else {
      status = "running";
    }
  } else if (lastEntry?.status === "failed") {
    // Reviewer / tester subtask: failed when its own turn failed.
    status = "failed";
  } else if (
    lastEntry !== undefined &&
    (lastEntry.summary !== undefined || lastEntry.finalAnswer !== undefined)
  ) {
    // A concluding reviewer/tester turn counts as done (passed).
    status = "passed";
  } else {
    status = "running";
  }

  const subtask: BoardSubtask = {
    sessionId: session.id,
    title,
    agent: session.agent,
    status,
    totalTokens: sumTokens(history),
    instruction,
    startedAt: session.createdAt,
    updatedAt: session.updatedAt,
    mcpCalls: buildMcpCalls(history),
    terminal: null,
    review,
    live: false,
  };
  if (model !== undefined) subtask.model = model;
  const usageSplit = sumUsageSplit(history);
  if (usageSplit !== undefined) subtask.usageSplit = usageSplit;
  if (instructionFull !== undefined) subtask.instructionFull = instructionFull;
  if (outputEntry) {
    subtask.output = {
      ...(outputEntry.summary !== undefined ? { summary: outputEntry.summary } : {}),
      ...(outputEntry.finalAnswer !== undefined ? { finalAnswer: outputEntry.finalAnswer } : {}),
      status: outputEntry.status ?? lastEntry?.status ?? "running",
      finishedAt: outputEntry.timestamp ?? null,
      changedFiles,
    };
  }
  return subtask;
}

/**
 * Terminal binding for one subtask. v5: when the session carries a stamped
 * `metadata.bgTaskId` (written at background dispatch time), the record with
 * that exact taskId wins — binding by fact. Without a stamp (legacy sessions),
 * fall back to the greedy time-proximity guess: closest startedAtMs to the
 * subtask updatedAt wins.
 */
async function bindTerminal(
  subtask: BoardSubtask,
  terminalPool: BackgroundTaskRecord[],
  claimedTerminals: Set<string>,
  homeDir: string,
  stampedTaskId?: string,
): Promise<void> {
  if (stampedTaskId) {
    const exact = terminalPool.find(
      (rec) => rec.taskId === stampedTaskId && !claimedTerminals.has(rec.taskId),
    );
    if (exact) {
      claimedTerminals.add(exact.taskId);
      const result = await readStoredResult(homeDir, exact.taskId);
      subtask.terminal = { bgTaskId: exact.taskId, bgStatus: deriveTaskStatus(exact, result) };
      return;
    }
  }
  const updatedMs = new Date(subtask.updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return;
  let best: BackgroundTaskRecord | null = null;
  let bestDelta = Infinity;
  for (const rec of terminalPool) {
    if (claimedTerminals.has(rec.taskId)) continue;
    if (!Number.isFinite(rec.startedAtMs)) continue;
    const delta = Math.abs(rec.startedAtMs - updatedMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = rec;
    }
  }
  if (best) {
    claimedTerminals.add(best.taskId);
    const result = await readStoredResult(homeDir, best.taskId);
    subtask.terminal = { bgTaskId: best.taskId, bgStatus: deriveTaskStatus(best, result) };
  }
}

/**
 * v2: builds the three-level task tree board used by /api/board.
 *
 * Aggregation contract (see ORCHESTRATION.md §6 — do not renegotiate):
 *  1. A group (level 1) = a worker anchor + the full contextSources closure
 *     over all sessions (workers/reviewers/testers mixed in, one-to-one dedup via
 *     `usedSessions`).
 *  2. Role folders (level 2) bucket group sessions by role; empty buckets omitted.
 *  3. A subtask (level 3) = a single Bridge Session.
 *  4. Subtask review = the checker-session conclusion bound to that subtask.
 *  5. Group status = worst subtask status rolling running > failed > pending_review > passed.
 *  6. Terminal binding = greedy one-to-one; unclaimed running/interrupted
 *     background records become live:true synthetic subtasks in the first,
 *     synthesized "__live__" group.
 */
export async function buildTaskBoard(homeDir: string): Promise<{
  groups: BoardGroup[];
  dataSource: DataSourceInspection;
}> {
  const allSessions = readSessionsFile(homeDir).filter(isCleanSession);
  const workerSessions = allSessions.filter((s) => s.role === "worker");
  const workerIds = new Set(workerSessions.map((s) => s.id));

  // 1. Anchors: worker sessions whose contextSources contain no other worker id.
  const anchors = workerSessions
    .filter((s) => !sessionContextSources(s).some((id) => workerIds.has(id)))
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        a.id.localeCompare(b.id),
    );

  const registry = parseRegistryLines(homeDir);
  const terminalPool = [...registry];
  const claimedTerminals = new Set<string>();
  const usedSessions = new Set<string>();

  // Collect each group's session set via the growing contextSources closure,
  // then build one subtask per session inside the group.
  const groups: BoardGroup[] = [];
  const groupedSubtasks: BoardSubtask[] = [];

  for (const anchor of anchors) {
    if (usedSessions.has(anchor.id)) continue;

    const taskIds = new Set<string>([anchor.id]);
    const pending = [anchor.id];
    while (pending.length > 0) {
      const refId = pending.shift()!;
      for (const s of allSessions) {
        if (usedSessions.has(s.id) || taskIds.has(s.id)) continue;
        if (!sessionContextSources(s).includes(refId)) continue;
        taskIds.add(s.id);
        pending.push(s.id);
      }
    }

    const taskSessions = allSessions
      .filter((s) => taskIds.has(s.id))
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
          a.id.localeCompare(b.id),
      );

    const subtasks = taskSessions.map((s) => buildSubtask(s, taskSessions));
    // Only worker-owned subtasks participate in greedy terminal binding; a
    // reviewer/tester subtask never claims a background task (§6.1 P2). The
    // subtask array is parallel to taskSessions, so filter by the session role.
    const workerSubtasks = subtasks.filter((_, i) => taskSessions[i]!.role === "worker");
    groupedSubtasks.push(...workerSubtasks);

    // Group bucket by role, omitting empty buckets. The role comes from the
    // owning Bridge Session (the subtask itself does not carry a role field).
    const roles: Partial<Record<BoardRoleName, BoardSubtask[]>> = {};
    const roleMap = new Map(taskSessions.map((s, i) => [subtasks[i]!.sessionId, s.role]));
    for (const sub of subtasks) {
      const role = roleMap.get(sub.sessionId) as BoardRoleName;
      (roles[role] ??= []).push(sub);
    }

    const updatedAt = taskSessions.reduce(
      (latest, s) => (s.updatedAt > latest ? s.updatedAt : latest),
      anchor.updatedAt,
    );
    const totalTokens = subtasks.reduce((acc, s) => acc + s.totalTokens, 0);
    const groupStatus =
      subtasks.map((s) => s.status).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? "running";

    const group: BoardGroup = {
      groupId: anchor.id,
      title: (anchor.history?.[0]?.task ?? "").split(/\r?\n/)[0]?.slice(0, 60) || anchor.id,
      status: groupStatus,
      totalTokens,
      startedAt: anchor.createdAt,
      updatedAt,
      roles,
    };
    groups.push(group);

    for (const id of taskIds) usedSessions.add(id);
  }

  // v6 inferred checker attribution (fallback, always labeled `inferred`):
  // historical reviewer/tester sessions often carry no contextSources because
  // their dispatches never passed contextSessionIds — the closure above cannot
  // see them, so real review work disappears from the board. When such a
  // session shares an explicit round marker (e.g. "v4") with an anchor of the
  // same cwd, attribute it to the marker-matching group whose time window is
  // nearest. This is presented as an inference, never as recorded fact; exact
  // contextSources attribution (rule 4) always wins.
  const normalizePath = (p: string): string =>
    p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const roundMarkers = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const m of text.matchAll(/\b[vV]\d+\b/g)) out.add(m[0].toLowerCase());
    return out;
  };
  const sessionTaskText = (s: (typeof allSessions)[number]): string => s.history?.[0]?.task ?? "";
  const anchorById = new Map(anchors.map((a) => [a.id, a]));

  const unassignedCheckers = allSessions.filter(
    (s) =>
      (s.role === "reviewer" || s.role === "tester") &&
      !usedSessions.has(s.id) &&
      sessionTaskText(s).length > 0,
  );
  for (const checker of unassignedCheckers) {
    const markers = roundMarkers(sessionTaskText(checker));
    if (markers.size === 0) continue;
    const checkerCwd = normalizePath(checker.cwd);
    const checkerMs = new Date(checker.updatedAt).getTime();

    const candidates: { group: BoardGroup; distance: number }[] = [];
    for (const group of groups) {
      const anchor = anchorById.get(group.groupId);
      if (!anchor) continue;
      if (normalizePath(anchor.cwd) !== checkerCwd) continue;
      const anchorMarkers = roundMarkers(sessionTaskText(anchor));
      let shared = false;
      for (const m of markers) {
        if (anchorMarkers.has(m)) {
          shared = true;
          break;
        }
      }
      if (!shared) continue;
      const startMs = new Date(group.startedAt).getTime();
      const endMs = new Date(group.updatedAt).getTime();
      const distance =
        checkerMs < startMs ? startMs - checkerMs : checkerMs > endMs ? checkerMs - endMs : 0;
      candidates.push({ group, distance });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0]!;

    const sub = buildSubtask(checker, [checker]);
    sub.inferred = true;
    (best.group.roles[checker.role] ??= []).push(sub);
    best.group.totalTokens += sub.totalTokens;
    // Membership goes only to the nearest group, but the verdict informs every
    // marker-matching group: a round's review covers all of that round's work,
    // so workers without an exact contextSources-bound review get it too
    // (labeled inferred; with several checkers the latest checkedAt wins).
    if (sub.review) {
      for (const { group } of candidates) {
        for (const worker of group.roles.worker ?? []) {
          const cur = worker.review;
          if (!cur || (cur.inferred && (sub.review.checkedAt ?? "") > (cur.checkedAt ?? ""))) {
            worker.review = { ...sub.review, inferred: true };
          }
        }
      }
    }
    usedSessions.add(checker.id);
  }
  // Group status must reflect the buckets after inferred additions; workers
  // whose status was derived before the inferred review binding get re-ranked.
  for (const group of groups) {
    for (const w of group.roles.worker ?? []) {
      if (w.review?.inferred && w.review.verdict === "FAIL") w.status = "failed";
      else if (w.review?.inferred && w.review.verdict === "PASS") w.status = "passed";
    }
    const all = Object.values(group.roles).flat();
    group.status =
      all.map((s) => s.status).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? "running";
  }

  // v5 terminal binding, two passes: stamped bgTaskIds bind by fact first
  // (across all groups, so a legacy session's greedy guess can never steal a
  // record that belongs to a stamped session); sessions without a stamp then
  // fall back to the old greedy time-proximity rule (§6.2 rule 5).
  const stampedTaskIds = new Map<string, string>();
  for (const s of allSessions) {
    const bg = s.metadata?.bgTaskId;
    if (typeof bg === "string") stampedTaskIds.set(s.id, bg);
  }
  for (const sub of groupedSubtasks) {
    const stamped = stampedTaskIds.get(sub.sessionId);
    if (!stamped) continue;
    await bindTerminal(sub, terminalPool, claimedTerminals, homeDir, stamped);
  }
  for (const sub of groupedSubtasks) {
    if (sub.terminal) continue;
    await bindTerminal(sub, terminalPool, claimedTerminals, homeDir);
  }

  // Any still-unclaimed background record that is running/interrupted becomes a
  // live synthetic subtask — the in-flight "新建任务实时上树" path (§6.2 rule 5).
  const liveSubtasks: BoardSubtask[] = [];
  for (const rec of registry) {
    if (claimedTerminals.has(rec.taskId)) continue;
    const result = await readStoredResult(homeDir, rec.taskId);
    const st = deriveTaskStatus(rec, result);
    if (st !== "running" && st !== "interrupted") continue;
    liveSubtasks.push({
      sessionId: rec.taskId,
      title: "后台任务 " + rec.taskId.slice(0, 12),
      agent: "-",
      status: st === "running" ? "running" : "failed",
      totalTokens: 0,
      instruction: "（执行中，指令将在完成后可见）",
      startedAt: new Date(rec.startedAtMs).toISOString(),
      updatedAt: new Date(rec.startedAtMs).toISOString(),
      mcpCalls: [],
      terminal: { bgTaskId: rec.taskId, bgStatus: st },
      review: null,
      live: true,
    });
  }

  if (liveSubtasks.length) {
    // The synthesized group rolls its status from the live subtasks per the
    // standard priority (running > failed > pending_review > passed) instead of
    // being hardcoded "running" (§6.1 P1).
    const liveStatus =
      liveSubtasks.map((s) => s.status).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ??
      "running";
    groups.unshift({
      groupId: LIVE_GROUP_ID,
      title: LIVE_GROUP_TITLE,
      status: liveStatus,
      totalTokens: 0,
      startedAt: liveSubtasks[0]!.startedAt,
      updatedAt: liveSubtasks[0]!.updatedAt,
      roles: { worker: liveSubtasks },
    });
  }

  return { groups, dataSource: inspectDataSource(homeDir) };
}

// ---------------------------------------------------------------------------
// File access (security-validated by the API layer)
// ---------------------------------------------------------------------------

export interface FileContent {
  path: string;
  content: string;
}

/**
 * Reads a single file. Caller MUST validate the resolved path before calling.
 * Known limitation: a symlink inside homeDir pointing outside it would bypass
 * the traversal guard (path resolution does not follow-and-check links); the
 * agentmesh home only contains bridge-written regular files today, but any
 * future exposure to user-planted content must add realpath containment.
 */
export async function readFile(resolvedPath: string): Promise<FileContent> {
  const stat = await fsp.stat(resolvedPath).catch(() => undefined);
  if (!stat) throw new FileNotFoundError(resolvedPath);
  if (stat.isDirectory()) throw new NotAFileError(resolvedPath);
  const content = await fsp.readFile(resolvedPath, "utf-8");
  return { path: resolvedPath, content };
}

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

export class TaskNotFoundError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Background task '${taskId}' was not found.`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

export class FileNotFoundError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = "FileNotFoundError";
    this.filePath = filePath;
  }
}

export class NotAFileError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`Path is a directory, not a file: ${filePath}`);
    this.name = "NotAFileError";
    this.filePath = filePath;
  }
}
