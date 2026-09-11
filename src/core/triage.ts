import * as crypto from "node:crypto";
import type { WorkflowLane } from "./metrics.js";
import type { RequirementsFile } from "./requirements.js";
import type { WorkflowSpec, WorkflowStageSpec } from "./workflow.js";

/**
 * v0.5 Batch 2 #8 triage engine (design §5): a static, deterministic lane
 * decision computed from the parsed WorkflowSpec (+ requirements set) BEFORE
 * any dispatch runs. Pure function module — no I/O, no clocks, no tokens.
 *
 * Lanes (design §5):
 * - `fast`     — every stage's declared file set is ≤2 entries, the requirements
 *                set exists and every item is covered by at least one acceptance
 *                command `covers`, and no stage declares cross-stage context
 *                plumbing → acceptance-as-review (+ sampling, Batch 2 #9).
 * - `standard` — file set in the 3-5 band without risk markers → worker +
 *                reviewer + rework loop.
 * - `gated`    — file set in the 3-5 band WITH risk markers → the gated
 *                gateway: the run fails closed (GATE_RULING_REQUIRED) unless
 *                the spec carries a `gateRuling` ("standard" | "full").
 * - `full`     — everything else (file set >5, or a fast criterion that fails
 *                without landing in the 3-5 band).
 *
 * `reasons` records one conclusion per criterion (file set, requirements
 * coverage, context plumbing, risk scan) so a fail-closed gate decision carries
 * its own evidence chain.
 */

/**
 * Risk keyword table (design §5, contract-frozen): a case-insensitive
 * substring scan over every stage's taskTemplate. A hit demotes a 3-5-file
 * spec from `standard` to the `gated` gateway.
 */
export const TRIAGE_RISK_KEYWORDS: readonly string[] = [
  "auth",
  "permission",
  "secret",
  "token",
  "password",
  "credential",
  "concurr",
  "lock",
  "race",
  "security",
  "migrate",
  "delete",
  "rm -rf",
];

/** Largest declared file-set size that still qualifies for the fast lane. */
export const FAST_LANE_MAX_FILES = 2;
/** Inclusive upper bound of the standard/gated file-set band (design §5: 3-5). */
export const STANDARD_LANE_MAX_FILES = 5;

/** Default fast-lane sampled-review ratio (design §2: fixed 10-20%, midpoint 15%). */
export const DEFAULT_SAMPLING_RATE = 0.15;

/**
 * Design §5 fixed sampled-review band exposed on the MCP surface: 0 stays 0
 * (explicit disable), any non-zero rate is clamped into [0.1, 0.2]. The engine
 * itself accepts the full 0..1 range so tests can pin both extremes.
 */
export const SAMPLING_RATE_BAND = { min: 0.1, max: 0.2 } as const;

export function clampSamplingRate(rate: number): number {
  if (rate <= 0) return 0;
  return Math.min(SAMPLING_RATE_BAND.max, Math.max(SAMPLING_RATE_BAND.min, rate));
}

/**
 * Batch 2 #9 seeded sampler (design §5): deterministic per (seed, stage) so a
 * run's sampling decisions are auditable after the fact — the same workflowId
 * and stage name always yield the same verdict. The first 32 bits of the
 * SHA-256 of "seed:stage" map to [0,1) and compare against the rate.
 */
export function shouldSampleStage(params: { seed: string; stage: string; rate: number }): boolean {
  if (params.rate <= 0) return false;
  if (params.rate >= 1) return true;
  const hash = crypto.createHash("sha256").update(`${params.seed}:${params.stage}`).digest();
  const value = hash.readUInt32BE(0) / 0x1_0000_0000;
  return value < params.rate;
}

export interface TriageDecision {
  lane: WorkflowLane;
  /** Per-criterion conclusions backing the lane decision (fail-closed evidence). */
  reasons: string[];
}

export interface TriageWorkflowParams {
  spec: WorkflowSpec;
  requirements?: RequirementsFile;
}

/** Declared file-set size of one stage (absent acceptance/files → 0). */
function stageFileCount(stage: WorkflowStageSpec): number {
  return stage.acceptance?.files?.length ?? 0;
}

/** Union of requirement ids covered by any stage's acceptance command `covers`. */
function coveredRequirementIds(spec: WorkflowSpec): Set<string> {
  const covered = new Set<string>();
  for (const stage of spec.stages) {
    for (const command of stage.acceptance?.commands ?? []) {
      if (typeof command !== "string" && command.covers) {
        for (const id of command.covers) covered.add(id);
      }
    }
  }
  return covered;
}

interface RiskHit {
  stage: string;
  keywords: string[];
}

