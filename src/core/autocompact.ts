import type { SessionHistoryEntry } from "./types.js";

/**
 * v0.5 Batch 3 #13 Tier 2 LLM-compression fallback (design §6).
 *
 * Tier 0 (return truncation) and Tier 1 (rule-based terminal archiving) are
 * deterministic and free; this tier is the LLM bottom line: when an
 * AgentMesh-owned session's estimated token footprint crosses a configured
 * fraction of the context window, the session's own agent condenses its
 * history (compact_context, one LLM call). Scope: AgentMesh sessions only —
 * it cannot reach the host-side leader history (design §6 架构事实).
 *
 * Estimation honesty: metered turns use vendor-reported usage; unmetered turns
 * use a crude chars/4 heuristic. The estimate drives only the trigger decision,
 * never any accounting claim.
 */

/** Usage fraction at/above which compaction triggers (default 70%). */
export const AUTOCOMPACT_DEFAULT_PCT = 70;

/** Assumed context window when none is configured (default 200k tokens). */
export const AUTOCOMPACT_DEFAULT_WINDOW_TOKENS = 200_000;

/** Crude unmetered-turn estimate: one token per ~4 characters. */
export const AUTOCOMPACT_CHARS_PER_TOKEN = 4;

export const AUTOCOMPACT_PCT_ENV = "AGENTMESH_AUTOCOMPACT_PCT";
export const AUTOCOMPACT_WINDOW_ENV = "AGENTMESH_CONTEXT_WINDOW_TOKENS";

export interface AutoCompactConfig {
  /** Trigger percentage of the window; 0 disables Tier 2 entirely. */
  pct: number;
  /** Assumed context-window size in tokens. */
  windowTokens: number;
}

/**
 * Resolves the Tier 2 configuration from the environment. Invalid values fall
 * back to the defaults (fail-safe): the gate must never crash a dispatch over
 * a malformed env var.
 */
export function resolveAutoCompactConfig(env: NodeJS.ProcessEnv = process.env): AutoCompactConfig {
  let pct = AUTOCOMPACT_DEFAULT_PCT;
  const pctRaw = env[AUTOCOMPACT_PCT_ENV];
  if (pctRaw !== undefined && pctRaw.trim() !== "") {
    const parsed = Number(pctRaw);
    if (Number.isFinite(parsed)) pct = Math.min(Math.max(Math.round(parsed), 0), 100);
  }
  let windowTokens = AUTOCOMPACT_DEFAULT_WINDOW_TOKENS;
  const windowRaw = env[AUTOCOMPACT_WINDOW_ENV];
  if (windowRaw !== undefined && windowRaw.trim() !== "") {
    const parsed = Number(windowRaw);
    if (Number.isFinite(parsed) && parsed > 0) windowTokens = Math.round(parsed);
  }
  return { pct, windowTokens };
}

/**
 * Estimates one session's token footprint across its recorded turns: sum of
 * vendor-reported usage where present (input+output), chars/4 heuristic for
 * unmetered turns. An unmetered turn degrades the estimate honestly instead of
 * fabricating precision.
 */
export function estimateSessionTokens(history: readonly SessionHistoryEntry[]): number {
  let total = 0;
  for (const turn of history) {
    const usage = turn.usage;
    if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      total += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      continue;
    }
    const text = [turn.task, turn.summary, turn.finalAnswer].filter(Boolean).join("\n");
    total += Math.ceil(text.length / AUTOCOMPACT_CHARS_PER_TOKEN);
  }
  return total;
}

export interface AutoCompactDecision {
  trigger: boolean;
  estimateTokens: number;
  thresholdTokens: number;
  pct: number;
  windowTokens: number;
}

/** Deterministic trigger decision for one session's history. */
export function evaluateSessionAutoCompact(
  history: readonly SessionHistoryEntry[],
  config: AutoCompactConfig,
): AutoCompactDecision {
  const estimateTokens = estimateSessionTokens(history);
  const thresholdTokens = Math.floor((config.windowTokens * config.pct) / 100);
  return {
    trigger: config.pct > 0 && thresholdTokens > 0 && estimateTokens >= thresholdTokens,
    estimateTokens,
    thresholdTokens,
    pct: config.pct,
    windowTokens: config.windowTokens,
  };
}
