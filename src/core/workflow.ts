import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type {
  AgentName,
  AgentResult,
  AgentRole,
  ReviewFinding,
  TransportMode,
} from "../agents/types.js";
import type {
  ContinueTaskParams,
  DelegateTaskParams,
  MultiAgentRunner,
  ReviewChangesParams,
} from "./runner.js";
import { executeCommand } from "./executor.js";
import { captureRepositoryState } from "./repository.js";
import { buildReworkFixPrompt } from "./prompts.js";
import { truncateText } from "./text.js";
import {
  ModelHealthStore,
  orderCandidatesByHealth,
  resolveAgentHealthCandidate,
} from "./health.js";
import type { HealthWeightedCandidate } from "./health.js";
import type { ErrorCode } from "./types.js";
import type { BackgroundDispatchService } from "../mcp/tools.js";
import type { StoredTaskResult } from "./background.js";
import {
  defaultStorage,
  homeWorkflowsFilePath,
  ledgerFilePath,
  resolveAgentMeshHome,
} from "./storage.js";
import type { RequirementsFile } from "./requirements.js";
import { buildLedger, needsRuling, pendingRulingIds } from "./ledger.js";
import type { AgentMeshEventBus } from "./events.js";

/**
 * M4 deterministic orchestration state machine (ROADMAP_v0.4 M4).
 *
 * Runs the dispatch → acceptance → review → rework loop entirely in-process,
 * without an external LLM orchestrator and without a nested MCP client:
 * every stage dispatch goes through the same internal service functions the
 * MCP tool handlers use (MultiAgentRunner), launched as background tasks via
 * the existing BackgroundDispatchService so they inherit task-registry
 * persistence, the stalled watchdog, and cancel_task.
 *
 * Waiting is event-driven only: the engine blocks on
 * BackgroundTaskRegistry.waitForActivity (typed bus events + fs.watch on the
 * task output capture) and never sleep-polls on a fixed interval.
 *
 * The declarative spec is JSON-only in v0.4 (no yaml dependency). Workflow
 * state persists as an append-only JSONL log (<agentmeshHome>/workflows.jsonl)
 * following the metrics.jsonl conventions — one snapshot line per state
 * update, last line per workflowId wins, corrupt lines skipped fail-closed.
 */

const MAX_TIMEOUT_MS = 3_600_000;
/** Upper bound for one acceptance command when the spec declares none. */
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 600_000;
/**
 * Deadline guard between event-driven terminal re-checks. waitForActivity is
 * event-driven (bus + fs.watch); this cap only bounds the pathological case
 * where every wake-up source fails — it is not a polling interval.
 */
const TERMINAL_RECHECK_CAP_MS = 30_000;
/** Upstream summary lines injected per upstream stage. */
const MAX_UPSTREAM_SUMMARY_CHARS = 2_000;

const WorkflowRoleSchema = z.enum(["worker", "reviewer", "tester"]);

const StageDispatchSpecSchema = z
  .object({
    agent: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Target agent harness name or alias. When omitted, resolves the assigned role from .agentmesh/config.json",
      ),
    mode: z
      .enum(["auto", "mcp", "cli"])
      .optional()
      .describe("Preferred transport mode for this stage's dispatches ('auto', 'mcp', or 'cli')"),
    taskTemplate: z
      .string()
      .min(1)
      .max(100_000)
      .describe(
        "Task instructions with {{placeholder}} substitution from the stage context: " +
          "{{workflowName}}, {{stageName}}, {{group}} (parallelGroups stages only), " +
          "{{upstreamSummaries}} (joined summaries of the preceding stages)",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe("Execution timeout in milliseconds for this stage's dispatches"),
    contextPolicy: z
      .object({
        contextSessionIds: z
          .union([z.literal("upstream"), z.array(z.string().trim().min(1)).min(1).max(4)])
          .optional()
          .describe(
            '"upstream" injects the Bridge sessions produced by the preceding stages first-hand; ' +
              "an explicit array (max 4) is passed through verbatim",
          ),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Acceptance command: legacy plain string or the v0.5 object with requirement coverage. */
const StageAcceptanceCommandSchema = z.union([
  z.string().trim().min(1).max(4_000),
  z
    .object({
      cmd: z.string().trim().min(1).max(4_000),
      covers: z
        .array(z.string().trim().min(1).max(64))
        .min(1)
        .max(64)
        .optional()
        .describe("Requirement ids (e.g. R1, R3) this command proves — feeds the terminal ledger"),
    })
    .strict(),
]);

const StageAcceptanceSpecSchema = z
  .object({
    commands: z
      .array(StageAcceptanceCommandSchema)
      .min(1)
      .max(10)
      .describe(
        "Shell commands executed sequentially in the target cwd; exit code 0 = pass. " +
          "Each entry is either a plain command string or {cmd, covers:[R...]} declaring " +
          "which requirement ids the command proves (v0.5 reconciliation)",
      ),
    files: z
      .array(z.string().trim().min(1).max(1_000))
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Declared file set: repo-relative paths that must exist after the stage completes. " +
          "Doubles as the lane-triage size signal and the out-of-scope write reference set (v0.5)",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe("Per-command timeout in milliseconds (default 600000)"),
  })
  .strict();

const StagePolicySpecSchema = z
  .object({
    maxReworkRounds: z
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe(
        "Bounded rework loop for reviewer stages: fix rounds after a FAIL verdict (default 0)",
      ),
    escalateOn: z
      .enum(["reviewFail", "acceptanceFail", "any"])
      .optional()
      .describe(
        "Which failure class escalates the workflow (terminal ESCALATED with evidence chain). " +
          "Every other failure class terminates the workflow as FAILED (default 'any')",
      ),
    reRouteOnStall: z
      .boolean()
      .optional()
      .describe(
        "Re-dispatch a stall-classified failure (timeout/watchdog termination) on the next " +
          "health-ordered candidate from the candidate resolver (M2, default false)",
      ),
  })
  .strict();

const StageSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    roles: z
      .array(WorkflowRoleSchema)
      .min(1)
      .max(3)
      .optional()
      .describe(
        "Ordered role declaration for a single-dispatch stage; the first entry is the execution role",
      ),
    parallelGroups: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(16)
      .optional()
      .describe(
        "Mutually-exclusive parallel package names: one concurrent dispatch per name " +
          "(role defaults to worker); {{group}} substitutes the package name in the taskTemplate",
      ),
    /** Requirement ids (R1..Rn) this stage implements — threads requirements through the ledger. */
    requirements: z
      .array(
        z
          .string()
          .trim()
          .regex(/^R\d+$/, "requirement id must match R<number>"),
      )
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Requirement ids this stage implements; every id must exist in the run's requirements set. " +
          "A stage-declared id without covering acceptance command evidence yields a " +
          "PENDING_RULING ledger row (fail-closed)",
      ),
    dispatch: StageDispatchSpecSchema,
    acceptance: StageAcceptanceSpecSchema.optional(),
    policy: StagePolicySpecSchema.optional(),
  })
  .strict();

export const WorkflowSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    stages: z.array(StageSpecSchema).min(1).max(32),
  })
  .strict();

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
export type WorkflowStageSpec = z.infer<typeof StageSpecSchema>;
export type WorkflowStagePolicy = z.infer<typeof StagePolicySpecSchema>;

