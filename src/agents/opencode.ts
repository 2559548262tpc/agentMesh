import { BaseAdapter } from "./base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
  UsageInfo,
} from "./types.js";
import { executeCommand, ProcessExecutionError } from "../core/executor.js";
import { buildRolePrompt } from "../core/prompts.js";
import { ARG_REJECTED, describeArgRejections, validateExtraArgs } from "../core/argPolicy.js";
import { classifyErrorCode } from "../core/resilience.js";

export interface ParsedOpenCodeOutput {
  output: string;
  sessionId?: string;
  error?: string;
  usage?: UsageInfo;
  /**
   * HTTP status extracted from the vendor error event (ISS-2), when the
   * payload carries one explicitly. Never guessed from prose.
   */
  httpStatus?: number;
  /**
   * True when the stream parsed as JSONL events but produced zero text
   * answers (P-081): the raw stdout is vendor event fragments, not an
   * answer, so callers must not use it as output/summary fallback.
   */
  normalizedEmpty?: boolean;
}

/**
 * P-081 placeholder replacing raw JSONL event fragments when the vendor run
 * produced no text events. Observable via warning on the AgentResult.
 */
export const OPENCODE_NO_ANSWER_PLACEHOLDER =
  "(no normalized answer produced: the vendor run emitted 0 text events)";

