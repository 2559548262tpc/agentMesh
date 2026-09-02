import * as crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { MultiAgentRunner } from "../core/runner.js";
import type { AgentResult } from "../agents/types.js";
import type { BridgeSession } from "../core/types.js";
import { resolveSessionStoragePath } from "../core/session.js";
import { analyzeHandoff, formatHandoffSummary } from "../core/handoff.js";
import {
  BackgroundTaskNotFoundError,
  BackgroundTaskRegistry,
  readTailSnapshot,
} from "../core/background.js";
import type { StoredTaskResult } from "../core/background.js";
import { forgetActivityHandle, getActivityHandle } from "../core/executor.js";
import { createAgentMeshEventBus } from "../core/events.js";
import { buildPreview, persistArtifact, selectArtifactSpill } from "../core/artifacts.js";
import { defaultCheckpointStore } from "../core/checkpoint.js";
import type { AgentMetadata } from "../core/config.js";
import { truncateText } from "../core/text.js";
import {
  appendFindings,
  collectReworkClosureFindings,
  enrichReviewFinding,
} from "../core/findings.js";
import type { FindingRecord } from "../core/findings.js";
import { verifyContractMap } from "../core/contractMap.js";
import {
  WorkflowEngineRegistry,
  WorkflowSpecSchema,
  createDefaultCandidateResolver,
  parseWorkflowSpec,
  readPersistedWorkflowSnapshot,
} from "../core/workflow.js";

const MAX_TIMEOUT_MS = 3_600_000;
const MAX_FINAL_ANSWER_CHARS = 12_000;
const MAX_RAW_OUTPUT_CHARS = 8_000;
const PROGRESS_INTERVAL_MS = 15_000;
/** Tail snapshot captured into a checkpoint when a background dispatch dies (P5 T5.2). */
const CHECKPOINT_TAIL_BYTES = 32_768;
type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const NonBlankString = z.string().trim().min(1);

/** One normalized section already spilled to an artifact and replaced by a pointer block. */
interface SpilledSection {
  source: "finalAnswer" | "rawOutput";
  previewBlock: string;
}

function buildNormalizedLines(result: AgentResult, spilled: SpilledSection | undefined): string[] {
  const details = [`Summary: ${result.summary}`];
  if (spilled?.source === "finalAnswer") {
    details.push(spilled.previewBlock);
  } else if (result.finalAnswer && result.finalAnswer.trim() !== result.summary.trim()) {
    details.push(
      `Final Answer:\n${truncateText(result.finalAnswer.trim(), MAX_FINAL_ANSWER_CHARS)}`,
    );
  }
  // Vendor logs and stderr stay diagnosable over MCP instead of being dropped
  // by normalization; without them, remote failures carry no actionable detail.
  const rawOutput = result.output?.trim();
  if (spilled?.source === "rawOutput") {
    details.push(spilled.previewBlock);
  } else if (
    rawOutput &&
    rawOutput !== result.finalAnswer?.trim() &&
    rawOutput !== result.summary.trim()
  ) {
    details.push(`Raw Output:\n${truncateText(rawOutput, MAX_RAW_OUTPUT_CHARS)}`);
  }
  if (result.error) details.push(`Error: ${result.error}`);
  if (result.errorCode) details.push(`error_code: ${result.errorCode}`);
  if (result.warning) details.push(`Warning: ${result.warning}`);
  if (result.timedOut) details.push("Execution Evidence: timed out");
  if (result.aborted) details.push("Execution Evidence: aborted");
  if (result.resourceEvidence) {
    details.push(`Resource Evidence:\n${JSON.stringify(result.resourceEvidence, null, 2)}`);
  }
  if (result.exitCode !== undefined) details.push(`Exit Code: ${result.exitCode}`);
  if (result.findings && result.findings.length > 0) {
    details.push(`Findings:\n${JSON.stringify(result.findings, null, 2)}`);
  }
  if (result.reviewerSafety) {
    details.push(`Reviewer Safety:\n${JSON.stringify(result.reviewerSafety, null, 2)}`);
  }
  return details;
}

/**
 * Sync legacy renderer without artifact spill. Sections over the spill
 * threshold degrade to the historical hard truncation here; production MCP
 * handlers use formatNormalizedResultDetailed so oversized sections are
 * persisted verbatim and referenced by path instead.
 */
export function formatNormalizedResult(result: AgentResult): string[] {
  return buildNormalizedLines(result, undefined);
}

export interface NormalizedResultFormatOptions {
  /** Bridge session owning the turn; required for artifact persistence. */
  sessionId?: string;
  /** 1-based turn number naming the artifact file and audit record. */
  turnNumber?: number;
  /**
   * Overrides the AgentMesh home root for artifact files (test isolation);
   * production leaves this unset so resolveAgentMeshHome() applies.
   */
  artifactHomeDir?: string;
  /**
   * Registers the spill pointer into the session sidecar audit trail; wired to
   * MultiAgentRunner.registerArtifactAudit by the MCP handlers.
   */
  registerAudit?: (record: {
    source: string;
    chars: number;
    sha256: string;
    artifactPath: string;
  }) => { file: string } | undefined;
}

/**
 * Async renderer with T2.2 artifact spill ([CC] toolResultStorage): a
 * finalAnswer/rawOutput over ARTIFACT_SPILL_THRESHOLD_CHARS is persisted
 * verbatim to <agentmeshHome>/artifacts/<sessionId>/turn-<n>.txt and replaced
 * by a bounded newline-boundary preview plus the absolute artifact path and a
 * [hasMore] marker 鈥?no information is truncated away.
 */
export async function formatNormalizedResultDetailed(
  result: AgentResult,
  options: NormalizedResultFormatOptions = {},
): Promise<string[]> {
  const decision = selectArtifactSpill(result.finalAnswer, result.output);
  let spilled: SpilledSection | undefined;
  if (decision && options.sessionId && options.turnNumber !== undefined) {
    const artifact = await persistArtifact(
      options.sessionId,
      options.turnNumber,
      decision.content,
      {
        homeDir: options.artifactHomeDir,
      },
    );
    options.registerAudit?.({
      source: decision.source,
      chars: artifact.chars,
      sha256: artifact.sha256,
      artifactPath: artifact.path,
    });
    const { preview, truncated } = buildPreview(decision.content);
    const label = decision.source === "finalAnswer" ? "Final Answer" : "Raw Output";
    spilled = {
      source: decision.source,
      previewBlock: [
        `${label} Spilled To Artifact (full output preserved on disk, ${artifact.chars} chars):`,
        `Artifact Path: ${artifact.path}`,
        `sha256: ${artifact.sha256}`,
        "Preview:",
        preview,
        `[hasMore: ${truncated}]`,
      ].join("\n"),
    };
  }
  return buildNormalizedLines(result, spilled);
}