/** Case-insensitive keyword scan over every stage's taskTemplate. */
function scanRiskKeywords(spec: WorkflowSpec): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const stage of spec.stages) {
    const haystack = stage.dispatch.taskTemplate.toLowerCase();
    const keywords = TRIAGE_RISK_KEYWORDS.filter((keyword) => haystack.includes(keyword));
    if (keywords.length > 0) hits.push({ stage: stage.name, keywords });
  }
  return hits;
}

/** Stages that declare cross-stage context plumbing via dispatch.contextPolicy. */
function contextPolicyStages(spec: WorkflowSpec): string[] {
  return spec.stages
    .filter((stage) => stage.dispatch.contextPolicy !== undefined)
    .map((stage) => stage.name);
}

/**
 * Resolves the run lane from the triage decision and the optional gated
 * gateway ruling (design §5, Batch 2 #8 contract): the ruling applies ONLY
 * when triage landed in the gated lane — a ruled gated run proceeds with the
 * ruling value, an unruled one stays "gated" so the engine fails closed.
 */
export function resolveRunLane(
  decision: TriageDecision,
  gateRuling: "standard" | "full" | undefined,
): WorkflowLane {
  if (decision.lane === "gated" && gateRuling !== undefined) return gateRuling;
  return decision.lane;
}

/**
 * Computes the triage lane for one workflow run (design §5, decided in
 * order): fast → standard → gated → full. Every criterion evaluated along
 * the way is recorded in `reasons`, whatever the outcome.
 */
export function triageWorkflow(params: TriageWorkflowParams): TriageDecision {
  const { spec, requirements } = params;
  const reasons: string[] = [];

  const fileCounts = spec.stages.map((stage) => stageFileCount(stage));
  const maxFiles = fileCounts.length > 0 ? Math.max(...fileCounts) : 0;
  const biggestStage = spec.stages[fileCounts.indexOf(maxFiles)]?.name ?? "(none)";
  reasons.push(
    `file-set: max declared acceptance.files across stages = ${maxFiles} (stage '${biggestStage}')`,
  );

  // Requirements coverage (fast criterion 2): absent → the fast lane is
  // excluded by contract; present → every item needs at least one covering
  // acceptance command.
  let fastCoverageOk = false;
  if (requirements === undefined) {
    reasons.push("requirements: no requirements file provided → fast lane excluded");
  } else {
    const covered = coveredRequirementIds(spec);
    const uncovered = requirements.items.map((item) => item.id).filter((id) => !covered.has(id));
    if (uncovered.length > 0) {
      reasons.push(
        `requirements: ${requirements.items.length - uncovered.length}/${requirements.items.length} ` +
          `items covered by acceptance command covers; items [${uncovered.join(", ")}] lack ` +
          "covering command evidence → fast lane excluded",
      );
    } else {
      fastCoverageOk = true;
      reasons.push(
        `requirements: all ${requirements.items.length} items covered by acceptance command covers`,
      );
    }
  }

  // Cross-stage context plumbing (fast criterion 3): the WorkflowSpec schema
  // has no stage-dependency field, so the dependency half is vacuously true;
  // dispatch.contextPolicy is the only declarable cross-stage coupling.
  const policyStages = contextPolicyStages(spec);
  const fastNoContext = policyStages.length === 0;
  reasons.push(
    fastNoContext
      ? "context: no stage declares dispatch.contextPolicy (WorkflowSpec has no cross-stage dependency field)"
      : `context: stage(s) [${policyStages.join(", ")}] declare dispatch.contextPolicy → fast lane excluded`,
  );

  // Risk scan (standard vs gated discriminator inside the 3-5 band).
  const riskHits = scanRiskKeywords(spec);
  const inStandardBand = maxFiles >= 3 && maxFiles <= STANDARD_LANE_MAX_FILES;
  reasons.push(
    riskHits.length === 0
      ? `risk: none of the ${TRIAGE_RISK_KEYWORDS.length} risk keywords matched any stage taskTemplate`
      : `risk: keywords [${riskHits
          .flatMap((hit) => hit.keywords)
          .join(", ")}] matched in stage taskTemplate(s) ` +
          `[${riskHits.map((hit) => hit.stage).join(", ")}]`,
  );

  if (
    maxFiles <= FAST_LANE_MAX_FILES &&
    requirements !== undefined &&
    fastCoverageOk &&
    fastNoContext
  ) {
    return { lane: "fast", reasons };
  }
  if (inStandardBand && riskHits.length === 0) {
    return { lane: "standard", reasons };
  }
  if (inStandardBand && riskHits.length > 0) {
    return { lane: "gated", reasons };
  }
  return { lane: "full", reasons };
}