function findStringField(value: unknown, keys: ReadonlySet<string>, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (keys.has(key) && typeof nested === "string" && nested.trim()) return nested;
  }
  for (const nested of Object.values(record)) {
    const found = findStringField(nested, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function parseOpenCodeJsonLines(output: string): ParsedOpenCodeOutput {
  const answers: string[] = [];
  let sessionId: string | undefined;
  let error: string | undefined;
  let usage: UsageInfo | undefined;
  let parsedAny = false;
  let parsedStatus: number | undefined;

  // step_finish tokens are per-step; sum across steps so multi-turn runs report
  // the whole turn. Non-finite or negative components are skipped rather than
  // clamped: a partial sum beats an invented number (evidence-as-is principle).
  const addUsage = (patch: Record<string, unknown>): void => {
    usage = usage ?? {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      usage[key as keyof UsageInfo] = (usage[key as keyof UsageInfo] ?? 0) + value;
    }
  };

  for (const line of output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      parsedAny = true;
      sessionId ||= findStringField(event, new Set(["sessionID", "sessionId", "session_id"]));
      const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
      const part =
        event.part && typeof event.part === "object"
          ? (event.part as Record<string, unknown>)
          : undefined;
      const text =
        type === "text" && typeof part?.text === "string"
          ? part.text
          : typeof event.result === "string"
            ? event.result
            : undefined;
      if (text?.trim()) answers.push(text.trim());
      if (type === "step_finish") {
        const tokens =
          part?.tokens && typeof part.tokens === "object"
            ? (part.tokens as Record<string, unknown>)
            : event.tokens && typeof event.tokens === "object"
              ? (event.tokens as Record<string, unknown>)
              : undefined;
        if (tokens) {
          const cache =
            tokens.cache && typeof tokens.cache === "object"
              ? (tokens.cache as Record<string, unknown>)
              : {};
          addUsage({
            inputTokens: Number(tokens.input),
            outputTokens: Number(tokens.output),
            reasoningOutputTokens: Number(tokens.reasoning),
            totalTokens: Number(tokens.total),
            cachedInputTokens: Number(cache.read),
            cacheWriteInputTokens: Number(cache.write),
          });
        }
      }
      if (type === "error" || event.error) {
        if (typeof event.error === "string") {
          error = event.error;
        } else {
          const primary =
            findStringField(event.error, new Set(["message", "name", "code"])) ||
            "OpenCode returned an error event";
          // P-078: the vendor nests the actionable cause (model id, HTTP
          // status, upstream body) under auxiliary/nested fields, while the
          // extracted field is often just a bare name like "APIError".
          // Flattening to that name alone defeats classifyErrorCode
          // (MODEL_REJECTED vs TRANSIENT) and the escalation chain, so the
          // raw payload is appended, bounded to keep logs and results sane.
          let raw: string | undefined;
          try {
            raw = JSON.stringify(event.error);
          } catch {
            raw = undefined;
          }
          error = raw ? `${primary} | ${raw.slice(0, 400)}` : primary;
        }
        // ISS-2: pull the explicit HTTP status out of the error payload
        // (numeric status/code fields, or "HTTP 4xx"/"status: 403" text).
        const errorText =
          typeof event.error === "string" ? event.error : (JSON.stringify(event.error) ?? "");
        const statusMatch =
          /"(?:status|statusCode|httpStatus)"\s*:\s*(\d{3})\b/.exec(errorText) ??
          /\bHTTP(?:\s+status)?\s*[:/]?\s*(\d{3})\b/i.exec(errorText) ??
          /"\s*code\s*"\s*:\s*(\d{3})\b/.exec(errorText);
        const statusValue = statusMatch ? Number.parseInt(statusMatch[1]!, 10) : undefined;
        if (statusValue !== undefined && statusValue >= 400 && statusValue <= 599) {
          parsedStatus = statusValue;
        }
      }
    } catch {
      // Preserve compatibility with older/default output if a CLI emits mixed lines.
    }
  }

  return {
    output: answers.join("\n\n") || (parsedAny ? "" : output.trim()),
    sessionId,
    error,
    usage,
    ...(parsedStatus !== undefined ? { httpStatus: parsedStatus } : {}),
    ...(parsedAny && answers.length === 0 ? { normalizedEmpty: true } : {}),
  };
}

export class OpenCodeAdapter extends BaseAdapter {
  readonly name: AgentName = "opencode";
  readonly displayName = "OpenCode";
  readonly aliases = ["opencode-ai", "opencode-cli"] as const;
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "OPENCODE_BIN";
  readonly defaultExecutableName = "opencode";

  public buildCliArgs(options: RunAgentOptions): string[] {
    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
      rubric: options.reviewVerdictRequired,
    });
    const args = ["run", prompt, "--format", "json"];
    if (options.model) args.push("--model", options.model);
    if (options.nativeSessionId) args.push("--session", options.nativeSessionId);
    // Reviewer read-only enforcement stays prompt-level (buildRolePrompt) plus
    // the post-hoc tree guard in the runner. The vendor "plan" agent is NOT
    // used: in non-interactive runs it dies as soon as it attempts a command
    // (P-R21-1) and stalls with 0-byte output under parallel reviews
    // (P-R22-2). `--auto` is the empirically stable form for every role.
    args.push("--auto");
    // P3/T3.3: forward only allowlisted extraArgs; validation failures are
    // reported by runViaCli before any process is spawned.
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...validateExtraArgs(this.name, options.extraArgs).accepted);
    }
    return args;
  }

  /**
   * Runs OpenCode CLI (`opencode run <prompt> --auto`).
   */
  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    // P3/T3.3: caller extraArgs must match this adapter's allowlist before any
    // process work happens; rejections fail closed without spawning.
    const extraArgsVerdict = validateExtraArgs(this.name, options.extraArgs);
    if (extraArgsVerdict.rejections.length > 0) {
      const detail = `${ARG_REJECTED}: ${describeArgRejections(extraArgsVerdict.rejections)}`;
      return {
        status: "failed",
        agent: this.name,
        output: "",
        summary: detail,
        error: detail,
        durationMs: Date.now() - startTime,
      };
    }
    const bin = await this.getExecutablePath();
    const role = options.role ?? "worker";
    const args = this.buildCliArgs(options);

    try {
      const res = await executeCommand(bin, args, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        taskActivity: options.taskActivity,
      });

      const parsed = parseOpenCodeJsonLines(res.stdout);
      // P-081: when the stream parsed as JSONL events but carried zero text
      // answers, the raw stdout is vendor event fragments — never a usable
      // answer or summary. Substitute the placeholder and disclose it.
      const noTextEvents = parsed.normalizedEmpty === true;
      const diagnosticOutput = [
        parsed.output || (noTextEvents ? OPENCODE_NO_ANSWER_PLACEHOLDER : res.stdout),
        res.stderr,
      ]
        .filter(Boolean)
        .join("\n")
        .trim();
      const nativeSessionId =
        parsed.sessionId || this.extractSessionId(res.stdout) || options.nativeSessionId;

      if (res.exitCode !== 0 || parsed.error) {
        const failMessage = parsed.error ?? `OpenCode exited with code ${res.exitCode}`;
        return {
          status: "failed",
          agent: this.name,
          output: diagnosticOutput,
          summary: failMessage,
          error: parsed.error,
          exitCode: res.exitCode,
          // ISS-2: machine-readable classification + HTTP status so the
          // orchestrator can rule on quota/auth/retry without parsing raw
          // vendor output. P-079①: the parsed status also feeds the
          // classifier so bare "APIError" 5xx payloads still classify
          // TRANSIENT and reach the resilient retry layer.
          errorCode: classifyErrorCode({
            message: failMessage,
            exitCode: res.exitCode,
            timedOut: res.timedOut,
            aborted: res.aborted,
            ...(parsed.httpStatus !== undefined ? { httpStatus: parsed.httpStatus } : {}),
          }),
          ...(parsed.httpStatus !== undefined ? { httpStatus: parsed.httpStatus } : {}),
          nativeSessionId,
          durationMs: Date.now() - startTime,
          timedOut: res.timedOut,
          aborted: res.aborted,
          cleanupMethod: res.cleanupMethod,
          cleanupSucceeded: res.cleanupSucceeded,
          resourceEvidence: res.resourceEvidence,
          ...(parsed.usage ? { usage: parsed.usage } : {}),
        };
      }

      const successResult = this.formatSuccessResult(
        noTextEvents ? OPENCODE_NO_ANSWER_PLACEHOLDER : parsed.output || diagnosticOutput,
        startTime,
        {
          nativeSessionId,
          exitCode: res.exitCode,
          finalAnswer: noTextEvents ? undefined : parsed.output || undefined,
          role,
          reviewVerdictRequired: options.reviewVerdictRequired,
          resourceEvidence: res.resourceEvidence,
        },
      );
      return {
        ...successResult,
        ...(noTextEvents
          ? {
              warning: [
                successResult.warning,
                "The vendor produced no text events; the summary is a placeholder instead of raw JSONL event fragments (P-081).",
              ]
                .filter(Boolean)
                .join(" "),
            }
          : {}),
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      };
    } catch (err) {
      if (err instanceof ProcessExecutionError) {
        return {
          status: "failed",
          agent: this.name,
          output: [err.stdout, err.stderr].filter(Boolean).join("\n"),
          summary: `OpenCode execution error: ${err.message}`,
          exitCode: err.exitCode,
          // ISS-7: TLS/certificate failures surface here as bare errors;
          // classifying them TRANSIENT_5XX lets the resilient retry layer
          // re-attempt instead of surfacing an unexplained failure.
          errorCode: classifyErrorCode({
            message: err.message,
            exitCode: err.exitCode,
            timedOut: err.timedOut,
            aborted: err.aborted,
          }),
          durationMs: Date.now() - startTime,
        };
      }
      return this.formatErrorResult(err, startTime);
    }
  }

  private extractSessionId(output: string): string | undefined {
    const match = output.match(/(?:session|run)[_:\s]+([a-zA-Z0-9_-]{8,})/i);
    return match?.[1];
  }
}
