import type { AgentResult } from "../agents/types.js";
import {
  crossCheckRequirementCount,
  parseRequirementsFile,
  verifyRequirementQuotes,
  type CountCrossCheckReport,
  type QuoteVerificationReport,
  type RequirementsFile,
} from "./requirements.js";

/**
 * v0.5 Batch 2 #7 adjutant channel (design §3 ①, §7).
 *
 * The adjutant is a cheap (free-tier) dispatch that digests bulky content so
 * the leader never has to read it into his own context (P-080③) and distills
 * requirement documents into the structured requirements.json the
 * reconciliation ledger consumes. Two hard rules from the design:
 *
 * 1. Probe-first: the free tier has stall/quick-fail priors (muse-spark,
 *    nemotron), so every adjutant job starts with a minimal liveness probe.
 * 2. Fail-closed, no silent degradation: a schema-invalid distillation is
 *    retried ONCE with the issues attached (design §7 post-hoc validation
 *    channel); anything else — probe failure, transport failure, fabricated
 *    quotes — fails closed and the leader hand-writes the artifact instead.
 *    There is never a second real dispatch after the design's retry budget.
 *
 * This module owns the conversation/protocol logic only; file IO and agent
 * selection stay at the MCP tool boundary (dispatch is injected).
 */

/** Injected dispatch seam — the tool layer binds agent/cwd/model/timeout. */
export type AdjutantDispatch = (params: { task: string }) => Promise<AgentResult>;

/** Minimal liveness probe required before any real adjutant dispatch. */
export const ADJUTANT_PROBE_TASK =
  "AgentMesh adjutant probe: reply with exactly OK and nothing else.";

/** Initial distillation attempt + 1 schema-validation retry (design §7). */
export const DISTILL_MAX_ATTEMPTS = 2;

export const DEFAULT_SUMMARY_MAX_CHARS = 2_000;
export const SUMMARY_MIN_CHARS = 200;
export const SUMMARY_MAX_CHARS_CEILING = 8_000;

export function clampSummaryMaxChars(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_SUMMARY_MAX_CHARS;
  return Math.min(Math.max(requested, SUMMARY_MIN_CHARS), SUMMARY_MAX_CHARS_CEILING);
}

/**
 * Extracts a JSON object payload from an agent response that may be fenced,
 * embedded in prose, or clean. Returns undefined when nothing parseable is
 * found — never throws, never guesses.
 */
