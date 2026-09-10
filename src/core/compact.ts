import * as path from "node:path";
import { defaultStorage, homeOutDirectory } from "./storage.js";
import type { WorkflowSnapshot } from "./workflow.js";

/**
 * v0.5 compact return layer (design §4.5/§6 Tier 0, P-080①②).
 *
 * The leader-facing MCP workflow endpoints return a bounded envelope by
 * default; the full snapshot requires an explicit detail:"full" request. The
 * Tier 0 rule is unconditional engine behavior on top of both modes: any
 * return body over COMPACT_RETURN_LIMIT_CHARS is persisted verbatim under
 * <agentmeshHome>/out/ and replaced by its tail plus the absolute path — a
 * large output never enters the leader's host-side context in the first
 * place. Deterministic, zero tokens, no LLM compression involved.
 */

/** Return-body size above which the Tier 0 spill fires (design: 2KB). */
export const COMPACT_RETURN_LIMIT_CHARS = 2_048;

/** Tail length kept inline by the Tier 0 spill (design: 1.5KB). */
export const COMPACT_TAIL_CHARS = 1_500;

export interface CompactWorkflowFlags {
  /** Unresolved critical/high findings across the terminal evidence chain. */
  unresolvedP0P1: number;
  /** Requirement coverage string from the terminal ledger, e.g. "8/9（1 PENDING_RULING）". */
  coverage?: string;
  /** Terminal anomalies: escalation/failure/needs_ruling markers (lane events arrive in Batch 2). */
  anomalies: string[];
}

export interface CompactWorkflowView {
  workflowId: string;
  name: string;
  status: WorkflowSnapshot["status"];
  stageCount: number;
  stages: Array<{ name: string; status: string }>;
  flags: CompactWorkflowFlags;
  ledgerRef?: string;
  needsRulingIds?: string[];
  note?: string;
}

interface FindingLike {
  severity: string;
  issue: string;
}

/**
 * Counts unresolved critical/high findings: findings attached to a review
 * verdict that is not PASS (initial review or any rework round) are by
 * definition unresolved at terminal — a PASS verdict closes them.
 */
export function collectUnresolvedP0P1(snapshot: WorkflowSnapshot): number {
  let count = 0;
  const countFindings = (findings: readonly FindingLike[]) => {
    for (const finding of findings) {
      if (finding.severity === "critical" || finding.severity === "high") count += 1;
    }
  };
  for (const stage of snapshot.stages) {
    if (!stage.review) continue;
    if (stage.review.verdict !== "PASS") countFindings(stage.review.findings);
    for (const round of stage.review.rounds) {
      if (round.reviewOutcome !== "PASS") countFindings(round.findings);
    }
  }
  return count;
}

/** Builds the leader-facing compact envelope for one workflow snapshot. */
export function buildCompactWorkflowView(
  snapshot: WorkflowSnapshot,
  options: { coverage?: string; note?: string } = {},
): CompactWorkflowView {
  const anomalies: string[] = [];
  if (snapshot.status === "escalated" && snapshot.evidence) {
    anomalies.push(
      `escalated:${snapshot.evidence.stageName}: ${snapshot.evidence.reason.slice(0, 160)}`,
    );
  }
  if (snapshot.status === "failed" && snapshot.failure) {
    anomalies.push(
      `failed:${snapshot.failure.stageName}: ${snapshot.failure.reason.slice(0, 160)}`,
    );
  }
  if (snapshot.status === "needs_ruling") {
    anomalies.push(`needs_ruling:${snapshot.needsRulingIds?.length ?? 0} pending item(s)`);
  }
  return {
    workflowId: snapshot.workflowId,
    name: snapshot.name,
    status: snapshot.status,
    stageCount: snapshot.stages.length,
    stages: snapshot.stages.map((stage) => ({ name: stage.name, status: stage.status })),
    flags: {
      unresolvedP0P1: collectUnresolvedP0P1(snapshot),
      ...(options.coverage ? { coverage: options.coverage } : {}),
      anomalies,
    },
    ...(snapshot.ledgerRef ? { ledgerRef: snapshot.ledgerRef } : {}),
    ...(snapshot.needsRulingIds ? { needsRulingIds: [...snapshot.needsRulingIds] } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
}

export interface Tier0SpillResult {
  /** The (possibly replaced) return text. */
  text: string;
  /** Absolute path of the persisted full body when the spill fired. */
  artifactPath?: string;
}

/**
 * Tier 0 return-time truncation (design §6): bodies at or below the limit
 * pass through untouched; larger bodies are persisted verbatim to
 * <agentmeshHome>/out/<refName>.txt and replaced by a marker + the body's
 * tail. The tail is chosen over the head because the compact envelope and
 * poll views place pointers and flags last.
 */
export function applyTier0ReturnTruncation(
  text: string,
  refName: string,
  options: { homeDir?: string } = {},
): Tier0SpillResult {
  if (text.length <= COMPACT_RETURN_LIMIT_CHARS) return { text };
  const outDir = homeOutDirectory(options.homeDir ?? defaultStorage.resolveHome());
  const filePath = path.join(outDir, `${refName}.txt`);
  defaultStorage.writeFile(filePath, text, { store: "workflows" });
  const replaced =
    `[tier0: return body ${text.length} chars exceeded ${COMPACT_RETURN_LIMIT_CHARS}; ` +
    `full output persisted to ${filePath}; showing the last ${COMPACT_TAIL_CHARS} chars]\n` +
    text.slice(-COMPACT_TAIL_CHARS);
  return { text: replaced, artifactPath: filePath };
}

export interface LedgerCoverageRead {
  coverage?: string;
  error?: string;
}

/**
 * Reads the coverage flag from a terminal ledger file (the engine's own out/
 * product). Missing or corrupt ledger → coverage omitted with an honest
 * error note, never a fabricated ratio.
 */
export function readLedgerCoverage(ledgerRef: string | undefined): LedgerCoverageRead {
  if (!ledgerRef) return {};
  try {
    const raw = defaultStorage.readTextFile(ledgerRef);
    if (raw === undefined) return { error: `ledger file not readable: ${ledgerRef}` };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { rows?: unknown }).rows)
    ) {
      return { error: `ledger file malformed: ${ledgerRef}` };
    }
    const rows = (parsed as { rows: Array<{ status?: unknown }> }).rows;
    const total = rows.length;
    const pass = rows.filter((row) => row.status === "PASS").length;
    const pending = rows.filter((row) => row.status === "PENDING_RULING").length;
    const base = `${pass}/${total}`;
    return {
      coverage: pending > 0 ? `${base}（${pending} PENDING_RULING）` : base,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `ledger coverage unavailable (${message})` };
  }
}