async function sendProgress(
  extra: ToolRequestExtra,
  progress: number,
  message: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, message },
    });
  } catch {
    // Progress is advisory and must not change the task outcome.
  }
}

/** Combines the MCP request signal with a background dispatch controller. */
function mergeAbortSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  const anyImpl = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (external && anyImpl) return anyImpl([external, internal]);
  return internal;
}

export interface BackgroundLaunchParams {
  taskId: string;
  outputFile: string;
  run: (signal: AbortSignal) => Promise<AgentResult>;
}

/**
 * Owns in-process background dispatches (T1.4). Each launch registers its
 * promise for graceful shutdown and writes the terminal outcome into the
 * task registry so poll_task can report completed/failed states — including
 * after the MCP response that started the work has long returned. Failed or
 * terminated dispatches spill a checkpoint of the captured output tail (P5
 * T5.2), and the stalled watchdog's second stage (P5 T5.3) aborts tasks that
 * stay silent for STALLED_TERMINATE_THRESHOLD_MS.
 */
export class BackgroundDispatchService {
  readonly registry: BackgroundTaskRegistry;
  private readonly checkpoints: Pick<typeof defaultCheckpointStore, "saveCheckpoint">;
  private readonly pending = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; outputFile: string }
  >();

  constructor(
    registry: BackgroundTaskRegistry = new BackgroundTaskRegistry({
      eventBus: createAgentMeshEventBus(),
    }),
    options: { checkpointStore?: typeof defaultCheckpointStore } = {},
  ) {
    this.registry = registry;
    this.checkpoints = options.checkpointStore ?? defaultCheckpointStore;
    this.registry.enableStalledWatchdog({
      getActivityHandle: (taskId) => getActivityHandle(taskId),
      onStalledTerminate: (taskId) => void this.terminateStalledTask(taskId),
    });
  }

  /**
   * P5 T5.3 watchdog second stage: aborts the stalled dispatch through its
   * controller (the launch callback records the terminal failed result with
   * this abort reason) and spills a checkpoint of the output tail first so
   * the salvaged work stays injectable via continue_task(fromCheckpoint).
   */
  private async terminateStalledTask(taskId: string): Promise<void> {
    const entry = this.pending.get(taskId);
    if (!entry) return;
    try {
      const tail = await readTailSnapshot(entry.outputFile, CHECKPOINT_TAIL_BYTES);
      if (tail.trim()) {
        await this.checkpoints.saveCheckpoint({
          taskId,
          reason: "stalled-terminated",
          partialAnswer: tail,
          summary: `Background task '${taskId}' was auto-terminated after 30 minutes without output; the last captured output is preserved in this checkpoint.`,
        });
      }
    } catch {
      // Checkpoint capture is best-effort; termination must proceed.
    }
    entry.controller.abort(
      new Error("stalled beyond 30 minutes without output; auto-terminated by the watchdog"),
    );
  }

  /** Number of background dispatches still running in this process. */
  public get activeCount(): number {
    return this.pending.size;
  }

  public launch(params: BackgroundLaunchParams): void {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const result = await params.run(controller.signal);
        // Checkpoint first: "result visible ⇒ checkpoint visible" becomes a
        // structural invariant (readers poll for the result and then read the
        // checkpoint; publishing the result last removes the poll window).
        if (result.status !== "success") {
          await this.spillFailureCheckpoint(params.taskId, params.outputFile, {
            bridgeSessionId: result.sessionId,
            reason: controller.signal.aborted ? "cancelled" : "failed",
            summary: result.summary,
            usage: result.usage,
            exitCode: result.exitCode,
          });
        }
        await this.registry.writeStoredResult({
          taskId: params.taskId,
          status: result.status === "success" ? "completed" : "failed",
          summary: result.summary,
          finalAnswer: result.finalAnswer,
          error: result.error,
          exitCode: result.exitCode,
          completedAtMs: Date.now(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.spillFailureCheckpoint(params.taskId, params.outputFile, {
          reason: controller.signal.aborted ? "cancelled" : "failed",
          summary: message,
        });
        await this.registry.writeStoredResult({
          taskId: params.taskId,
          status: "failed",
          error: message,
          completedAtMs: Date.now(),
        });
      } finally {
        forgetActivityHandle(params.taskId);
        this.registry.releaseTask(params.taskId);
        this.pending.delete(params.taskId);
      }
    })();
    this.pending.set(params.taskId, { promise, controller, outputFile: params.outputFile });
  }

  /**
   * P5 T5.2: spills the captured output tail of a dead background dispatch
   * into a checkpoint so continue_task(fromCheckpoint) can resume it.
   * Best-effort by design; never masks the original failure.
   */
  private async spillFailureCheckpoint(
    taskId: string,
    outputFile: string,
    meta: {
      bridgeSessionId?: string;
      reason: "failed" | "cancelled";
      summary?: string;
      usage?: AgentResult["usage"];
      exitCode?: number;
    },
  ): Promise<void> {
    try {
      const tail = await readTailSnapshot(outputFile, CHECKPOINT_TAIL_BYTES);
      if (!tail.trim()) return;
      await this.checkpoints.saveCheckpoint({
        taskId,
        bridgeSessionId: meta.bridgeSessionId,
        reason: meta.reason,
        partialAnswer: tail,
        summary: meta.summary,
        usage: meta.usage,
        exitCode: meta.exitCode,
      });
    } catch {
      // Best-effort recovery evidence.
    }
  }

  /**
   * Shutdown path: aborts every running dispatch through their controllers
   * (reusing the runner's tree-termination path) and waits for each to record
   * its terminal state.
   */
  public async abortAll(reason: string): Promise<void> {
    const entries = [...this.pending.values()];
    for (const entry of entries) entry.controller.abort(new Error(reason));
    await Promise.allSettled(entries.map((entry) => entry.promise));
  }

  /**
   * cancel_task primitive (ROADMAP_v0.4 M7): cancels one running background
   * dispatch through its existing abort controller — the exact path the
   * stalled-watchdog termination uses. The launch completion path records the
   * terminal failed result and spills the output-tail checkpoint (reason
   * "cancelled"), and the runner terminates the full vendor process tree.
   * Already-terminal tasks are a no-op that reports the current status;
   * unknown tasks raise BackgroundTaskNotFoundError. A task registered by a
   * foreign live bridge (or no longer running without a result) is reported
   * as NOT_CANCELLABLE instead of being touched cross-process.
   */
  public async cancel(taskId: string, reason = "client_cancel"): Promise<CancelTaskOutcome> {
    const entry = this.pending.get(taskId);
    if (entry) {
      entry.controller.abort(new Error(`cancelled by client (${reason})`));
      await entry.promise;
      return {
        taskId,
        status: "cancelled",
        alreadyTerminal: false,
        cancelReason: reason,
        result: await this.registry.readStoredResult(taskId),
      };
    }
    const stored = await this.registry.readStoredResult(taskId);
    if (stored) {
      return {
        taskId,
        status: stored.status,
        alreadyTerminal: true,
        cancelReason: reason,
        result: stored,
      };
    }
    const record = this.registry.getRegisteredTask(taskId);
    if (!record) throw new BackgroundTaskNotFoundError(taskId);
    const detail =
      record.pid === process.pid
        ? "it is owned by this process but is no longer running"
        : `it is owned by another live bridge process (pid ${record.pid})`;
    throw new BackgroundTaskNotCancellableError(
      taskId,
      `Background task '${taskId}' cannot be cancelled: ${detail}.`,
    );
  }
}