/** Normalized stage policy after the engine applies its documented defaults. */
type ResolvedStagePolicy = Required<WorkflowStagePolicy>;

/**
 * Terminal workflow status. `needs_ruling` (v0.5) means every stage passed but
 * the reconciliation ledger carries PENDING_RULING rows — the fast lane must
 * not finish quietly with unruled items; the leader rules them and the engine
 * re-emits the ledger to close out as done.
 */
export type WorkflowOverallStatus = "running" | "done" | "needs_ruling" | "escalated" | "failed";

export type WorkflowStageStatus =
  | "pending"
  | "dispatched"
  | "running"
  | "acceptance"
  | "review"
  | "rework"
  | "passed"
  | "escalated"
  | "failed";

export interface WorkflowTaskRecord {
  taskId: string;
  role: AgentRole;
  /** Requested agent key for this dispatch (resolved downstream by the runner). */
  agent?: string;
  /** Parallel package name when the stage declared parallelGroups. */
  group?: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  error?: string;
  errorCode?: string;
  timedOut?: boolean;
  /** Bridge session created by this dispatch (persisted for contextPolicy upstream). */
  sessionId?: string;
  /** Previous agent attempt when this task was re-dispatched after a stall. */
  reroutedFrom?: string;
}

export interface WorkflowAcceptanceCommandRecord {
  command: string;
  ok: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  /** Requirement ids this command proves (v0.5 covers declaration). */
  covers?: string[];
}

export interface WorkflowAcceptanceFileRecord {
  file: string;
  exists: boolean;
}

export interface WorkflowReworkRoundRecord {
  round: number;
  fixStatus: "success" | "failed";
  fixError?: string;
  reviewOutcome: "PASS" | "FAIL" | "UNKNOWN";
  /** Structured findings from the review this round's fix had to resolve. */
  findings: ReviewFinding[];
}

export interface WorkflowStageRecord {
  name: string;
  index: number;
  status: WorkflowStageStatus;
  transitions: Array<{ status: WorkflowStageStatus; at: string }>;
  tasks: WorkflowTaskRecord[];
  acceptance?: {
    commands: WorkflowAcceptanceCommandRecord[];
    files: WorkflowAcceptanceFileRecord[];
    ok?: boolean;
  };
  review?: {
    initialVerdict: "PASS" | "FAIL" | "UNKNOWN";
    /** Structured findings from the initial review dispatch. */
    findings: ReviewFinding[];
    rounds: WorkflowReworkRoundRecord[];
    verdict: "PASS" | "FAIL" | "UNKNOWN";
  };
  /** Bridge session of the successful worker-role dispatch, for rework fix turns. */
  workerSessionId?: string;
  /** All Bridge sessions produced by this stage's successful dispatches (upstream sources). */
  sessionIds: string[];
  error?: string;
  startedAt?: string;
  updatedAt: string;
}

/** Full evidence chain carried by a terminal ESCALATED (and FAILED) workflow. */
export interface WorkflowEvidence {
  outcome: "escalated" | "failed";
  stageName: string;
  reason: string;
  at: string;
  /** Per-rework-round findings from the failing stage's review loop. */
  rounds: WorkflowReworkRoundRecord[];
  acceptance?: WorkflowStageRecord["acceptance"];
  /** Repository diff summary when the stage cwd is a git work tree. */
  repository?: {
    repositoryRoot: string;
    head?: string;
    changedPaths: string[];
    fingerprint?: string;
  };
  finalError?: string;
}

export interface WorkflowSnapshot {
  workflowId: string;
  name: string;
  status: WorkflowOverallStatus;
  stages: WorkflowStageRecord[];
  evidence?: WorkflowEvidence;
  failure?: { stageName: string; reason: string; finalError?: string };
  /** Absolute path of the terminal reconciliation ledger (v0.5, out/ directory). */
  ledgerRef?: string;
  /** Requirement ids still awaiting leader ruling when status is needs_ruling. */
  needsRulingIds?: string[];
  startedAt: string;
  updatedAt: string;
}

/**
 * Internal dispatch seam: the structural subset of MultiAgentRunner the
 * workflow engine needs. Production passes the runner itself (in-process,
 * never a nested MCP client); tests pass a scripted fake.
 */
export interface WorkflowDispatchService {
  delegateTask(params: DelegateTaskParams): Promise<AgentResult>;
  reviewChanges(params: ReviewChangesParams): Promise<AgentResult>;
  continueTask(params: ContinueTaskParams): Promise<AgentResult>;
}

/** Health-ordered candidate chain for a dispatch agent (M2 re-route seam). */
export interface WorkflowCandidateResolver {
  (agent: string): { candidates: Array<{ agent: string }>; warning?: string };
}

