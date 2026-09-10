import type { BridgeSession, SessionHistoryEntry } from "./types.js";
import { truncateText } from "./text.js";

/**
 * v0.5 Tier 1 rule-based cleanup (design §6): at workflow terminal, the
 * AgentMesh-owned Bridge sessions of a finished workflow have their bulky raw
 * payloads replaced by a pointer placeholder — zero tokens, deterministic.
 *
 * Scope honesty: this ONLY touches AgentMesh-side session storage. The
 * leader's host-side history cannot be rewritten by the engine (design §6
 * hard boundary); leader-side protection is Tier 0 return-time truncation.
 *
 * What survives archiving per turn: `summary`, `findings`, usage, evidence —
 * the compact fields downstream `contextSessionIds` reuse actually needs.
 * What is replaced: the full `task` prompt echo and the full `finalAnswer`
 * body (the O(n) payloads that make O(n²) leader-side accumulation possible
 * when re-injected wholesale).
 */

/** Placeholder written into archived payload fields. */
export function archivePlaceholder(ledgerRef: string): string {
  return `[archived → ${ledgerRef}]`;
}

/** Kept verbatim at the head of an archived task echo for identification. */
const ARCHIVED_TASK_ECHO_CHARS = 200;

export interface ArchiveSessionOptions {
  /** Pointer (path) the placeholder references — usually the ledger file. */
  ledgerRef: string;
  /**
   * Turn indexes (0-based) to keep fully intact — the last executed stage's
   * most recent turns, so the freshest context survives verbatim.
   */
  keepTurnIndexes?: ReadonlySet<number>;
}

/** Builds the archived form of one history entry (pure). */
function archiveEntry(
  entry: SessionHistoryEntry,
  placeholder: string,
  keep: boolean,
): SessionHistoryEntry {
  if (keep) return entry;
  const taskEcho = entry.task ? truncateText(entry.task, ARCHIVED_TASK_ECHO_CHARS) : "";
  return {
    ...entry,
    task: taskEcho ? `${taskEcho} ${placeholder}` : placeholder,
    ...(entry.finalAnswer !== undefined ? { finalAnswer: placeholder } : {}),
  };
}

/**
 * Returns the archived history for one session (pure): every turn is
 * placeholder-archived except the indexes listed in `keepTurnIndexes`.
 * Sessions with no history are returned unchanged.
 */
export function archiveSessionHistory(
  session: BridgeSession,
  options: ArchiveSessionOptions,
): SessionHistoryEntry[] {
  const placeholder = archivePlaceholder(options.ledgerRef);
  const keep = options.keepTurnIndexes;
  return session.history.map((entry, index) =>
    archiveEntry(entry, placeholder, keep?.has(index) ?? false),
  );
}

/** Summarizes one archive pass for the engine's evidence trail. */
export interface ArchiveSessionReport {
  sessionId: string;
  archivedTurns: number;
  keptTurns: number;
}