/** Terminal outcome of a cancel_task call. */
export interface CancelTaskOutcome {
  taskId: string;
  /** "cancelled" when this call aborted a running dispatch; otherwise the existing terminal status. */
  status: "cancelled" | "completed" | "failed";
  /** True when the task was already terminal and nothing was aborted. */
  alreadyTerminal: boolean;
  /** Cancel reason carried into the abort signal (existing cancel taxonomy). */
  cancelReason: string;
  /** Terminal task result; absent when the owning process died before recording one. */
  result?: StoredTaskResult;
}

/** Raised by cancel() for tasks that exist but cannot be cancelled here. */
export class BackgroundTaskNotCancellableError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message);
    this.name = "BackgroundTaskNotCancellableError";
    this.taskId = taskId;
  }
}

async function runWithProgress(
  extra: ToolRequestExtra,
  label: string,
  operation: () => Promise<AgentResult>,
): Promise<AgentResult> {
  const startedAt = Date.now();
  await sendProgress(extra, 0, `${label} started`);
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1_000));
    void sendProgress(extra, elapsedSeconds, `${label} is still running`);
  }, PROGRESS_INTERVAL_MS);
  heartbeat.unref();

  try {
    const result = await operation();
    const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1_000));
    await sendProgress(extra, elapsedSeconds, `${label} ${result.status}`);
    return result;
  } catch (error) {
    const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1_000));
    await sendProgress(extra, elapsedSeconds, `${label} failed`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export const DelegateTaskInputSchema = z.object({
  agent: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Target agent harness name. When omitted, resolves the assigned role from .agentmesh/config.json",
    ),
  task: NonBlankString.describe("Task instructions or prompt to execute"),
  cwd: NonBlankString.optional().describe(
    "Working directory for the agent execution (defaults to current directory)",
  ),
  role: z
    .enum(["worker", "reviewer", "tester"])
    .optional()
    .describe("Role assigned to the agent ('worker', 'reviewer', or 'tester')"),
  mode: z
    .enum(["auto", "mcp", "cli"])
    .optional()
    .describe("Preferred transport mode ('auto', 'mcp', or 'cli')"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in milliseconds"),
  model: NonBlankString.max(200).optional().describe("Vendor-specific model identifier"),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Requested reasoning effort; supported values depend on the selected vendor"),
  sessionId: NonBlankString.optional().describe(
    "Optional bridge session ID to associate or continue",
  ),
  contextSessionId: NonBlankString.optional().describe(
    "Optional Bridge session whose normalized history should be shared with this new or existing agent session (legacy single-source form)",
  ),
  contextSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Up to 4 Bridge sessions whose normalized history is injected first-hand in the given order, replacing relay through task text",
    ),
  baseCommit: NonBlankString.optional().describe(
    "Optional git base branch/commit for diff comparison",
  ),
  reviewPaths: z
    .array(NonBlankString)
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Repo-relative paths (files or directories) a reviewer-role dispatch actually covers. " +
        "Scoped tree guard: working-tree changes outside this set are reported as a warning " +
        "instead of failing the review — use it when other workers commit in parallel (P-R22-4). " +
        ".agentmesh/ is always excluded. Ignored for non-reviewer roles",
    ),
  idempotencyKey: NonBlankString.max(200)
    .optional()
    .describe(
      "Optional deduplication key within the (cwd, agent) scope. While an identical dispatch is in " +
        "flight, callers receive an in-flight reference instead of a second execution; after it reaches " +
        "a terminal state, retries within a 20-minute window replay the recorded result (replayed:true) " +
        "with a STALE warning when the repository changed since. Use a distinct key per logical task",
    ),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run asynchronously: returns immediately with taskId and outputFile; use poll_task to observe " +
        "progress and collect the terminal result",
    ),
});

export const PollTaskInputSchema = z.object({
  taskId: NonBlankString.describe(
    "Background task ID previously returned by delegate_task(background:true)",
  ),
  sinceOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte offset into the task output file; only new bytes past this offset are returned. " +
        "Pass nextOffset from the previous poll_task response",
    ),
  maxWaitMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe(
      "Long-poll budget in milliseconds: the call blocks until new output or a terminal " +
        "state arrives (event-driven), up to this ceiling. Recommended 30000; omit for a " +
        "quick non-blocking status check",
    ),
});

export const ReviewChangesInputSchema = z.object({
  background: z
    .boolean()
    .optional()
    .describe(
      "Run asynchronously: returns immediately with taskId and outputFile; use poll_task to observe (P-R14-4: reviews routinely exceed the host's 30s sync window)",
    ),
  agent: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Target reviewer agent. When omitted, resolves roles.reviewer from .agentmesh/config.json",
    ),
  task: NonBlankString.optional().describe(
    "Specific review focus, checklist, or instructions (defaults to standard rigorous review)",
  ),
  cwd: NonBlankString.optional().describe(
    "Working directory for review (defaults to current directory)",
  ),
  baseCommit: NonBlankString.optional().describe(
    "Base branch/commit to diff against (e.g. 'main', 'HEAD~1')",
  ),
  reviewPaths: z
    .array(NonBlankString)
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Repo-relative paths (files or directories) the review actually covers. Scoped tree " +
        "guard: working-tree changes outside this set are reported as a warning instead of " +
        "failing the review — use it when other workers commit in parallel (P-R22-4). " +
        ".agentmesh/ is always excluded",
    ),
  mode: z
    .enum(["auto", "mcp", "cli"])
    .optional()
    .describe("Preferred transport mode ('auto', 'mcp', or 'cli')"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in milliseconds"),
  model: NonBlankString.max(200).optional().describe("Vendor-specific model identifier"),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Requested reasoning effort; supported values depend on the selected vendor"),
  contextSessionId: NonBlankString.optional().describe(
    "Optional worker/tester Bridge session whose normalized evidence should be shared with the reviewer (legacy single-source form)",
  ),
  contextSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Up to 4 Bridge sessions (e.g. worker and tester) injected first-hand so the reviewer reads their conclusions without relay",
    ),
  maxReworkRounds: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe(
      "P5 bounded rework loop: when the review FAILs, the structured findings are injected into the " +
        "worker session and the change is re-reviewed, at most this many rounds (default 0 = single-pass). " +
        "The final response carries result.rework with the per-round evidence chain",
    ),
  workerSessionId: NonBlankString.optional().describe(
    "Bridge session of the worker whose changes are under review; required for the rework loop when " +
      "no worker-role contextSessionId is provided",
  ),
});