export function extractJsonPayload(raw: string): unknown {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to fence / brace extraction.
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      // Fall through to brace extraction.
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const EARS_RULES = [
  "WHEN <event> THEN system SHALL <response>  → kind 'event-driven'",
  "IF <condition> THEN system SHALL <response>  → kind 'exception'",
  "WHILE <state> system SHALL <behavior>  → kind 'state-driven'",
  "WHERE <feature enabled> system SHALL <behavior>  → kind 'optional-feature'",
  "system SHALL <behavior>  → kind 'unconditional'",
].join("\n");

/**
 * Builds the distillation task text. The output contract is a single JSON
 * object matching the requirements.json schema; the quote rule is spelled out
 * as verbatim-copy because the mechanical substring gate will reject anything
 * else (and quote failures are NOT retried — fabrication is terminal).
 */
export function buildDistillTaskText(params: { sourceName: string; document: string }): string {
  return [
    "You are the AgentMesh requirements-distillation adjutant. Extract every distinct,",
    "actionable requirement from the requirement document below into structured EARS items.",
    "",
    "OUTPUT CONTRACT (violations make the whole delivery fail):",
    "- Reply with EXACTLY ONE JSON object and nothing else — no markdown fence, no commentary.",
    "- Shape:",
    '  {"source": <the source name given below>, "items": [',
    '    {"id": "R1", "ears": <EARS sentence or null>, "kind": <see kinds or null>,',
    '     "quote": <verbatim substring of the document>, "decidable": true|false} ] }',
    "",
    "EARS grammar — pick the matching kind for each decidable item:",
    EARS_RULES,
    "",
    "ITEM RULES:",
    "- ids are sequential R1..Rn in document order.",
    "- decidable:true requires BOTH 'ears' (EARS sentence) and 'kind'.",
    "- decidable:false (needs a human ruling, e.g. subjective/UX demands) requires",
    "  'ears': null AND 'kind': null — but still carries a verbatim 'quote'.",
    "- 'quote' MUST be copied VERBATIM from the document (exact characters, exact",
    "  punctuation; keep it to the single decisive sentence or clause). It is checked",
    "  mechanically as a substring — paraphrased or invented quotes fail the delivery.",
    "- Do not merge two requirements into one item; do not invent requirements the",
    "  document does not state.",
    "",
    `Source name to use in the JSON: ${params.sourceName}`,
    "",
    "=== REQUIREMENT DOCUMENT START ===",
    params.document,
    "=== REQUIREMENT DOCUMENT END ===",
  ].join("\n");
}

/** Schema-retry task: same contract plus the exact issues from the first attempt. */
export function buildSchemaRetryTaskText(params: {
  sourceName: string;
  document: string;
  previousJson: string;
  issues: string[];
}): string {
  return [
    buildDistillTaskText(params),
    "",
    "=== VALIDATION FEEDBACK (your previous delivery) ===",
    "Your previous JSON violated the contract. Fix EXACTLY these issues and resend the",
    "full corrected JSON object (same output contract, one object, nothing else):",
    ...params.issues.map((issue) => `- ${issue}`),
    "",
    "=== YOUR PREVIOUS JSON ===",
    params.previousJson,
  ].join("\n");
}

export type DistillRequirementsOutcome =
  | {
      status: "distilled";
      requirements: RequirementsFile;
      quoteReport: QuoteVerificationReport;
      countCheck: CountCrossCheckReport;
      schemaRetriesUsed: 0 | 1;
    }
  | { status: "probe-failed"; error: string }
  | { status: "dispatch-failed"; error: string }
  | { status: "fail-closed"; stage: "schema" | "quote"; issues: string[] };

/**
 * Runs the full distillation pipeline: probe → dispatch → parse/validate →
 * (≤1 schema retry) → mechanical quote gate → count cross-check.
 */
export async function runDistillRequirements(
  dispatch: AdjutantDispatch,
  params: { document: string; sourceName: string },
): Promise<DistillRequirementsOutcome> {
  const probe = await dispatch({ task: ADJUTANT_PROBE_TASK });
  if (probe.status !== "success") {
    return {
      status: "probe-failed",
      error: probe.error ?? (probe.summary || "adjutant probe did not succeed"),
    };
  }

  let taskText = buildDistillTaskText(params);
  let previousJson: string | undefined;
  let issues: string[] | undefined;

  for (let attempt = 1; attempt <= DISTILL_MAX_ATTEMPTS; attempt += 1) {
    const result = await dispatch({ task: taskText });
    if (result.status !== "success") {
      // Transport/vendor failure: fail-closed (the retry budget in design §7
      // belongs to schema validation only, never to transport retries).
      return {
        status: "dispatch-failed",
        error: result.error ?? (result.summary || "adjutant dispatch failed"),
      };
    }

    const raw = (result.finalAnswer ?? result.output ?? "").trim();
    const payload = extractJsonPayload(raw);
    const parsed =
      payload === undefined
        ? { success: false as const, issues: ["no JSON object found in the response"] }
        : parseRequirementsFile(payload);

    if (parsed.success && parsed.requirements) {
      const quoteReport = verifyRequirementQuotes(params.document, parsed.requirements.items);
      if (!quoteReport.pass) {
        // Anti-fabrication hard gate: zero retries (design §3 ①). A model that
        // invents quotes once would paraphrase more carefully on retry, not
        // stop fabricating — the leader rules instead.
        return {
          status: "fail-closed",
          stage: "quote",
          issues: quoteReport.items
            .filter((item) => !item.ok)
            .map((item) => `${item.id}: ${item.detail}`),
        };
      }
      const countCheck = crossCheckRequirementCount(params.document, parsed.requirements.items);
      return {
        status: "distilled",
        requirements: parsed.requirements,
        quoteReport,
        countCheck,
        schemaRetriesUsed: attempt === 1 ? 0 : 1,
      };
    }

    issues = parsed.issues;
    if (attempt < DISTILL_MAX_ATTEMPTS) {
      previousJson = raw;
      taskText = buildSchemaRetryTaskText({
        sourceName: params.sourceName,
        document: params.document,
        previousJson: previousJson.slice(0, 4_000),
        issues,
      });
    }
  }

  return { status: "fail-closed", stage: "schema", issues: issues ?? ["unknown schema failure"] };
}

export type SummarizeForLeaderOutcome =
  | { status: "summarized"; summary: string; inputChars: number; truncated: boolean }
  | { status: "probe-failed"; error: string }
  | { status: "dispatch-failed"; error: string }
  | { status: "fail-closed"; stage: "empty-output"; error: string };

/**
 * Builds the leader-digest task. The contract is verdict-first with a hard
 * character ceiling; numbers/paths/exit codes must survive because they are
 * what the leader rules on.
 */
export function buildSummarizeTaskText(params: {
  content: string;
  focus?: string;
  maxChars: number;
}): string {
  return [
    "You are the AgentMesh leader-digest adjutant. Produce a digest the project leader can",
    `act on WITHOUT reading the original content. Hard ceiling: ${params.maxChars} characters.`,
    "",
    "DIGEST CONTRACT:",
    "- First line: verdict or answer (DONE / FAILED / decision needed + the one-line why).",
    "- Then only decision-relevant facts: root causes, errors, numbers, file paths,",
    "  exit codes, open questions. Drop narrative, code dumps, and restatement.",
    "- No preamble, no 'here is the summary', no markdown headers.",
    ...(params.focus ? [`- The leader specifically needs to know: ${params.focus}`] : []),
    "",
    "=== CONTENT START ===",
    params.content,
    "=== CONTENT END ===",
  ].join("\n");
}

/**
 * Runs the summarize-for-leader pipeline: probe → dispatch → deterministic
 * ceiling enforcement. There is no retry loop here by design (P-080③): the
 * fallback for a failed digest is the leader reading the raw content himself,
 * which is exactly what a second flaky free-tier attempt would waste tokens on.
 */
export async function runSummarizeForLeader(
  dispatch: AdjutantDispatch,
  params: { content: string; focus?: string; maxChars?: number },
): Promise<SummarizeForLeaderOutcome> {
  const maxChars = clampSummaryMaxChars(params.maxChars);
  const probe = await dispatch({ task: ADJUTANT_PROBE_TASK });
  if (probe.status !== "success") {
    return {
      status: "probe-failed",
      error: probe.error ?? (probe.summary || "adjutant probe did not succeed"),
    };
  }

  const result = await dispatch({ task: buildSummarizeTaskText({ ...params, maxChars }) });
  if (result.status !== "success") {
    return {
      status: "dispatch-failed",
      error: result.error ?? (result.summary || "adjutant dispatch failed"),
    };
  }

  const summary = (result.finalAnswer ?? result.output ?? "").trim();
  if (summary.length === 0) {
    return {
      status: "fail-closed",
      stage: "empty-output",
      error: "adjutant returned an empty digest",
    };
  }
  if (summary.length > maxChars) {
    return {
      status: "summarized",
      summary: `${summary.slice(0, maxChars)}\n[truncated to ${maxChars} chars]`,
      inputChars: params.content.length,
      truncated: true,
    };
  }
  return { status: "summarized", summary, inputChars: params.content.length, truncated: false };
}
