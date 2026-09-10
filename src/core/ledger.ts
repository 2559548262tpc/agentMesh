import type { WorkflowSnapshot, WorkflowSpec } from "./workflow.js";
import type { RequirementItem, RequirementsFile } from "./requirements.js";

/**
 * v0.5 Reconciliation Ledger — engine join product (design §4.4).
 *
 * Built deterministically at workflow terminal from data the engine already
 * holds: the requirements set (row universe), the spec's per-stage
 * `requirements` declarations + acceptance `covers`, and the snapshot's stage
 * outcomes + acceptance command results. No LLM output is trusted and none is
 * needed — the ledger is pure internal data.
 *
 * Row status semantics (fail-closed):
 * - PASS requires EVERY stage declaring the requirement to have passed AND at
 *   least one covering acceptance command to have exited 0 in each of them —
 *   a stage that declares a requirement without covering command evidence
 *   cannot prove it, so the row stays PENDING_RULING (never silently PASS).
 * - ESCALATED/FAIL dominate: a declaring stage that escalated/failed drags the
 *   row down regardless of other stages (cross-stage conjunction, design §4.4).
 * - A requirement never declared by any stage has no evidence path at all and
 *   lands in PENDING_RULING — nothing is dropped from the accounting.
 *
 * Terminal semantics: any PENDING_RULING row flips a would-be `done` workflow
 * to `needs_ruling` — the fast lane must not finish quietly with unruled items.
 */

export type LedgerRowStatus = "PASS" | "FAIL" | "ESCALATED" | "PENDING_RULING";

export interface LedgerCommandEvidence {
  cmd: string;
  exitCode?: number;
  covers: string[];
  ok: boolean;
}

export interface LedgerContractMapEvidence {
  file: string;
  line: number;
  verified: boolean;
}

export interface LedgerRow {
  id: string;
  ears: string;
  quote: string;
  status: LedgerRowStatus;
  evidence: {
    commands: LedgerCommandEvidence[];
    contractMap: LedgerContractMapEvidence[];
    findings: string[];
  };
}

export interface LedgerInvariant {
  requirements: number;
  rows: number;
  ok: boolean;
}

export interface ReconciliationLedger {
  workflowId: string;
  workflowName: string;
  rows: LedgerRow[];
  invariant: LedgerInvariant;
  /** Requirement ids declared by the spec but absent from the requirements set. */
  unknownIds: string[];
  /** Requirement ids never declared by any stage (no evidence path possible). */
  uncoveredIds: string[];
  generatedAt: string;
}

/** Worst-status aggregation order (higher wins). */
const STATUS_RANK: Record<LedgerRowStatus, number> = {
  PASS: 0,
  PENDING_RULING: 1,
  FAIL: 2,
  ESCALATED: 3,
};