export const CancelTaskInputSchema = z.object({
  taskId: NonBlankString.describe(
    "Background task ID previously returned by delegate_task or review_changes (background:true)",
  ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Short cancellation reason carried into the terminal outcome and the checkpoint spill (default 'client_cancel')",
    ),
});

export const RunWorkflowInputSchema = z.object({
  spec: WorkflowSpecSchema.describe(
    "Workflow specification: named stages with dispatch (agent, taskTemplate with " +
      "{{workflowName}}/{{stageName}}/{{group}}/{{upstreamSummaries}} substitution, contextPolicy), " +
      "acceptance (commands + required files), and policy (maxReworkRounds, escalateOn, reRouteOnStall). " +
      "Each stage declares exactly one of roles or parallelGroups",
  ),
  cwd: NonBlankString.optional().describe(
    "Working directory for stage dispatches and acceptance commands (defaults to current directory)",
  ),
});

export const GetWorkflowInputSchema = z.object({
  workflowId: NonBlankString.describe("Workflow ID previously returned by run_workflow"),
  maxWaitMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe(
      "Long-poll budget in milliseconds: for workflows owned by this bridge process the call blocks " +
        "until the state changes or the workflow reaches a terminal status (event-driven), up to this " +
        "ceiling. Recommended 30000; omit for a quick non-blocking status check. Persisted snapshots " +
        "(workflow not owned by this process) are returned immediately",
    ),
});

export const ContinueTaskInputSchema = z.object({
  sessionId: NonBlankString.describe(
    "The Bridge session ID returned from a previous delegate_task or review_changes call",
  ),
  task: NonBlankString.describe("Follow-up instructions or fix requests to continue the session"),
  mode: z
    .enum(["auto", "mcp", "cli"])
    .optional()
    .describe("Preferred transport mode ('auto', 'mcp', or 'cli')"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in milliseconds"),
  model: NonBlankString.max(200).optional().describe("Vendor-specific model identifier"),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Requested reasoning effort; supported values depend on the selected vendor"),
  contextSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Up to 4 Bridge sessions (e.g. reviewer and tester) injected alongside the session's own native resume",
    ),
  fromCheckpoint: NonBlankString.optional().describe(
    "P5 one-shot recovery baton: checkpoint ID returned by a failed/stalled background task " +
      "(or its output listing). The salvaged partial output is injected at the head of this " +
      "continuation; the checkpoint is consumed exactly once — a second attempt is rejected",
  ),
});

export const GetSessionInputSchema = z.object({
  sessionId: NonBlankString.describe("The Bridge session ID to inspect"),
});

export const HandoffDiffInputSchema = z.object({
  upstreamSessionId: NonBlankString.describe(
    "Bridge session whose produced output (task, summary, finalAnswer, findings, repository evidence) is the reference side of the comparison",
  ),
  downstreamSessionId: NonBlankString.describe(
    "Bridge session that consumed the handoff via contextSessionIds; its recorded context injections are compared against the upstream output",
  ),
});

export const RollbackTaskInputSchema = z.object({
  sessionId: NonBlankString.describe(
    "Bridge session whose pre-dispatch rollback anchor should be restored",
  ),
});

export const GetRoleConfigInputSchema = z.object({
  cwd: NonBlankString.optional().describe(
    "Project directory used to locate the nearest .agentmesh/config.json",
  ),
});

/**
 * Renders one normalized result for MCP output with T2.2 artifact spill
 * enabled. The turn number is the just-recorded history length because the
 * runner persists its turn before the handler formats the response.
 */
async function formatResultForMcp(
  runner: MultiAgentRunner,
  result: AgentResult,
): Promise<string[]> {
  const turnNumber = result.sessionId
    ? (runner.getSession(result.sessionId)?.history.length ?? 0)
    : undefined;
  return formatNormalizedResultDetailed(result, {
    sessionId: result.sessionId,
    turnNumber,
    registerAudit:
      result.sessionId && turnNumber !== undefined
        ? (record) =>
            runner.registerArtifactAudit(result.sessionId!, turnNumber, record) ?? undefined
        : undefined,
  });
}

/**
 * M3 findings-value tracking seam. Enriches the review result's findings with
 * the machine-readable taxonomy (deterministic id, category, kind — additive
 * to the parsed shape) and appends them to the findings store. When the
 * bounded rework loop closed in PASS, the findings that triggered the rework
 * are recovered from the worker session's injected fix prompts and recorded
 * with their confirmation signal: confirmed true when the fix turn changed the
 * repository (real defects that were fixed), confirmed false when the fix turn
 * changed nothing yet the re-review passed (false positives), and left
 * undefined when no reliable change signal exists. Best-effort: enrichment or
 * store failures never alter the review verdict.
 */
function recordReviewFindings(
  runner: MultiAgentRunner,
  result: AgentResult,
  options: { taskId?: string } = {},
): void {
  const enriched = (result.findings ?? []).map((finding) => enrichReviewFinding(finding));
  if (enriched.length > 0) result.findings = enriched;
  const reviewedAt = new Date().toISOString();
  const records: FindingRecord[] = enriched.map((finding) => ({
    findingId: finding.id,
    sessionId: result.sessionId ?? "unknown",
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    reviewerAgent: result.agent,
    category: finding.category,
    kind: finding.kind,
    severity: finding.severity,
    file: finding.file,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    reviewedAt,
  }));
  const rework = result.rework;
  if (rework && rework.rounds > 0 && result.reviewOutcome === "PASS" && rework.workerSessionId) {
    const session = runner.getSession(rework.workerSessionId);
    for (const closure of collectReworkClosureFindings(session?.history ?? [], rework.rounds)) {
      const finding = enrichReviewFinding(closure.finding);
      const evidence =
        closure.changedRepository === undefined
          ? `Rework round ${closure.round} closed PASS; no reliable code-change signal for this finding.`
          : closure.changedRepository
            ? `Rework round ${closure.round} fix changed the repository and the re-review returned PASS.`
            : `Rework round ${closure.round} fix changed nothing and the re-review returned PASS; treated as a false positive.`;
      records.push({
        findingId: finding.id,
        sessionId: rework.workerSessionId,
        ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
        reviewerAgent: result.agent,
        category: finding.category,
        kind: finding.kind,
        severity: closure.finding.severity,
        file: closure.finding.file,
        ...(closure.finding.line !== undefined ? { line: closure.finding.line } : {}),
        reviewedAt: closure.reviewedAt ?? reviewedAt,
        ...(closure.changedRepository !== undefined
          ? { confirmed: closure.changedRepository }
          : {}),
        evidence,
      });
    }
  }
  appendFindings(records);
}

