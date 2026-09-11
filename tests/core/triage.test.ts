import { describe, it, expect } from "vitest";
import {
  FAST_LANE_MAX_FILES,
  STANDARD_LANE_MAX_FILES,
  TRIAGE_RISK_KEYWORDS,
  clampSamplingRate,
  resolveRunLane,
  triageWorkflow,
} from "../../src/core/triage.js";
import { parseWorkflowSpec } from "../../src/core/workflow.js";
import type { WorkflowSpec, WorkflowStageSpec } from "../../src/core/workflow.js";
import type { RequirementsFile } from "../../src/core/requirements.js";

/**
 * v0.5 Batch 2 #8: the triage engine (design §5). Pure-function lane decision
 * computed before any dispatch; `reasons` is the fail-closed evidence chain.
 */

const requirements = (ids: string[]): RequirementsFile => ({
  source: "doc.md",
  items: ids.map((id) => ({
    id,
    ears: `The system SHALL deliver ${id}`,
    kind: "unconditional",
    quote: id,
    decidable: true,
  })),
});

const stage = (overrides: Partial<WorkflowStageSpec> & { name: string }): WorkflowStageSpec => ({
  roles: ["worker"],
  dispatch: { taskTemplate: "Build the widget module" },
  ...overrides,
});

const buildSpec = (
  stages: WorkflowStageSpec[],
  gateRuling?: "standard" | "full",
): WorkflowSpec => ({
  name: "triaged",
  stages,
  ...(gateRuling !== undefined ? { gateRuling } : {}),
});

const coveredCommand = (covers: string[]) => ({ cmd: `node -e "process.exit(0)"`, covers });