export interface WorkflowEngineOptions {
  dispatch: WorkflowDispatchService;
  /** Launch + registry seam; stage dispatches run as its background tasks. */
  background: BackgroundDispatchService;
  /** Target cwd for dispatches and acceptance commands (defaults to process.cwd()). */
  cwd?: string;
  /**
   * AgentMesh home for the workflows.jsonl state log. Defaults to the home
   * derived from the background registry's tasks directory, so tests bound to
   * a temporary registry home are isolated without extra seams.
   */
  homeDir?: string;
  /** M2 seam: returns the health-ordered candidate chain for an agent. */
  candidateResolver?: WorkflowCandidateResolver;
  /**
   * v0.5 requirement set (design §4.2) the terminal ledger reconciles against.
   * Parsed + validated by the caller (MCP handler / CLI); the engine treats it
   * as the row universe. Absent → no ledger is produced (legacy behavior).
   */
  requirements?: RequirementsFile;
  /**
   * v0.5 Tier 1 rule-based archive (design §6): invoked once at workflow
   * terminal with every Bridge session the workflow produced. Best-effort —
   * failures warn on stderr and never change the terminal state.
   */
  archiveSessions?: (params: {
    workflowId: string;
    ledgerRef: string;
    archiveSessionIds: string[];
    keepSessionIds: string[];
  }) => Promise<{ archived: number }>;
  /**
   * P-079 checkpoint resume: a terminal snapshot of a previous run with the
   * same spec name. Stages recorded as `passed` there are copied into this
   * run (tasks, acceptance evidence, review rounds, Bridge sessions) and
   * skipped instead of re-dispatched — the leader-ruling re-close path
   * re-emits the ledger without burning tokens on already-passed stages.
   * Stage names must match one-to-one; unmatched resume stages are ignored.
   */
  resumeSnapshot?: WorkflowSnapshot;
  /** Progress observer (CLI stage printing, tests). */
  onUpdate?: (snapshot: WorkflowSnapshot) => void;
  /**
   * Batch 3 #12 (P-080⑤): in-process event bus for the terminal push. When
   * wired, the engine emits one `workflow.terminal` event (taskId=workflowId)
   * when the run reaches a terminal status, so hosts receive the ending
   * without polling. Best-effort — a missing bus just keeps polling-only.
   */
  eventBus?: AgentMeshEventBus;
}

/**
 * Builds the production candidate resolver from public APIs: the project
 * config's declared candidates chain ordered by the M2 health score.
 */
export function createDefaultCandidateResolver(
  runner: Pick<MultiAgentRunner, "getProjectConfiguration">,
  cwd?: string,
  options: { healthStore?: ModelHealthStore } = {},
): WorkflowCandidateResolver {
  const health = options.healthStore ?? new ModelHealthStore();
  return (agent: string) => {
    const loaded = runner.getProjectConfiguration(cwd ?? process.cwd());
    const metadata = loaded?.config.agents;
    const primary = metadata?.[agent];
    const candidates: HealthWeightedCandidate[] = [
      { key: agent, tier: primary?.tier, costLevel: primary?.costLevel },
    ];
    for (const key of primary?.candidates ?? []) {
      const meta = metadata?.[key];
      candidates.push({ key, tier: meta?.tier, costLevel: meta?.costLevel });
    }
    const snapshot = health.snapshot();
    const ordered = orderCandidatesByHealth({
      candidates,
      referenceTier: primary?.tier,
      healthOf: (key) => {
        const signal = resolveAgentHealthCandidate(snapshot.entries, key);
        return signal ? { score: signal.score, quarantined: signal.quarantined } : undefined;
      },
    });
    return {
      candidates: ordered.candidates.map((candidate) => ({ agent: candidate.key })),
      ...(ordered.warning ? { warning: ordered.warning } : {}),
    };
  };
}

export interface WorkflowSpecParseResult {
  success: boolean;
  issues: string[];
  spec?: WorkflowSpec;
}

/**
 * Parses and validates a raw spec (unknown JSON): schema first, then the
 * cross-field rules the JSON schema cannot express (a stage declares exactly
 * one of roles / parallelGroups). Returns every issue for structured errors.
 */
export function parseWorkflowSpec(input: unknown): WorkflowSpecParseResult {
  const parsed = WorkflowSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const issues: string[] = [];
  for (const stage of parsed.data.stages) {
    if ((stage.roles !== undefined) === (stage.parallelGroups !== undefined)) {
      issues.push(
        `${stage.name}: a stage must declare exactly one of 'roles' or 'parallelGroups'.`,
      );
    }
  }
  if (issues.length > 0) return { success: false, issues };
  return { success: true, issues: [], spec: parsed.data };
}

/** Stage context values available to taskTemplate substitution. */
export interface TaskTemplateContext {
  workflowName: string;
  stageName: string;
  group?: string;
  upstreamSummaries: string;
}

/** Substitutes {{placeholder}} values; unknown placeholders are left intact. */
export function renderTaskTemplate(template: string, context: TaskTemplateContext): string {
  return template
    .replace(/\{\{\s*workflowName\s*\}\}/g, context.workflowName)
    .replace(/\{\{\s*stageName\s*\}\}/g, context.stageName)
    .replace(/\{\{\s*group\s*\}\}/g, context.group ?? "")
    .replace(/\{\{\s*upstreamSummaries\s*\}\}/g, context.upstreamSummaries);
}

/** Stall-classified failures the reRouteOnStall policy may re-dispatch (M2). */
const STALL_CLASSIFIED_ERROR_CODES: readonly ErrorCode[] = ["TIMEOUT"];

/** Normalizes the legacy string | v0.5 {cmd, covers} acceptance command form. */
export function normalizeAcceptanceCommand(command: string | { cmd: string; covers?: string[] }): {
  cmd: string;
  covers?: string[];
} {
  if (typeof command === "string") return { cmd: command };
  return command.covers ? { cmd: command.cmd, covers: [...command.covers] } : { cmd: command.cmd };
}

function isStallClassifiedFailure(result: AgentResult): boolean {
  return (
    result.status === "failed" &&
    (result.timedOut === true ||
      STALL_CLASSIFIED_ERROR_CODES.includes(result.errorCode as ErrorCode))
  );
}

function truncateSummary(summary: string): string {
  return truncateText(summary, MAX_UPSTREAM_SUMMARY_CHARS);
}

/** Resolves the workflows.jsonl path exactly like the metrics file resolution. */
export function resolveWorkflowFilePath(homeDir?: string): string {
  return homeWorkflowsFilePath(homeDir ?? resolveAgentMeshHome());
}

function appendWorkflowSnapshot(snapshot: WorkflowSnapshot, homeDir: string | undefined): boolean {
  const filePath = resolveWorkflowFilePath(homeDir);
  try {
    defaultStorage.appendLine(filePath, JSON.stringify(snapshot), { store: "workflows" });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `AgentMesh workflow state could not be appended to '${filePath}': ${message}\n`,
    );
    return false;
  }
}