export const ListAgentsInputSchema = z.object({
  cwd: NonBlankString.optional().describe(
    "Project directory used to locate the nearest .agentmesh/config.json agents metadata (defaults to current directory)",
  ),
});

export const CompactContextInputSchema = z.object({
  sourceSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .describe(
      "Up to 4 Bridge sessions whose normalized history should be condensed into a semantic summary sidecar",
    ),
});

export const VerifyContractMapInputSchema = z.object({
  contractItems: z
    .array(
      z.object({
        id: NonBlankString.describe("Contract item identifier from the task's contract checklist"),
        text: NonBlankString.describe(
          "What the contract item requires (verbatim from the contract)",
        ),
      }),
    )
    .min(1)
    .describe("Contract checklist items the worker had to satisfy"),
  map: z
    .array(
      z.object({
        id: NonBlankString.describe("Contract item id this entry maps to"),
        file: NonBlankString.describe(
          "Repo-relative (or absolute) path of the file satisfying the item",
        ),
        line: z.number().int().min(1).describe("1-based line number inside the file"),
      }),
    )
    .min(1)
    .describe("Worker-delivered contract item -> file:line map to verify"),
  cwd: NonBlankString.optional().describe(
    "Working directory used to resolve relative file paths (defaults to current directory)",
  ),
});

/** Formats one routing-metadata field group, degrading to "unmetered" (T4.2). */
function formatRoutingMetadata(metadata: AgentMetadata | undefined): string[] {
  if (!metadata) {
    return [
      "Tier: unmetered | Cost level: unmetered",
      "Strengths: unmetered | Not good at: unmetered",
      "Notes: unmetered (no agents metadata declared for this channel in .agentmesh/config.json)",
    ];
  }
  const lines = [
    `Tier: ${metadata.tier ?? "unmetered"} | Cost level: ${metadata.costLevel ?? "unmetered"}`,
    `Speed: ${metadata.speed ?? "unmetered"}`,
    `Strengths: ${metadata.strengths?.length ? metadata.strengths.join(", ") : "unmetered"}`,
    `Not good at: ${metadata.notGoodAt?.length ? metadata.notGoodAt.join(", ") : "unmetered"}`,
  ];
  lines.push(`Notes: ${metadata.notes ?? "unmetered"}`);
  return lines;
}

/**
 * M7 handoff_diff: loads the verbatim injected shared-context blocks recorded
 * as sidecar audit artifacts (contexts/<sessionId>/<turn>.txt next to the
 * sessions storage) so section judgments can run against the exact bytes the
 * downstream session received. Best-effort by design: an unreadable or missing
 * artifact simply degrades that turn's judgment to the recorded audit
 * metadata (basis: metadata) instead of failing the report.
 */
function loadInjectedContextByTurn(downstream: BridgeSession): Map<number, string> {
  const injected = new Map<number, string>();
  const storageDir = path.dirname(resolveSessionStoragePath());
  downstream.history.forEach((entry, index) => {
    const file = entry.sharedContextAudit?.file;
    if (!file) return;
    try {
      injected.set(index + 1, readFileSync(path.join(storageDir, file), "utf-8"));
    } catch {
      // Content basis is best-effort; metadata basis remains available.
    }
  });
  return injected;
}