describe("core/triage (v0.5 Batch 2 #8 lane decision)", () => {
  it("assigns fast when file sets are ≤2, requirements exist and every item is covered", () => {
    const spec = buildSpec([
      stage({
        name: "implement",
        acceptance: {
          commands: [coveredCommand(["R1"]), coveredCommand(["R2"])],
          files: ["src/a.ts", "src/b.ts"],
        },
      }),
    ]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1", "R2"]) });
    expect(decision.lane).toBe("fast");
    expect(decision.reasons.join("\n")).toContain("all 2 items covered");
    expect(decision.reasons.join("\n")).toContain("no stage declares dispatch.contextPolicy");
  });

  it("assigns standard for a 3-5 file set without risk markers", () => {
    const spec = buildSpec([
      stage({
        name: "implement",
        dispatch: { taskTemplate: "Build the widget module" },
        acceptance: {
          commands: [coveredCommand(["R1"])],
          files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
        },
      }),
    ]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1"]) });
    expect(decision.lane).toBe("standard");
    expect(decision.reasons.join("\n")).toContain("= 4 (stage 'implement')");
    expect(decision.reasons.join("\n")).toContain("none of the");
  });

  it("assigns gated for a 3-5 file set with a risk keyword and reports the hit", () => {
    const spec = buildSpec([
      stage({
        name: "implement",
        dispatch: { taskTemplate: "Rotate the session AUTH handling" },
        acceptance: {
          commands: [coveredCommand(["R1"])],
          files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        },
      }),
    ]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1"]) });
    expect(decision.lane).toBe("gated");
    expect(decision.reasons.join("\n")).toContain("auth");
    expect(decision.reasons.join("\n")).toContain("stage 'implement'");
  });

  it("assigns full when any stage declares more than five files", () => {
    const spec = buildSpec([
      stage({
        name: "small",
        acceptance: { commands: [coveredCommand(["R1"])], files: ["a.ts"] },
      }),
      stage({
        name: "wide",
        acceptance: {
          commands: [coveredCommand(["R1"])],
          files: ["1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts"],
        },
      }),
    ]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1"]) });
    expect(decision.lane).toBe("full");
    expect(decision.reasons.join("\n")).toContain("= 6 (stage 'wide')");
  });

  it("excludes the fast lane when the requirements file is absent", () => {
    const spec = buildSpec([
      stage({
        name: "implement",
        acceptance: { commands: [`node -e "process.exit(0)"`], files: ["a.ts"] },
      }),
    ]);
    const decision = triageWorkflow({ spec });
    expect(decision.lane).toBe("full");
    expect(decision.reasons.join("\n")).toContain("no requirements file provided");
  });

  it("excludes the fast lane when a requirement lacks covering command evidence", () => {
    const spec = buildSpec([
      stage({
        name: "implement",
        acceptance: {
          commands: [coveredCommand(["R1"])],
          files: ["a.ts", "b.ts"],
        },
      }),
    ]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1", "R2"]) });
    expect(decision.lane).toBe("full");
    expect(decision.reasons.join("\n")).toContain("items [R2] lack covering command evidence");
  });

  it("excludes the fast lane when a stage declares dispatch.contextPolicy", () => {
    const spec = buildSpec([
      stage({
        name: "implement",
        acceptance: { commands: [coveredCommand(["R1"])], files: ["a.ts", "b.ts"] },
      }),
      stage({
        name: "handoff",
        dispatch: {
          taskTemplate: "Build the widget module",
          contextPolicy: { contextSessionIds: "upstream" },
        },
      }),
    ]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1"]) });
    expect(decision.lane).toBe("full");
    expect(decision.reasons.join("\n")).toContain(
      "stage(s) [handoff] declare dispatch.contextPolicy",
    );
  });

  it("scans risk keywords case-insensitively across the frozen table", () => {
    expect(TRIAGE_RISK_KEYWORDS).toContain("auth");
    expect(TRIAGE_RISK_KEYWORDS).toContain("rm -rf");
    const spec = buildSpec([
      stage({
        name: "implement",
        dispatch: { taskTemplate: "Purge cache then DELETE stale rows" },
        acceptance: {
          commands: [coveredCommand(["R1"])],
          files: ["a.ts", "b.ts", "c.ts"],
        },
      }),
    ]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1"]) });
    expect(decision.lane).toBe("gated");
    expect(decision.reasons.join("\n")).toContain("delete");
  });

  it("treats a stage without acceptance as a zero-size file set", () => {
    const spec = buildSpec([stage({ name: "review", roles: ["reviewer"] })]);
    const decision = triageWorkflow({ spec, requirements: requirements(["R1"]) });
    // No acceptance at all → no covers anywhere → fast excluded; size 0 →
    // outside the 3-5 band → full.
    expect(decision.lane).toBe("full");
    expect(decision.reasons.join("\n")).toContain("= 0 (stage 'review')");
  });

  it("keeps the file-set band bounds in sync with the design contract", () => {
    expect(FAST_LANE_MAX_FILES).toBe(2);
    expect(STANDARD_LANE_MAX_FILES).toBe(5);
  });
});

describe("core/triage (gated gateway run-lane resolution)", () => {
  const gated = { lane: "gated" as const, reasons: ["risk: keywords [auth] matched"] };

  it("keeps gated when no gateRuling is provided (engine fails closed)", () => {
    expect(resolveRunLane(gated, undefined)).toBe("gated");
  });

  it("takes the ruling value when a gated spec carries gateRuling", () => {
    expect(resolveRunLane(gated, "standard")).toBe("standard");
    expect(resolveRunLane(gated, "full")).toBe("full");
  });

  it("ignores the ruling for non-gated lanes", () => {
    expect(resolveRunLane({ lane: "fast", reasons: [] }, "full")).toBe("fast");
    expect(resolveRunLane({ lane: "standard", reasons: [] }, "full")).toBe("standard");
  });
});

describe("core/triage (WorkflowSpec gateRuling schema field)", () => {
  const baseStage = stage({ name: "s1" });

  it("accepts gateRuling standard and full on the top-level spec", () => {
    for (const gateRuling of ["standard", "full"] as const) {
      const parsed = parseWorkflowSpec(buildSpec([baseStage], gateRuling));
      expect(parsed.success).toBe(true);
      expect(parsed.spec?.gateRuling).toBe(gateRuling);
    }
  });

  it("leaves gateRuling undefined when absent and rejects unknown values", () => {
    const absent = parseWorkflowSpec(buildSpec([baseStage]));
    expect(absent.success).toBe(true);
    expect(absent.spec?.gateRuling).toBeUndefined();

    const bogus = parseWorkflowSpec({ ...buildSpec([baseStage]), gateRuling: "fast" });
    expect(bogus.success).toBe(false);
  });
});

describe("core/triage (MCP sampling-rate clamp, Batch 2 #9)", () => {
  it("keeps 0 as the explicit disable switch", () => {
    expect(clampSamplingRate(0)).toBe(0);
  });

  it("clamps non-zero values into the design band 0.1-0.2", () => {
    expect(clampSamplingRate(0.05)).toBe(0.1);
    expect(clampSamplingRate(0.1)).toBe(0.1);
    expect(clampSamplingRate(0.15)).toBe(0.15);
    expect(clampSamplingRate(0.2)).toBe(0.2);
    expect(clampSamplingRate(0.9)).toBe(0.2);
    expect(clampSamplingRate(1)).toBe(0.2);
  });
});