function worstStatus(statuses: LedgerRowStatus[]): LedgerRowStatus {
  return statuses.reduce<LedgerRowStatus>(
    (worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
    "PASS",
  );
}

function findingLines(snapshot: WorkflowSnapshot, stageName: string): string[] {
  const stage = snapshot.stages.find((record) => record.name === stageName);
  if (!stage?.review) return [];
  const lines: string[] = [];
  const push = (
    verdictLabel: string,
    findings: Array<{ severity: string; file: string; issue: string }>,
  ) => {
    for (const finding of findings) {
      lines.push(`[${verdictLabel}] ${finding.severity}: ${finding.file} — ${finding.issue}`);
    }
  };
  if (stage.review.verdict !== "PASS")
    push(`review ${stage.review.verdict}`, stage.review.findings);
  for (const round of stage.review.rounds) {
    if (round.reviewOutcome !== "PASS") push(`rework round ${round.round}`, round.findings);
  }
  return lines;
}

export interface BuildLedgerParams {
  workflowId: string;
  spec: WorkflowSpec;
  snapshot: WorkflowSnapshot;
  requirements: RequirementsFile;
}

/**
 * Joins spec × snapshot × requirements into the terminal ledger. Pure:
 * no I/O, no clock (generatedAt injected by the caller for determinism in
 * tests via `nowIso`).
 */
export function buildLedger(params: BuildLedgerParams & { nowIso: string }): ReconciliationLedger {
  const { spec, snapshot, requirements } = params;
  const declaredIds = new Set(spec.stages.flatMap((stage) => stage.requirements ?? []));
  const knownIds = new Set(requirements.items.map((item) => item.id));

  const rows: LedgerRow[] = requirements.items.map((item: RequirementItem) => {
    const declaringStages = spec.stages.filter((stage) =>
      (stage.requirements ?? []).includes(item.id),
    );
    const commands: LedgerCommandEvidence[] = [];
    const findings: string[] = [];
    const contributions: LedgerRowStatus[] = [];

    if (declaringStages.length === 0) {
      findings.push("No stage declares this requirement; no evidence path exists.");
      contributions.push("PENDING_RULING");
    }

    for (const stageSpec of declaringStages) {
      const record = snapshot.stages.find(
        (candidate) =>
          candidate.name === stageSpec.name && candidate.index === spec.stages.indexOf(stageSpec),
      );
      const recordStatus = record?.status;
      const coveringCommands = (record?.acceptance?.commands ?? []).filter((command) =>
        (command.covers ?? []).includes(item.id),
      );
      for (const command of coveringCommands) {
        commands.push({
          cmd: command.command,
          ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
          covers: command.covers ?? [],
          ok: command.ok,
        });
      }
      findings.push(...findingLines(snapshot, stageSpec.name));

      if (recordStatus === "escalated") {
        contributions.push("ESCALATED");
      } else if (recordStatus === "failed") {
        contributions.push("FAIL");
      } else if (recordStatus === "passed") {
        const covered = coveringCommands.length > 0;
        const coveringPassed = coveringCommands.every((command) => command.ok);
        contributions.push(covered && coveringPassed ? "PASS" : "PENDING_RULING");
      } else {
        // Stage never reached or still incomplete when the workflow stopped:
        // no machine evidence for this requirement.
        findings.push(
          recordStatus
            ? `Stage '${stageSpec.name}' ended in status '${recordStatus}' without passing.`
            : `Stage '${stageSpec.name}' was never reached.`,
        );
        contributions.push("PENDING_RULING");
      }
    }

    return {
      id: item.id,
      // Undecidable items carry no EARS sentence yet — the quote keeps the row
      // self-describing until the leader rules it into EARS form.
      ears: item.ears ?? item.quote,
      quote: item.quote,
      status: worstStatus(contributions),
      evidence: { commands, contractMap: [], findings },
    };
  });

  const statusCounts = rows.reduce<Record<LedgerRowStatus, number>>(
    (counts, row) => {
      counts[row.status] += 1;
      return counts;
    },
    { PASS: 0, FAIL: 0, ESCALATED: 0, PENDING_RULING: 0 },
  );

  // 对数硬不变量 (fail-closed): rows must equal the requirement universe and
  // the per-status counts must sum back to it. Computed independently of the
  // construction above so a future join bug cannot silently drop accounts.
  const invariant: LedgerInvariant = {
    requirements: requirements.items.length,
    rows: rows.length,
    ok:
      rows.length === requirements.items.length &&
      statusCounts.PASS +
        statusCounts.FAIL +
        statusCounts.ESCALATED +
        statusCounts.PENDING_RULING ===
        requirements.items.length,
  };

  return {
    workflowId: params.workflowId,
    workflowName: spec.name,
    rows,
    invariant,
    unknownIds: [...declaredIds].filter((id) => !knownIds.has(id)).sort(),
    uncoveredIds: [...knownIds].filter((id) => !declaredIds.has(id)).sort(),
    generatedAt: params.nowIso,
  };
}

/** True when the workflow must terminate as needs_ruling instead of done. */
export function needsRuling(ledger: ReconciliationLedger): boolean {
  return ledger.rows.some((row) => row.status === "PENDING_RULING");
}

/**
 * Run-start validation (fail-closed): every requirement id declared by the
 * spec must exist in the requirements set — a declared id without a row would
 * silently drop accounts, which the ledger forbids. Returns the offending ids.
 */
export function findUnknownRequirementIds(
  spec: WorkflowSpec,
  requirements: RequirementsFile,
): string[] {
  const known = new Set(requirements.items.map((item) => item.id));
  return [...new Set(spec.stages.flatMap((stage) => stage.requirements ?? []))]
    .filter((id) => !known.has(id))
    .sort();
}

/** Ruled requirement ids still awaiting human decision. */
export function pendingRulingIds(ledger: ReconciliationLedger): string[] {
  return ledger.rows.filter((row) => row.status === "PENDING_RULING").map((row) => row.id);
}

/**
 * Coverage string for the compact contract (design §4.5), e.g. "8/9（1 PENDING_RULING）".
 * PASS rows count towards coverage; everything else is outstanding.
 */
export function formatCoverage(ledger: ReconciliationLedger): string {
  const total = ledger.rows.length;
  const pass = ledger.rows.filter((row) => row.status === "PASS").length;
  const pending = ledger.rows.filter((row) => row.status === "PENDING_RULING").length;
  const base = `${pass}/${total}`;
  return pending > 0 ? `${base}（${pending} PENDING_RULING）` : base;
}