const WORKFLOW_STATUSES: readonly WorkflowOverallStatus[] = [
  "running",
  "done",
  "needs_ruling",
  "escalated",
  "failed",
];

/**
 * Narrows one raw JSONL line into a WorkflowSnapshot. Returns undefined for
 * malformed lines; corrupt lines are skipped by the caller, never fatal.
 * Deep fields are persisted only by this module, so a top-level shape check
 * plus the documented boundary cast keeps the reader honest without
 * re-validating the full tree.
 */
function parseWorkflowSnapshotLine(line: string): WorkflowSnapshot | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const workflowId = candidate.workflowId;
    const status = candidate.status;
    const name = candidate.name;
    if (
      typeof workflowId !== "string" ||
      typeof name !== "string" ||
      !WORKFLOW_STATUSES.includes(status as WorkflowOverallStatus) ||
      !Array.isArray(candidate.stages)
    ) {
      return undefined;
    }
    // Boundary cast: the log is written exclusively by appendWorkflowSnapshot
    // from typed snapshots; the check above guards against corrupt/truncated
    // lines from a crashed append.
    return parsed as WorkflowSnapshot;
  } catch {
    return undefined;
  }
}

/** Reads every persisted workflow snapshot (last-line-per-id wins upstream). */
export function readPersistedWorkflowSnapshots(
  options: { homeDir?: string; filePath?: string } = {},
): WorkflowSnapshot[] {
  const filePath = options.filePath ?? resolveWorkflowFilePath(options.homeDir);
  try {
    return defaultStorage.readJsonLines(filePath, parseWorkflowSnapshotLine, (corruptPath) => {
      process.stderr.write(
        `AgentMesh workflow state '${corruptPath}' contains a corrupt line; it was skipped.\n`,
      );
    });
  } catch {
    return [];
  }
}

/** Latest persisted snapshot for one workflowId (survives process restarts). */
export function readPersistedWorkflowSnapshot(
  workflowId: string,
  options: { homeDir?: string; filePath?: string } = {},
): WorkflowSnapshot | undefined {
  let latest: WorkflowSnapshot | undefined;
  for (const record of readPersistedWorkflowSnapshots(options)) {
    if (record.workflowId === workflowId) latest = record;
  }
  return latest;
}

/** In-process registry of running/finished engines for the MCP tools. */
export class WorkflowEngineRegistry {
  private readonly engines = new Map<string, WorkflowEngine>();

  public create(spec: WorkflowSpec, options: WorkflowEngineOptions): WorkflowEngine {
    const engine = new WorkflowEngine(spec, options);
    this.engines.set(engine.id, engine);
    return engine;
  }

  public get(workflowId: string): WorkflowEngine | undefined {
    return this.engines.get(workflowId);
  }
}

type DispatchKind = "delegate" | "review" | "continue";

interface DispatchRequest {
  kind: DispatchKind;
  role: AgentRole;
  agent?: string;
  task: string;
  contextSessionIds?: string[];
  continueSessionId?: string;
  group?: string;
  timeoutMs?: number;
  mode?: TransportMode;
  /** Agent attempted before this dispatch when re-routed after a stall (M2). */
  reroutedFrom?: string;
}

/**
 * One workflow execution. See the module doc for the design contract; the
 * engine never throws from run() — every failure becomes a terminal
 * ESCALATED/FAILED snapshot with the evidence chain attached.
 */
export class WorkflowEngine {
  readonly id: string;
  private readonly spec: WorkflowSpec;
  private readonly options: WorkflowEngineOptions;
  private readonly stageRecords: WorkflowStageRecord[];
  private readonly homeDir: string | undefined;
  private dispatchSeq = 0;
  private overall: WorkflowOverallStatus = "running";
  private evidence?: WorkflowEvidence;
  private failure?: { stageName: string; reason: string; finalError?: string };
  private startedAt = new Date().toISOString();
  private updatedAt = this.startedAt;
  private runPromise?: Promise<WorkflowSnapshot>;
  private currentStageIndex = 0;
  private ledgerRef?: string;
  private needsRulingIds?: string[];
  private terminalPushed = false;