export function registerMcpTools(
  server: McpServer,
  runner: MultiAgentRunner,
  options: { background?: BackgroundDispatchService } = {},
) {
  const background = options.background ?? new BackgroundDispatchService();
  // delegate_task
  server.tool(
    "delegate_task",
    [
      "Delegates a task to an explicit agent or to the agent assigned to its role in .agentmesh/config.json.",
      "",
      "Requirements gate (run BEFORE the first dispatch of any new project):",
      "0. Vague user input is normal and expected. Before decomposing, restate your understanding back to the user: the goal, what is explicitly OUT of scope, and acceptance criteria that are objectively decidable (test results, file existence, command exit codes — never 'nice' or 'usable'). Ask at most 3 questions that affect decomposition or acceptance, then WAIT for confirmation. Only after the user confirms, write the confirmed criteria into ORCHESTRATION.md (the project constitution) and start dispatching.",
      "0b. Mid-project requirement changes are normal, not failures: update ORCHESTRATION.md first, then re-dispatch only the affected tasks.",
      "Delegation discipline (protocol-as-prompt):",
      "1. Brief like a smart colleague who just walked in — NEVER delegate understanding: every instruction must carry concrete file paths and the exact intended change. Anti-pattern: 'based on your findings' — the downstream agent has only what you wrote, not your understanding.",
      "2. Parallelism: fan out read-only tasks (research/review/analysis) freely; strictly serialize write tasks that touch the same set of files.",
      "3. Continue-vs-fresh: send correction feedback back to the SAME session so error context carries over; run verification in a NEW session for fresh eyes; also start a new session when the direction was fundamentally wrong to avoid anchoring.",
      "4. Define done: an implementation task is done only when the report includes actual test results and a summary of changes made.",
      "5. Dispatch mode: long tasks MUST use background:true — synchronous delegate calls die at the ~30s host cutoff, leave no task-registry record, and get no terminal binding in the visual board. Sync calls are only for quick queries (list_agents, get_session).",
      "6. Handoff reference: review_changes and continue_task MUST pass contextSessionIds pointing at the upstream session(s). Without it the reviewer subtask cannot be attributed to its task in the board (orphan) and 'delivered context' is hallucinated, not audited.",
      "7. Role closure: implementation tasks run worker → reviewer at minimum; never skip the reviewer. Dispatch a tester when acceptance requires independent execution evidence. Confirm the intended role on every dispatch.",
      "8. Complexity gate: assess before dispatching — single-file cohesive changes are usually faster done directly by the orchestrator; MCP pays off when work splits into parallelizable packages with a fixed contract. Recording 'not worth dispatching' is a valid outcome.",
    ].join("\n"),
    DelegateTaskInputSchema.shape,
    async (args: z.infer<typeof DelegateTaskInputSchema>, extra) => {
      try {
        if (args.background) {
          const taskId = `bgtask_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
          const outputFile = background.registry.outputFilePath(taskId);
          background.registry.registerTask({
            taskId,
            pid: process.pid,
            startedAtMs: Date.now(),
            outputFile,
          });
          background.launch({
            taskId,
            outputFile,
            run: (signal) =>
              runner.delegateTask({
                agent: args.agent,
                task: args.task,
                cwd: args.cwd,
                role: args.role,
                mode: args.mode,
                timeoutMs: args.timeoutMs,
                model: args.model,
                reasoningEffort: args.reasoningEffort,
                sessionId: args.sessionId,
                contextSessionId: args.contextSessionId,
                contextSessionIds: args.contextSessionIds,
                baseCommit: args.baseCommit,
                reviewPaths: args.reviewPaths,
                idempotencyKey: args.idempotencyKey,
                signal: mergeAbortSignals(extra.signal, signal),
                taskActivity: { taskId, outputFile },
              }),
          });
          return {
            content: [
              {
                type: "text",
                text: [
                  "[Background Task Accepted]",
                  `Task ID: ${taskId}`,
                  `Output File: ${outputFile}`,
                  "Status: RUNNING",
                  "",
                  "The task is executing asynchronously; use poll_task to observe.",
                  `Call poll_task with taskId="${taskId}" to read incremental output and the terminal result.`,
                  "Long-poll guidance: pass maxWaitMs=30000 so one poll_task call blocks until new output or a terminal state arrives (event-driven) instead of re-polling every few seconds.",
                ].join("\n"),
              },
            ],
          };
        }
        const result = await runWithProgress(extra, "Agent task", () =>
          runner.delegateTask({
            agent: args.agent,
            task: args.task,
            cwd: args.cwd,
            role: args.role,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            sessionId: args.sessionId,
            contextSessionId: args.contextSessionId,
            contextSessionIds: args.contextSessionIds,
            baseCommit: args.baseCommit,
            reviewPaths: args.reviewPaths,
            idempotencyKey: args.idempotencyKey,
            signal: extra.signal,
          }),
        );

        // A FAIL verdict must surface as an MCP error even when the reviewer
        // role was inherited from the session rather than requested explicitly.
        const isError = result.status === "failed" || result.reviewOutcome === "FAIL";

        const formattedText = [
          `[Agent: ${result.agent} | Status: ${result.status.toUpperCase()}${result.reviewOutcome ? ` | Review Outcome: ${result.reviewOutcome}` : ""} | Session: ${result.sessionId || "none"}]`,
          ...(await formatResultForMcp(runner, result)),
          `Duration: ${result.durationMs ?? 0}ms`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: formattedText,
            },
          ],
          isError,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in delegate_task: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // poll_task
  server.tool(
    "poll_task",
    "Observes a background delegate_task: reports status (running/completed/failed/stalled), the incremental output since a byte offset, and the terminal result once available",
    PollTaskInputSchema.shape,
    async (args: z.infer<typeof PollTaskInputSchema>) => {
      try {
        const outcome = await background.registry.pollTask({
          taskId: args.taskId,
          sinceOffset: args.sinceOffset,
          maxWaitMs: args.maxWaitMs,
          // Event-driven wake (Plan 2026-09-01): a long maxWaitMs call now
          // blocks until activity instead of sleep-polling every 100ms.
          waitForActivity: (id) => background.registry.waitForActivity(id),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(outcome, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof BackgroundTaskNotFoundError) {
          // P-R14-3: distinguish "never existed" from "the owning bridge died
          // and a restart dead-lettered the registration". The declared output
          // file is the only salvage trail a SIGKILL leaves behind.
          const interrupted = background.registry.getInterruptedTask(err.taskId);
          if (interrupted) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      taskId: err.taskId,
                      status: "interrupted",
                      reason:
                        "The bridge process owning this background task died (crash or kill) before a terminal result was recorded; a restart dead-lettered the registration.",
                      interruptedAtMs: interrupted.orphanedAtMs,
                      startedAtMs: interrupted.startedAtMs,
                      outputFile: interrupted.outputFile,
                      outputExists: existsSync(interrupted.outputFile),
                      guidance:
                        "No checkpoint was taken (SIGKILL skips graceful failure handling). Inspect the output file for partial vendor output; re-dispatch the task (same idempotencyKey if one was used) to re-execute.",
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "NOT_FOUND", taskId: err.taskId, message: err.message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in poll_task: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // cancel_task — M7 lifecycle primitive
  server.tool(
    "cancel_task",
    "Cancels a running background task through its abort controller: terminates the full vendor process tree (Windows taskkill /T /F), spills the captured output tail as a one-shot checkpoint (resumable via continue_task fromCheckpoint), and records the terminal outcome in the task registry. An already-terminal task is a no-op that reports its current status without side effects.",
    CancelTaskInputSchema.shape,
    async (args: z.infer<typeof CancelTaskInputSchema>) => {
      try {
        const outcome = await background.cancel(args.taskId, args.reason);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(outcome, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof BackgroundTaskNotFoundError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "NOT_FOUND", taskId: err.taskId, message: err.message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        if (err instanceof BackgroundTaskNotCancellableError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "NOT_CANCELLABLE", taskId: err.taskId, message: err.message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in cancel_task: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // run_workflow — M4 deterministic orchestration state machine
  const workflowEngines = new WorkflowEngineRegistry();
  server.tool(
    "run_workflow",
    [
      "Runs a declarative workflow spec through the in-process deterministic state machine (no LLM orchestrator in the loop): each stage dispatches agents (worker/reviewer/tester roles or parallelGroups packages), runs its acceptance commands + file checks, and for reviewer stages loops bounded rework (findings re-injected into the worker session via continue_task) until PASS or rounds are exhausted.",
      "Stage dispatches run as background tasks through the same registry/watchdog/cancel_task path as delegate_task(background:true); waiting is event-driven. Dispatch failures re-route along the health-ordered candidate chain when the stage policy declares reRouteOnStall.",
      "Terminal statuses: done (every stage passed), escalated (the configured escalateOn failure class hit — the snapshot carries the full evidence chain: per-round findings, acceptance command outputs, repository diff summary), failed (any other stage failure). ESCALATED is the only point where the LLM orchestrator or the human takes over.",
      "Always asynchronous: returns immediately with workflowId; observe with get_workflow (maxWaitMs=30000 for event-driven long-polling).",
    ].join("\n"),
    RunWorkflowInputSchema.shape,
    async (args: z.infer<typeof RunWorkflowInputSchema>) => {
      try {
        const parsed = parseWorkflowSpec(args.spec);
        if (!parsed.success || !parsed.spec) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "INVALID_SPEC", issues: parsed.issues }, null, 2),
              },
            ],
            isError: true,
          };
        }
        const cwd = args.cwd ?? process.cwd();
        const engine = workflowEngines.create(parsed.spec, {
          dispatch: runner,
          background,
          cwd,
          candidateResolver: createDefaultCandidateResolver(runner, cwd),
        });
        void engine.run();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  workflowId: engine.id,
                  name: parsed.spec.name,
                  status: "running",
                  stages: parsed.spec.stages.map((stage) => stage.name),
                  guidance:
                    "The workflow executes asynchronously; call get_workflow with maxWaitMs=30000 (event-driven long-poll) until the status is terminal. Each stage dispatch is visible to poll_task/cancel_task under the task IDs <workflowId>_s<stage>_<seq>.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in run_workflow: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // get_workflow — observe a workflow run (live engine or persisted snapshot)
  server.tool(
    "get_workflow",
    "Returns the current workflow snapshot: overall status (running/done/escalated/failed), per-stage status transitions, dispatched task records, acceptance command results, review verdicts with per-round findings, and the full evidence chain for terminal failures. Live workflows owned by this bridge process support event-driven long-polling via maxWaitMs; workflows from earlier bridge processes are served from the persisted workflow log.",
    GetWorkflowInputSchema.shape,
    async (args: z.infer<typeof GetWorkflowInputSchema>) => {
      try {
        const engine = workflowEngines.get(args.workflowId);
        if (engine) {
          const snapshot = await engine.waitForUpdate(args.maxWaitMs ?? 0);
          return {
            content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
            isError: snapshot.status === "failed" || snapshot.status === "escalated",
          };
        }
        const persisted = readPersistedWorkflowSnapshot(args.workflowId);
        if (persisted) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  persisted.status === "running"
                    ? {
                        ...persisted,
                        note: "Persisted snapshot: this workflow was started by another bridge process, so no live long-polling is available. If that process died, its stage tasks are dead-lettered and the workflow will never advance.",
                      }
                    : persisted,
                  null,
                  2,
                ),
              },
            ],
            isError: persisted.status === "failed" || persisted.status === "escalated",
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "NOT_FOUND", workflowId: args.workflowId }, null, 2),
            },
          ],
          isError: true,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in get_workflow: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_role_config",
    "Loads and validates the project .agentmesh/config.json role-to-agent assignments",
    GetRoleConfigInputSchema.shape,
    async (args: z.infer<typeof GetRoleConfigInputSchema>) => {
      try {
        const loaded = runner.getProjectConfiguration(args.cwd);
        return {
          content: [
            {
              type: "text",
              text: loaded
                ? JSON.stringify(loaded, null, 2)
                : `No .agentmesh/config.json found for '${args.cwd || process.cwd()}'.`,
            },
          ],
          isError: !loaded,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  );

  // review_changes
  server.tool(
    "review_changes",
    [
      "Invokes an independent Reviewer Agent to inspect code changes, git diff, and report PASS / FAIL findings with line-level details.",
      "Always pass contextSessionIds referencing the reviewed worker session — without it the review cannot be attributed to its task in the visual board and the reviewer re-derives context from scratch.",
    ].join("\n"),
    ReviewChangesInputSchema.shape,
    async (args: z.infer<typeof ReviewChangesInputSchema>, extra) => {
      try {
        if (args.background) {
          const taskId = `bgtask_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
          const outputFile = background.registry.outputFilePath(taskId);
          background.registry.registerTask({
            taskId,
            pid: process.pid,
            startedAtMs: Date.now(),
            outputFile,
          });
          background.launch({
            taskId,
            outputFile,
            run: async (signal) => {
              const result = await runner.reviewChanges({
                agent: args.agent,
                task: args.task,
                cwd: args.cwd,
                baseCommit: args.baseCommit,
                reviewPaths: args.reviewPaths,
                mode: args.mode,
                timeoutMs: args.timeoutMs,
                model: args.model,
                reasoningEffort: args.reasoningEffort,
                contextSessionId: args.contextSessionId,
                contextSessionIds: args.contextSessionIds,
                maxReworkRounds: args.maxReworkRounds,
                workerSessionId: args.workerSessionId,
                signal,
              });
              recordReviewFindings(runner, result, { taskId });
              return result;
            },
          });
          return {
            content: [
              {
                type: "text",
                text: [
                  "[Background Review Accepted]",
                  `Task ID: ${taskId}`,
                  `Output File: ${outputFile}`,
                  "Status: RUNNING",
                  "",
                  "Use poll_task to observe; a FAIL verdict with maxReworkRounds continues autonomously in the background.",
                ].join("\n"),
              },
            ],
          };
        }
        const result = await runWithProgress(extra, "Review", () =>
          runner.reviewChanges({
            agent: args.agent,
            task: args.task,
            cwd: args.cwd,
            baseCommit: args.baseCommit,
            reviewPaths: args.reviewPaths,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            contextSessionId: args.contextSessionId,
            contextSessionIds: args.contextSessionIds,
            maxReworkRounds: args.maxReworkRounds,
            workerSessionId: args.workerSessionId,
            signal: extra.signal,
          }),
        );
        recordReviewFindings(runner, result);

        const isError = result.status === "failed" || result.reviewOutcome === "FAIL";

        const findingsHeader =
          result.findings && result.findings.length > 0
            ? ` | Findings: ${result.findings.length}`
            : "";
        const reworkHeader = result.rework ? ` | Rework Rounds: ${result.rework.rounds}` : "";

        const formattedText = [
          `[Reviewer: ${result.agent} | Review Outcome: ${result.reviewOutcome || "UNKNOWN"} | Status: ${result.status.toUpperCase()}${findingsHeader}${reworkHeader} | Session: ${result.sessionId || "none"}]`,
          ...(await formatResultForMcp(runner, result)),
          ...(result.rework ? [`Rework Evidence: ${JSON.stringify(result.rework)}`] : []),
          `Duration: ${result.durationMs ?? 0}ms`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: formattedText,
            },
          ],
          isError,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in review_changes: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // continue_task
  server.tool(
    "continue_task",
    "Continues an ongoing task on a previous Agent session (e.g. to fix issues reported by a reviewer)",
    ContinueTaskInputSchema.shape,
    async (args: z.infer<typeof ContinueTaskInputSchema>, extra) => {
      try {
        const result = await runWithProgress(extra, "Continued agent task", () =>
          runner.continueTask({
            sessionId: args.sessionId,
            task: args.task,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            contextSessionIds: args.contextSessionIds,
            fromCheckpoint: args.fromCheckpoint,
            signal: extra.signal,
          }),
        );

        const formattedText = [
          `[Agent: ${result.agent} | Status: ${result.status.toUpperCase()}${result.reviewOutcome ? ` | Review Outcome: ${result.reviewOutcome}` : ""} | Session: ${result.sessionId}]`,
          ...(await formatResultForMcp(runner, result)),
          `Duration: ${result.durationMs ?? 0}ms`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: formattedText,
            },
          ],
          isError: result.status === "failed" || result.reviewOutcome === "FAIL",
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in continue_task: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // list_agents — T4.2 routing-table view
  server.tool(
    "list_agents",
    "Routing table over all supported agent channels: live availability (eager scan), transport modes, declared sandbox level, self-declared routing metadata (tier / costLevel / strengths / notGoodAt / notes from .agentmesh/config.json), the candidates upgrade chain, and the most recent capability diagnostics. Read this once to plan every delegation; missing metadata is reported as unmetered rather than an error.",
    ListAgentsInputSchema.shape,
    async (args: z.infer<typeof ListAgentsInputSchema>) => {
      try {
        const table = await runner.getAgentRoutingTable(args.cwd ?? process.cwd());
        const sections: string[] = [
          `Agent Routing Table (${table.entries.length} channels, ${table.variants.length} declared variants; metadata source: ${table.source})`,
          ...(table.configWarning ? [`Config warning: ${table.configWarning}`] : []),
        ];
        for (const entry of table.entries) {
          sections.push(
            [
              `== ${entry.name} (${entry.displayName}) ==`,
              `Availability: ${entry.available ? "available" : "unavailable"}${entry.executablePath ? ` — ${entry.executablePath}` : ""}`,
              ...(entry.availabilityNote ? [entry.availabilityNote] : []),
              `Aliases: ${entry.aliases.length ? entry.aliases.join(", ") : "(none)"}`,
              `Transports: ${entry.supportedTransports.join(", ")} (preferred: ${entry.preferredTransport})`,
              `Sandbox declared: ${entry.sandboxMechanism}`,
              ...formatRoutingMetadata(entry.metadata),
              `Candidates chain: ${entry.metadata?.candidates?.length ? entry.metadata.candidates.join(" -> ") : "(none declared)"}`,
              `Recent capability diagnostics: ${entry.recentCapabilityDiagnostics.length ? "\n  - " + entry.recentCapabilityDiagnostics.join("\n  - ") : "none recorded"}`,
            ].join("\n"),
          );
        }
        if (table.variants.length) {
          sections.push("Declared routing variants (profile-backed tier entries):");
          for (const variant of table.variants) {
            sections.push(
              [
                `== ${variant.key} (variant) ==`,
                ...formatRoutingMetadata(variant.metadata),
                `Candidates chain: ${variant.metadata.candidates?.length ? variant.metadata.candidates.join(" -> ") : "(none declared)"}`,
              ].join("\n"),
            );
          }
        }
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error listing agents: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // compact_context
  server.tool(
    "compact_context",
    "Condenses each listed Bridge session's normalized history into a semantic summary sidecar using that session's own agent in one tool-free turn (≤2000 tokens). Downstream shared-context injection prefers a fresh summary plus a full-transcript pointer; any new turn on the source session invalidates the summary and falls back to the full transcript. Concurrent compactions of the same session are deduplicated with an in-flight notice.",
    CompactContextInputSchema.shape,
    async (args: z.infer<typeof CompactContextInputSchema>) => {
      try {
        const { outcomes } = await runner.compactContext({
          sourceSessionIds: args.sourceSessionIds,
        });
        const sections = outcomes.map((outcome) => {
          const header = `[Session: ${outcome.sourceSessionId} | Status: ${outcome.status.toUpperCase()}]`;
          switch (outcome.status) {
            case "summarized":
              return [
                `${header} Turns covered: ${outcome.summarizedTurns}${outcome.truncated ? " | Summary truncated" : ""}`,
                outcome.summary ?? "",
              ].join("\n");
            case "in-flight":
            case "skipped":
            case "failed":
              return `${header} ${outcome.reason ?? ""}`.trim();
          }
        });
        const isError = outcomes.every((outcome) => outcome.status === "failed");
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
          isError,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Bridge Error in compact_context: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  // get_session
  server.tool(
    "get_session",
    "Retrieves the history and metadata of an active Bridge Session",
    GetSessionInputSchema.shape,
    async (args: z.infer<typeof GetSessionInputSchema>) => {
      const session = runner.getSession(args.sessionId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Session '${args.sessionId}' not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(session, null, 2),
          },
        ],
      };
    },
  );

  // rollback_task
  server.tool(
    "rollback_task",
    "Restores the tracked working tree of a session's repository to the anchor captured before its last worker dispatch (T4b). The current state is stashed first (pre-rollback snapshot in session metadata) so a mistaken rollback is itself recoverable. Disclosed limitations: files created after the anchor remain on disk and are reported; untracked files present at anchor time cannot be restored.",
    RollbackTaskInputSchema.shape,
    async (args: z.infer<typeof RollbackTaskInputSchema>) => {
      try {
        const outcome = await runner.rollbackTask({ sessionId: args.sessionId });
        const isError = outcome.status === "failed";
        return {
          content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
          isError,
        };
      } catch (errorMsg) {
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in rollback_task: ${errorMsg instanceof Error ? errorMsg.message : String(errorMsg)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // verify_contract_map — M3 quick-review automation
  server.tool(
    "verify_contract_map",
    [
      "Machine-verifies a worker-delivered contract map (contract item id -> file:line) without spending LLM tokens: every mapped file must exist and be readable, the referenced line must be within bounds, and the line must be non-empty.",
      "Use it as the quick-review gate over a task's contract checklist before any deep LLM review; a pass:false report lists each item's failure status (missing | out-of-bounds | empty | unknown-item) so the worker can repair the mapping without a reviewer round.",
    ].join("\n"),
    VerifyContractMapInputSchema.shape,
    async (args: z.infer<typeof VerifyContractMapInputSchema>) => {
      try {
        const cwd = args.cwd ?? process.cwd();
        const report = verifyContractMap(args.contractItems, args.map, (filePath) =>
          readFileSync(path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath), "utf-8"),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
          isError: !report.pass,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in verify_contract_map: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // handoff_diff — M7 handoff-fidelity judge (ROADMAP_v0.4)
  server.tool(
    "handoff_diff",
    [
      "Machine judge for handoff fidelity: compares what an upstream Bridge session actually produced (task, summary, finalAnswer, findings, repository evidence) against what a downstream dispatch actually received through contextSessionIds injection, and returns a loss grade — replacing manual history diffing (real_test.md style).",
      "Grades: lossless | minor-truncation | partial-loss | severe-loss | lost. Section judgments use the verbatim recorded injection content (shared-context audit sidecar) when readable (basis: content) and fall back to the recorded audit metadata (basis: metadata). STALE freshness on the analyzed injection downgrades an otherwise lossless result. The latest context entry referencing the upstream is analyzed; every recorded context entry is listed.",
    ].join("\n"),
    HandoffDiffInputSchema.shape,
    async (args: z.infer<typeof HandoffDiffInputSchema>) => {
      const upstream = runner.getSession(args.upstreamSessionId);
      if (!upstream) {
        return {
          content: [
            { type: "text", text: `Upstream session '${args.upstreamSessionId}' not found.` },
          ],
          isError: true,
        };
      }
      if (upstream.history.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Upstream session '${args.upstreamSessionId}' has no recorded turns to compare.`,
            },
          ],
          isError: true,
        };
      }
      const downstream = runner.getSession(args.downstreamSessionId);
      if (!downstream) {
        return {
          content: [
            { type: "text", text: `Downstream session '${args.downstreamSessionId}' not found.` },
          ],
          isError: true,
        };
      }
      const report = analyzeHandoff({
        upstreamHistory: upstream.history,
        downstreamHistory: downstream.history,
        upstreamSessionId: args.upstreamSessionId,
        injectedContextByTurn: loadInjectedContextByTurn(downstream),
      });
      const text = `${formatHandoffSummary(report)}\n\n${JSON.stringify(report, null, 2)}`;
      return {
        content: [{ type: "text", text }],
        isError: report.grade === "lost" || report.grade === "severe-loss",
      };
    },
  );
}