  constructor(spec: WorkflowSpec, options: WorkflowEngineOptions) {
    this.spec = spec;
    this.options = options;
    this.id = `wf_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const resumeByName =
      options.resumeSnapshot && options.resumeSnapshot.name === spec.name
        ? new Map(options.resumeSnapshot.stages.map((stage) => [stage.name, stage]))
        : undefined;
    this.stageRecords = spec.stages.map((stage, index) => {
      const record: WorkflowStageRecord = {
        name: stage.name,
        index,
        status: "pending",
        transitions: [{ status: "pending", at: new Date().toISOString() }],
        tasks: [],
        sessionIds: [],
        updatedAt: new Date().toISOString(),
      };
      const resumed = resumeByName?.get(stage.name);
      if (resumed && resumed.status === "passed") {
        // P-079: inherit the completed stage wholesale — task records point at
        // the previous run's task ids (kept as evidence pointers), and the
        // Bridge sessions stay available for upstream context and rework.
        record.status = "passed";
        record.transitions.push({ status: "passed", at: resumed.updatedAt });
        record.tasks = resumed.tasks.map((task) => ({ ...task }));
        record.sessionIds = [...resumed.sessionIds];
        record.acceptance = resumed.acceptance
          ? {
              commands: resumed.acceptance.commands.map((command) => ({ ...command })),
              files: resumed.acceptance.files.map((file) => ({ ...file })),
              ...(resumed.acceptance.ok !== undefined ? { ok: resumed.acceptance.ok } : {}),
            }
          : undefined;
        record.review = resumed.review
          ? {
              ...resumed.review,
              rounds: resumed.review.rounds.map((round) => ({ ...round })),
            }
          : undefined;
        record.workerSessionId = resumed.workerSessionId;
        record.startedAt = resumed.startedAt;
        record.updatedAt = resumed.updatedAt;
      }
      return record;
    });
    this.homeDir =
      options.homeDir ??
      // Derive the AgentMesh home from the background registry's tasks dir so
      // engines wired to an isolated test registry persist in the same home.
      path.dirname(path.resolve(options.background.registry.tasksDirectory));
  }

  /** Starts (or joins) the workflow execution; resolves with the terminal snapshot. */
  public run(): Promise<WorkflowSnapshot> {
    this.runPromise ??= this.execute();
    return this.runPromise;
  }

  private readonly updateWaiters = new Set<() => void>();

  /**
   * Event-driven long-poll seam for get_workflow: resolves with the current
   * snapshot on the next state update, or after maxMs elapses. Terminal
   * workflows return immediately — there is nothing left to wait for.
   */
  public async waitForUpdate(maxMs: number): Promise<WorkflowSnapshot> {
    if (this.overall !== "running" || maxMs <= 0) return this.snapshot();
    let waiter!: () => void;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.updateWaiters.delete(waiter);
        resolve();
      }, maxMs);
      timer.unref?.();
      waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this.updateWaiters.add(waiter);
    });
    return this.snapshot();
  }

  public snapshot(): WorkflowSnapshot {
    return {
      workflowId: this.id,
      name: this.spec.name,
      status: this.overall,
      stages: this.stageRecords.map((stage) => ({
        ...stage,
        tasks: stage.tasks.map((task) => ({ ...task })),
        transitions: stage.transitions.map((transition) => ({ ...transition })),
        ...(stage.acceptance
          ? {
              acceptance: {
                commands: stage.acceptance.commands.map((command) => ({ ...command })),
                files: stage.acceptance.files.map((file) => ({ ...file })),
                ...(stage.acceptance.ok !== undefined ? { ok: stage.acceptance.ok } : {}),
              },
            }
          : {}),
        ...(stage.review
          ? {
              review: {
                ...stage.review,
                rounds: stage.review.rounds.map((round) => ({ ...round })),
              },
            }
          : {}),
      })),
      ...(this.evidence ? { evidence: this.evidence } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.ledgerRef ? { ledgerRef: this.ledgerRef } : {}),
      ...(this.needsRulingIds ? { needsRulingIds: [...this.needsRulingIds] } : {}),
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
    };
  }

  private async execute(): Promise<WorkflowSnapshot> {
    try {
      for (const [index, stageSpec] of this.spec.stages.entries()) {
        const record = this.stageRecords[index]!;
        // P-079 resume: stages inherited as `passed` from the resumed snapshot
        // are skipped — no dispatch, no acceptance re-run, sessions preserved.
        if (record.status === "passed") continue;
        const outcome = await this.runStage(stageSpec, record);
        if (outcome !== "passed") break;
      }
      if (this.overall === "running") this.overall = "done";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.overall = "failed";
      const current = this.stageRecords.find(
        (stage) => !["passed", "failed", "escalated"].includes(stage.status),
      );
      this.failure = {
        stageName: current?.name ?? this.spec.stages[0]?.name ?? "(unknown)",
        reason: "Unexpected engine failure; the stage loop aborted.",
        finalError: message,
      };
    }
    await this.finalizeTerminal();
    this.updatedAt = new Date().toISOString();
    this.persistAndNotify();
    return this.snapshot();
  }

  /**
   * v0.5 terminal join (runs for every terminal status): builds the
   * reconciliation ledger, persists it under <agentmeshHome>/out/, flips
   * done → needs_ruling when unruled rows remain (fail-closed), and invokes
   * the Tier 1 rule-based session archive. Best-effort by contract: ledger or
   * archive I/O failures warn on stderr and never change the terminal status.
   */
  private async finalizeTerminal(): Promise<void> {
    const requirements = this.options.requirements;
    if (requirements) {
      const ledger = buildLedger({
        workflowId: this.id,
        spec: this.spec,
        snapshot: this.snapshot(),
        requirements,
        nowIso: new Date().toISOString(),
      });
      const filePath = ledgerFilePath(this.homeDir ?? resolveAgentMeshHome(), this.id);
      try {
        defaultStorage.writeJsonAtomic(filePath, ledger, { store: "workflows" });
        this.ledgerRef = filePath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `AgentMesh reconciliation ledger could not be written to '${filePath}': ${message}\n`,
        );
      }
      if (this.overall === "done" && needsRuling(ledger)) {
        this.overall = "needs_ruling";
        this.needsRulingIds = pendingRulingIds(ledger);
      }
    }
    await this.archiveWorkflowSessions();
  }

  /** Tier 1 rule-based archive across the workflow's produced sessions. */
  private async archiveWorkflowSessions(): Promise<void> {
    const archive = this.options.archiveSessions;
    if (!archive) return;
    const allSessionIds = [...new Set(this.stageRecords.flatMap((stage) => stage.sessionIds))];
    if (allSessionIds.length === 0) return;
    const lastStageWithSessions = [...this.stageRecords]
      .reverse()
      .find((stage) => stage.sessionIds.length > 0);
    const keep = new Set(lastStageWithSessions?.sessionIds ?? []);
    const archiveSessionIds = allSessionIds.filter((id) => !keep.has(id));
    if (archiveSessionIds.length === 0) return;
    try {
      await archive({
        workflowId: this.id,
        // With a requirements set the placeholder points at the terminal
        // ledger; without one it points at the persisted workflow state log.
        ledgerRef: this.ledgerRef ?? `workflows.jsonl#${this.id}`,
        archiveSessionIds,
        keepSessionIds: [...keep],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `AgentMesh Tier 1 session archive failed for workflow '${this.id}': ${message}\n`,
      );
    }
  }

  private persistAndNotify(): void {
    this.updatedAt = new Date().toISOString();
    appendWorkflowSnapshot(this.snapshot(), this.homeDir);
    this.options.onUpdate?.(this.snapshot());
    // Batch 3 #12 (P-080⑤): terminal push, emitted exactly once per run —
    // finalizeTerminal flips overall before persisting, so the first
    // persistAndNotify with a non-running overall is the terminal signal.
    if (this.overall !== "running" && !this.terminalPushed) {
      this.terminalPushed = true;
      this.options.eventBus?.emit({
        type: "workflow.terminal",
        taskId: this.id,
        status: this.overall,
      });
    }
    for (const waiter of this.updateWaiters) waiter();
    this.updateWaiters.clear();
  }

  private transitionStage(record: WorkflowStageRecord, status: WorkflowStageStatus): void {
    record.status = status;
    record.transitions.push({ status, at: new Date().toISOString() });
    if (record.startedAt === undefined) record.startedAt = new Date().toISOString();
    this.persistAndNotify();
  }

  /** Resolves the contextSessionIds for a stage dispatch per its contextPolicy. */
  private resolveContextSessionIds(stageSpec: WorkflowStageSpec): string[] | undefined {
    const policy = stageSpec.dispatch.contextPolicy?.contextSessionIds;
    if (policy === undefined) return undefined;
    if (policy !== "upstream") return [...policy];
    const upstream = this.stageRecords
      .filter((stage) => stage.index < this.currentStageIndex)
      .flatMap((stage) => stage.sessionIds);
    return upstream.length > 0 ? upstream.slice(-4) : undefined;
  }

  private upstreamSummaries(): string {
    const lines = this.stageRecords
      .filter((stage) => stage.index < this.currentStageIndex && stage.tasks.length > 0)
      .map((stage) => {
        const summary = [...stage.tasks].reverse().find((task) => task.summary)?.summary;
        return summary ? `- ${stage.name}: ${truncateSummary(summary)}` : undefined;
      })
      .filter((line): line is string => line !== undefined);
    return lines.join("\n");
  }

  private workerSessionIdForRework(): string | undefined {
    for (let index = this.currentStageIndex - 1; index >= 0; index -= 1) {
      const workerSessionId = this.stageRecords[index]?.workerSessionId;
      if (workerSessionId) return workerSessionId;
    }
    return undefined;
  }

  /**
   * Event-driven terminal wait: writeStoredResult persists the result file
   * before emitting, so re-checking after each event-driven wake covers both
   * orderings without any fixed-interval polling.
   */
  private async awaitTerminalResult(taskId: string): Promise<void> {
    while (!(await this.options.background.registry.readStoredResult(taskId))) {
      await this.options.background.registry.waitForActivity(taskId, TERMINAL_RECHECK_CAP_MS);
    }
  }

  /**
   * Runs one dispatch as a background task through the same launch path the
   * MCP handlers use (registry persistence, watchdog, cancel_task) and
   * resolves with the full AgentResult captured from the run callback.
   */
  private async runDispatchTask(
    record: WorkflowStageRecord,
    request: DispatchRequest,
  ): Promise<AgentResult> {
    this.dispatchSeq += 1;
    const taskId = `${this.id}_s${record.index}_${this.dispatchSeq}`;
    const outputFile = this.options.background.registry.outputFilePath(taskId);
    const taskRecord: WorkflowTaskRecord = {
      taskId,
      role: request.role,
      status: "running",
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.group ? { group: request.group } : {}),
      ...(request.reroutedFrom ? { reroutedFrom: request.reroutedFrom } : {}),
    };
    record.tasks.push(taskRecord);
    this.persistAndNotify();

    const captured: { result?: AgentResult } = {};
    this.options.background.registry.registerTask({
      taskId,
      pid: process.pid,
      startedAtMs: Date.now(),
      outputFile,
    });
    this.options.background.launch({
      taskId,
      outputFile,
      run: async (signal) => {
        const result = await this.invokeDispatch(request, signal, { taskId, outputFile });
        captured.result = result;
        return result;
      },
    });
    await this.awaitTerminalResult(taskId);
    const stored = await this.options.background.registry.readStoredResult(taskId);
    const result = captured.result ?? reconstructResultFromStored(request, stored);

    taskRecord.status =
      result.status === "success" || result.reviewOutcome !== undefined ? "completed" : "failed";
    taskRecord.summary = result.summary;
    if (result.error) taskRecord.error = result.error;
    if (result.errorCode) taskRecord.errorCode = result.errorCode;
    if (result.timedOut) taskRecord.timedOut = true;
    if (result.sessionId) {
      taskRecord.sessionId = result.sessionId;
      if (result.status === "success") record.sessionIds.push(result.sessionId);
    }
    if (request.role === "worker" && result.status === "success" && result.sessionId) {
      record.workerSessionId = result.sessionId;
    }
    this.persistAndNotify();
    return result;
  }

  private invokeDispatch(
    request: DispatchRequest,
    signal: AbortSignal,
    activity: { taskId: string; outputFile: string },
  ): Promise<AgentResult> {
    const dispatch = this.options.dispatch;
    switch (request.kind) {
      case "review":
        return dispatch.reviewChanges({
          agent: request.agent,
          task: request.task,
          cwd: this.options.cwd,
          mode: request.mode,
          timeoutMs: request.timeoutMs,
          contextSessionIds: request.contextSessionIds,
          // The workflow owns the rework loop; every review dispatch is single-pass.
          maxReworkRounds: 0,
          signal,
        });
      case "continue":
        return dispatch.continueTask({
          sessionId: request.continueSessionId!,
          task: request.task,
          mode: request.mode,
          timeoutMs: request.timeoutMs,
          signal,
        });
      case "delegate":
        return dispatch.delegateTask({
          agent: request.agent,
          task: request.task,
          cwd: this.options.cwd,
          role: request.role,
          mode: request.mode,
          timeoutMs: request.timeoutMs,
          contextSessionIds: request.contextSessionIds,
          signal,
          // Same stamp the background delegate path uses: tees vendor output to
          // the task capture file, feeds the stalled watchdog, registers the
          // child pid for cancel/process-tree discipline, and binds the stage
          // task id into the session metadata for the visual board.
          taskActivity: activity,
        });
    }
  }

  /**
   * Stall handling (M2 + watchdog): a stall-classified dispatch failure with
   * reRouteOnStall is re-dispatched on the next health-ordered candidate.
   * Candidates already tried are excluded; the candidate chain bounds the loop.
   */
  private async dispatchWithReRoute(
    record: WorkflowStageRecord,
    request: DispatchRequest,
    policy: ResolvedStagePolicy,
  ): Promise<AgentResult> {
    const tried = new Set<string>();
    let agent = request.agent;
    let previousAgent: string | undefined;
    for (;;) {
      const result = await this.runDispatchTask(record, {
        ...request,
        ...(agent !== undefined ? { agent } : {}),
        ...(previousAgent !== undefined ? { reroutedFrom: previousAgent } : {}),
      });
      if (!isStallClassifiedFailure(result) || !policy.reRouteOnStall) return result;
      if (agent !== undefined) tried.add(agent);
      const next = this.nextCandidate(request.agent, tried);
      if (!next) return result;
      previousAgent = agent;
      agent = next;
    }
  }

  private nextCandidate(primaryAgent: string | undefined, tried: Set<string>): string | undefined {
    if (!primaryAgent || !this.options.candidateResolver) return undefined;
    const chain = this.options.candidateResolver(primaryAgent);
    return chain.candidates.find((candidate) => !tried.has(candidate.agent))?.agent;
  }

  private async runStage(
    stageSpec: WorkflowStageSpec,
    record: WorkflowStageRecord,
  ): Promise<"passed" | "escalated" | "failed"> {
    this.currentStageIndex = record.index;
    const policy: ResolvedStagePolicy = {
      maxReworkRounds: 0,
      escalateOn: "any",
      reRouteOnStall: false,
      ...stageSpec.policy,
    };
    const role: AgentRole = stageSpec.roles?.[0] ?? "worker";
    const contextSessionIds = this.resolveContextSessionIds(stageSpec);

    this.transitionStage(record, "dispatched");
    this.transitionStage(record, "running");

    const groups = stageSpec.parallelGroups ?? [undefined];
    // parallelGroups dispatches run concurrently (mutually-exclusive packages);
    // a rejected dispatch degrades to a failed AgentResult so the stage-failure
    // path keeps its per-stage attribution instead of aborting the whole loop.
    const settled = await Promise.allSettled(
      groups.map((group) => {
        const task = renderTaskTemplate(stageSpec.dispatch.taskTemplate, {
          workflowName: this.spec.name,
          stageName: stageSpec.name,
          ...(group !== undefined ? { group } : {}),
          upstreamSummaries: this.upstreamSummaries(),
        });
        const request: DispatchRequest = {
          // Reviewer stages must go through reviewChanges: only that path sets
          // the strict fail-closed verdict contract the review loop depends on.
          kind: role === "reviewer" ? "review" : "delegate",
          role,
          task,
          ...(stageSpec.dispatch.agent ? { agent: stageSpec.dispatch.agent } : {}),
          ...(stageSpec.dispatch.mode ? { mode: stageSpec.dispatch.mode } : {}),
          ...(contextSessionIds ? { contextSessionIds } : {}),
          ...(group !== undefined ? { group } : {}),
          ...(stageSpec.dispatch.timeoutMs !== undefined
            ? { timeoutMs: stageSpec.dispatch.timeoutMs }
            : {}),
        };
        return this.dispatchWithReRoute(record, request, policy);
      }),
    );
    const results: AgentResult[] = settled.map((entry) => {
      if (entry.status === "fulfilled") return entry.value;
      const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      return {
        status: "failed" as const,
        agent: (stageSpec.dispatch.agent ?? "unknown") as AgentName,
        summary: `Stage dispatch threw: ${message}`,
        output: "",
        error: message,
      };
    });

    // A FAIL verdict from the review contract arrives as a failed RESULT
    // (reviewChanges fails closed on explicit FAIL) — that is a completed
    // review execution, never a dispatch failure. Only a failure without a
    // parsed verdict is a genuine dispatch failure for reviewer stages.
    const failedDispatch = results.find(
      (result) =>
        result.status === "failed" && (role !== "reviewer" || result.reviewOutcome === undefined),
    );
    if (failedDispatch) {
      return this.terminateStage(record, policy, {
        reason: `Stage dispatch failed: ${failedDispatch.error || failedDispatch.summary}`,
        finalError: failedDispatch.error ?? failedDispatch.summary,
        failureClass: "dispatch",
      });
    }

    if (stageSpec.acceptance) {
      this.transitionStage(record, "acceptance");
      const acceptance = await this.runAcceptance(stageSpec);
      record.acceptance = acceptance;
      this.persistAndNotify();
      if (!acceptance.ok) {
        const failed = acceptance.commands.find((command) => !command.ok);
        const missing = acceptance.files.find((file) => !file.exists);
        return this.terminateStage(record, policy, {
          reason: missing
            ? `Acceptance failed: required file '${missing.file}' does not exist.`
            : `Acceptance command failed: ${failed?.command ?? "(unknown)"}`,
          finalError: failed
            ? `exit ${failed.exitCode ?? "unknown"}${failed.timedOut ? " (timed out)" : ""}\nstdout:\n${failed.stdout}\nstderr:\n${failed.stderr}`
            : undefined,
          failureClass: "acceptance",
        });
      }
    }

    if (role === "reviewer") {
      this.transitionStage(record, "review");
      const outcome = await this.runReviewStage(
        stageSpec,
        record,
        policy,
        results[0]!,
        contextSessionIds,
      );
      if (outcome !== "passed") {
        return this.terminateStage(record, policy, {
          reason:
            outcome === "roundsExhausted"
              ? `Review still FAIL after ${policy.maxReworkRounds} rework round(s).`
              : "Review did not return a PASS verdict.",
          finalError: results[0]!.error ?? results[0]!.summary,
          failureClass: "review",
        });
      }
    }

    this.transitionStage(record, "passed");
    return "passed";
  }

  /** Runs the reviewer-stage review + bounded rework loop. */
  private async runReviewStage(
    stageSpec: WorkflowStageSpec,
    record: WorkflowStageRecord,
    policy: ResolvedStagePolicy,
    initialReview: AgentResult,
    contextSessionIds: string[] | undefined,
  ): Promise<"passed" | "roundsExhausted" | "unresolved"> {
    const review = {
      initialVerdict: initialReview.reviewOutcome ?? ("UNKNOWN" as const),
      findings: initialReview.findings ?? [],
      rounds: [] as WorkflowReworkRoundRecord[],
      verdict: initialReview.reviewOutcome ?? ("UNKNOWN" as const),
    };
    record.review = review;
    this.persistAndNotify();
    if (review.verdict === "PASS") return "passed";
    if (review.verdict !== "FAIL") return "unresolved";

    let current = initialReview;
    const workerSessionId = this.workerSessionIdForRework();
    const maxRounds = Math.min(Math.max(policy.maxReworkRounds, 0), 3);
    for (let round = 1; round <= maxRounds; round += 1) {
      this.transitionStage(record, "rework");
      const roundRecord: WorkflowReworkRoundRecord = {
        round,
        fixStatus: "failed",
        reviewOutcome: "UNKNOWN",
        findings: current.findings ?? [],
      };
      review.rounds.push(roundRecord);
      this.persistAndNotify();

      if (!workerSessionId) {
        roundRecord.fixError =
          "No worker session was recorded by a preceding worker stage; findings cannot be re-injected.";
        break;
      }
      const fix = await this.runDispatchTask(record, {
        kind: "continue",
        role: "worker",
        continueSessionId: workerSessionId,
        // The existing rework prompt path (same builder the runner's loop uses).
        task: buildReworkFixPrompt({
          round,
          maxRounds,
          findings: current.findings ?? [],
          reviewSummary: current.summary,
        }),
        ...(stageSpec.dispatch.mode ? { mode: stageSpec.dispatch.mode } : {}),
        ...(stageSpec.dispatch.timeoutMs !== undefined
          ? { timeoutMs: stageSpec.dispatch.timeoutMs }
          : {}),
      });
      roundRecord.fixStatus = fix.status;
      if (fix.status !== "success") {
        roundRecord.fixError = fix.error ?? fix.summary;
        break;
      }

      const reReview = await this.runDispatchTask(record, {
        kind: "review",
        role: "reviewer",
        task: `Re-review (rework round ${round} of ${maxRounds}): the worker reports the previous findings have been fixed. Re-run the full review against the current working tree.`,
        ...(stageSpec.dispatch.agent ? { agent: stageSpec.dispatch.agent } : {}),
        ...(stageSpec.dispatch.mode ? { mode: stageSpec.dispatch.mode } : {}),
        ...(contextSessionIds ? { contextSessionIds } : {}),
        ...(stageSpec.dispatch.timeoutMs !== undefined
          ? { timeoutMs: stageSpec.dispatch.timeoutMs }
          : {}),
      });
      roundRecord.reviewOutcome = reReview.reviewOutcome ?? "UNKNOWN";
      review.verdict = roundRecord.reviewOutcome;
      this.persistAndNotify();
      if (review.verdict === "PASS") return "passed";
      if (review.verdict !== "FAIL") return "unresolved";
      current = reReview;
    }
    // Loop exit is only reachable with verdict still FAIL: PASS and UNKNOWN
    // return inside the loop, and every break keeps the entering FAIL verdict.
    return "roundsExhausted";
  }

  /** Runs acceptance commands + file checks sequentially in the target cwd. */
  private async runAcceptance(
    stageSpec: WorkflowStageSpec,
  ): Promise<NonNullable<WorkflowStageRecord["acceptance"]>> {
    const acceptance = stageSpec.acceptance!;
    const commands: WorkflowAcceptanceCommandRecord[] = [];
    let ok = true;
    for (const command of acceptance.commands) {
      const normalized = normalizeAcceptanceCommand(command);
      const result = await executeCommand(normalized.cmd, [], {
        cwd: this.options.cwd,
        shell: true,
        timeoutMs: acceptance.timeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
      });
      const commandOk = result.exitCode === 0 && !result.timedOut;
      ok = ok && commandOk;
      commands.push({
        command: normalized.cmd,
        ok: commandOk,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(normalized.covers ? { covers: normalized.covers } : {}),
      });
    }
    const files: WorkflowAcceptanceFileRecord[] = (acceptance.files ?? []).map((file) => ({
      file,
      exists: fs.existsSync(
        path.isAbsolute(file) ? file : path.join(this.options.cwd ?? process.cwd(), file),
      ),
    }));
    ok = ok && files.every((file) => file.exists);
    return { commands, files, ok };
  }

  /**
   * Terminal stage failure: escalates or fails per escalateOn, attaches the
   * full evidence chain (stage history, per-round findings, acceptance
   * command outputs, repository diff summary, final error) and stops the loop.
   */
  private async terminateStage(
    record: WorkflowStageRecord,
    policy: ResolvedStagePolicy,
    info: {
      reason: string;
      finalError?: string;
      failureClass: "dispatch" | "acceptance" | "review";
    },
  ): Promise<"escalated" | "failed"> {
    const escalates =
      policy.escalateOn === "any" ||
      (policy.escalateOn === "reviewFail" && info.failureClass === "review") ||
      (policy.escalateOn === "acceptanceFail" && info.failureClass === "acceptance");
    record.error = info.finalError ?? info.reason;
    if (escalates) {
      // Attach the evidence chain BEFORE flipping overall terminal: the
      // repository capture below awaits, and waitForUpdate returns fast for
      // any non-running overall — a terminal flip must never be observable
      // with an incomplete snapshot. Best-effort diff summary of the working
      // tree the stage ran in (undefined outside a git work tree); never
      // masks the failure itself.
      const captured = await captureRepositoryState(this.options.cwd ?? process.cwd());
      const repository = captured
        ? {
            repositoryRoot: captured.repositoryRoot,
            ...(captured.head ? { head: captured.head } : {}),
            changedPaths: captured.changedPaths,
            ...(captured.fingerprint ? { fingerprint: captured.fingerprint } : {}),
          }
        : undefined;
      this.evidence = {
        outcome: "escalated",
        stageName: record.name,
        reason: info.reason,
        at: new Date().toISOString(),
        rounds: record.review?.rounds ?? [],
        ...(record.acceptance ? { acceptance: record.acceptance } : {}),
        ...(repository ? { repository } : {}),
        ...(info.finalError ? { finalError: info.finalError } : {}),
      };
      this.overall = "escalated";
      this.transitionStage(record, "escalated");
      return "escalated";
    }
    this.failure = {
      stageName: record.name,
      reason: info.reason,
      ...(info.finalError ? { finalError: info.finalError } : {}),
    };
    this.overall = "failed";
    this.transitionStage(record, "failed");
    return "failed";
  }
}

/** Rebuilds a minimal AgentResult when the run callback threw before capture. */
function reconstructResultFromStored(
  request: DispatchRequest,
  stored: StoredTaskResult | undefined,
): AgentResult {
  return {
    status: stored?.status === "completed" ? "success" : "failed",
    // Boundary reconstruction: the canonical agent name is not recoverable
    // from the stored projection; the requested key is the honest closest
    // value and only feeds failure evidence rendering.
    agent: (request.agent ?? "unknown") as AgentName,
    summary: stored?.summary ?? stored?.error ?? "Background dispatch produced no recorded result",
    output: stored?.finalAnswer ?? "",
    ...(stored?.finalAnswer ? { finalAnswer: stored.finalAnswer } : {}),
    ...(stored?.error ? { error: stored.error } : {}),
    ...(stored?.exitCode !== undefined ? { exitCode: stored.exitCode } : {}),
  };
}
