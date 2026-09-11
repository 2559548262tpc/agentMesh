import { describe, it, expect } from "vitest";
import type { AgentResult } from "../../src/agents/types.js";
import {
  ADJUTANT_PROBE_TASK,
  DEFAULT_SUMMARY_MAX_CHARS,
  DISTILL_MAX_ATTEMPTS,
  SUMMARY_MAX_CHARS_CEILING,
  SUMMARY_MIN_CHARS,
  buildDistillTaskText,
  buildSchemaRetryTaskText,
  buildSummarizeTaskText,
  clampSummaryMaxChars,
  extractJsonPayload,
  runDistillRequirements,
  runSummarizeForLeader,
  type AdjutantDispatch,
} from "../../src/core/adjutant.js";

/**
 * v0.5 Batch 2 #7 adjutant channel. The dispatch seam is scripted in-process;
 * the tests pin the design's fail-closed discipline: probe-first, the single
 * schema retry budget, the zero-retry quote gate, and deterministic summary
 * truncation.
 */

/** A document whose quotes the fixtures copy verbatim (the mechanical gate). */
const DOCUMENT = [
  "# 借阅系统需求",
  "",
  "## 2.1 借阅",
  "- WHEN 借阅数 > 当前库存 THEN 系统 SHALL 返回 400 且不修改库存",
  "- IF ISBN 非法 THEN 系统 SHALL 返回 422",
  "",
  "## 5.2 界面",
  "- 界面要美观大方",
].join("\n");

const SOURCE_NAME = "需求文档 v3.md";

const VALID_REQUIREMENTS_JSON = {
  source: SOURCE_NAME,
  items: [
    {
      id: "R1",
      ears: "WHEN 借阅数 > 当前库存 THEN 系统 SHALL 返回 400 且不修改库存",
      kind: "event-driven",
      quote: "WHEN 借阅数 > 当前库存 THEN 系统 SHALL 返回 400 且不修改库存",
      decidable: true,
    },
    {
      id: "R2",
      ears: "IF ISBN 非法 THEN 系统 SHALL 返回 422",
      kind: "exception",
      quote: "IF ISBN 非法 THEN 系统 SHALL 返回 422",
      decidable: true,
    },
    {
      id: "R3",
      ears: null,
      kind: null,
      quote: "界面要美观大方",
      decidable: false,
    },
  ],
};

function okResult(answer: string): AgentResult {
  return {
    status: "success",
    agent: "opencode",
    summary: "done",
    output: answer,
    finalAnswer: answer,
  };
}

function failedResult(error: string): AgentResult {
  return { status: "failed", agent: "opencode", summary: error, output: error, error };
}

/** Scripted dispatch: results consumed in order, the last repeats for overflow. */
function scriptedDispatch(results: Array<AgentResult | ((task: string) => AgentResult)>): {
  dispatch: AdjutantDispatch;
  tasks: string[];
} {
  const tasks: string[] = [];
  let index = 0;
  return {
    tasks,
    dispatch: async ({ task }) => {
      tasks.push(task);
      const entry = results[Math.min(index, results.length - 1)]!;
      index += 1;
      return typeof entry === "function" ? entry(task) : entry;
    },
  };
}

describe("core/adjutant (v0.5 Batch 2 #7)", () => {
  describe("extractJsonPayload", () => {
    it("parses a clean JSON object", () => {
      expect(extractJsonPayload('{"a":1}')).toEqual({ a: 1 });
    });

    it("parses a fenced JSON object", () => {
      expect(extractJsonPayload('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it("parses a JSON object embedded in prose", () => {
      expect(extractJsonPayload('Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
    });

    it("returns undefined for unparseable output", () => {
      expect(extractJsonPayload("no json here")).toBeUndefined();
      expect(extractJsonPayload("")).toBeUndefined();
      expect(extractJsonPayload('{"a":1')).toBeUndefined();
    });
  });

  describe("clampSummaryMaxChars", () => {
    it("defaults to the design default", () => {
      expect(clampSummaryMaxChars(undefined)).toBe(DEFAULT_SUMMARY_MAX_CHARS);
    });

    it("clamps into the 200..8000 band", () => {
      expect(clampSummaryMaxChars(10)).toBe(SUMMARY_MIN_CHARS);
      expect(clampSummaryMaxChars(99_999)).toBe(SUMMARY_MAX_CHARS_CEILING);
      expect(clampSummaryMaxChars(1_500)).toBe(1_500);
    });
  });

  describe("runDistillRequirements", () => {
    it("distills on the first attempt when the output validates and quotes verify", async () => {
      const { dispatch, tasks } = scriptedDispatch([
        okResult("OK"),
        okResult(JSON.stringify(VALID_REQUIREMENTS_JSON)),
      ]);
      const outcome = await runDistillRequirements(dispatch, {
        document: DOCUMENT,
        sourceName: SOURCE_NAME,
      });
      expect(outcome.status).toBe("distilled");
      if (outcome.status !== "distilled") return;
      expect(outcome.requirements.items).toHaveLength(3);
      expect(outcome.schemaRetriesUsed).toBe(0);
      expect(outcome.quoteReport.pass).toBe(true);
      expect(outcome.countCheck.plausible).toBe(true);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toBe(ADJUTANT_PROBE_TASK);
      expect(tasks[1]!).toContain("REQUIREMENT DOCUMENT START");
    });

    it("fails closed on a failed probe with exactly one dispatch", async () => {
      const { dispatch, tasks } = scriptedDispatch([failedResult("quota exhausted")]);
      const outcome = await runDistillRequirements(dispatch, {
        document: DOCUMENT,
        sourceName: SOURCE_NAME,
      });
      expect(outcome).toEqual({ status: "probe-failed", error: "quota exhausted" });
      expect(tasks).toHaveLength(1);
    });

    it("fails closed on a real-task dispatch failure without retrying", async () => {
      const { dispatch, tasks } = scriptedDispatch([okResult("OK"), failedResult("vendor 503")]);
      const outcome = await runDistillRequirements(dispatch, {
        document: DOCUMENT,
        sourceName: SOURCE_NAME,
      });
      expect(outcome).toEqual({ status: "dispatch-failed", error: "vendor 503" });
      expect(tasks).toHaveLength(2);
    });

    it("retries exactly once on schema-invalid output and succeeds with the issues attached", async () => {
      const bad = JSON.stringify({ source: SOURCE_NAME, items: [{ id: "X1" }] });
      const { dispatch, tasks } = scriptedDispatch([
        okResult("OK"),
        okResult(bad),
        okResult(JSON.stringify(VALID_REQUIREMENTS_JSON)),
      ]);
      const outcome = await runDistillRequirements(dispatch, {
        document: DOCUMENT,
        sourceName: SOURCE_NAME,
      });
      expect(outcome.status).toBe("distilled");
      if (outcome.status !== "distilled") return;
      expect(outcome.schemaRetriesUsed).toBe(1);
      expect(tasks).toHaveLength(1 + DISTILL_MAX_ATTEMPTS);
      // The retry task must carry the exact issues and the previous JSON.
      expect(tasks[2]).toContain("VALIDATION FEEDBACK");
      expect(tasks[2]).toContain(bad);
    });

    it("fails closed after exhausting the schema retry budget", async () => {
      const bad = JSON.stringify({ source: SOURCE_NAME, items: [{ id: "X1" }] });
      const { dispatch, tasks } = scriptedDispatch([okResult("OK"), okResult(bad), okResult(bad)]);
      const outcome = await runDistillRequirements(dispatch, {
        document: DOCUMENT,
        sourceName: SOURCE_NAME,
      });
      expect(outcome.status).toBe("fail-closed");
      if (outcome.status !== "fail-closed") return;
      expect(outcome.stage).toBe("schema");
      expect(outcome.issues.length).toBeGreaterThan(0);
      expect(tasks).toHaveLength(3);
    });

    it("fails closed on a fabricated quote with ZERO retries (anti-fabrication gate)", async () => {
      const fabricated = {
        ...VALID_REQUIREMENTS_JSON,
        items: [
          {
            ...VALID_REQUIREMENTS_JSON.items[0]!,
            quote: "库存不足时不能借出（编造的引用）",
          },
          ...VALID_REQUIREMENTS_JSON.items.slice(1),
        ],
      };
      const { dispatch, tasks } = scriptedDispatch([
        okResult("OK"),
        okResult(JSON.stringify(fabricated)),
      ]);
      const outcome = await runDistillRequirements(dispatch, {
        document: DOCUMENT,
        sourceName: SOURCE_NAME,
      });
      expect(outcome.status).toBe("fail-closed");
      if (outcome.status !== "fail-closed") return;
      expect(outcome.stage).toBe("quote");
      expect(outcome.issues[0]).toContain("R1");
      // Probe + 1 attempt only: quote fabrication never earns a retry.
      expect(tasks).toHaveLength(2);
    });
  });

  describe("runSummarizeForLeader", () => {
    const LONG_OUTPUT = "ERROR detail\n".repeat(500);

    it("returns the digest with input/output accounting", async () => {
      const { dispatch, tasks } = scriptedDispatch([
        okResult("OK"),
        okResult("FAILED: exit 1 in tests/core/x.test.ts — root cause: missing fixture"),
      ]);
      const outcome = await runSummarizeForLeader(dispatch, {
        content: LONG_OUTPUT,
        focus: "why did the test run fail",
      });
      expect(outcome.status).toBe("summarized");
      if (outcome.status !== "summarized") return;
      expect(outcome.truncated).toBe(false);
      expect(outcome.inputChars).toBe(LONG_OUTPUT.length);
      expect(outcome.summary).toContain("exit 1");
      expect(tasks[1]).toBe(
        buildSummarizeTaskText({
          content: LONG_OUTPUT,
          focus: "why did the test run fail",
          maxChars: DEFAULT_SUMMARY_MAX_CHARS,
        }),
      );
    });

    it("deterministically truncates an over-ceiling digest with a flag", async () => {
      const oversized = "x".repeat(DEFAULT_SUMMARY_MAX_CHARS + 100);
      const { dispatch } = scriptedDispatch([okResult("OK"), okResult(oversized)]);
      const outcome = await runSummarizeForLeader(dispatch, { content: LONG_OUTPUT });
      expect(outcome.status).toBe("summarized");
      if (outcome.status !== "summarized") return;
      expect(outcome.truncated).toBe(true);
      expect(outcome.summary).toContain("[truncated to 2000 chars]");
    });

    it("fails closed on probe failure", async () => {
      const { dispatch } = scriptedDispatch([failedResult("model dead")]);
      const outcome = await runSummarizeForLeader(dispatch, { content: LONG_OUTPUT });
      expect(outcome).toEqual({ status: "probe-failed", error: "model dead" });
    });

    it("fails closed on an empty digest", async () => {
      const { dispatch } = scriptedDispatch([okResult("OK"), okResult("   ")]);
      const outcome = await runSummarizeForLeader(dispatch, { content: LONG_OUTPUT });
      expect(outcome).toEqual({
        status: "fail-closed",
        stage: "empty-output",
        error: "adjutant returned an empty digest",
      });
    });

    it("fails closed on a dispatch failure without retrying", async () => {
      const { dispatch, tasks } = scriptedDispatch([okResult("OK"), failedResult("stalled")]);
      const outcome = await runSummarizeForLeader(dispatch, { content: LONG_OUTPUT });
      expect(outcome).toEqual({ status: "dispatch-failed", error: "stalled" });
      expect(tasks).toHaveLength(2);
    });
  });

  describe("task text builders", () => {
    it("the distill task pins the verbatim-quote rule and the source name", () => {
      const text = buildDistillTaskText({ sourceName: SOURCE_NAME, document: DOCUMENT });
      expect(text).toContain("VERBATIM");
      expect(text).toContain(SOURCE_NAME);
      expect(text).toContain(DOCUMENT);
      expect(text).toContain("decidable");
    });

    it("the schema-retry task embeds the issues and the previous JSON", () => {
      const text = buildSchemaRetryTaskText({
        sourceName: SOURCE_NAME,
        document: DOCUMENT,
        previousJson: '{"bad":true}',
        issues: ["R1: kind mismatch"],
      });
      expect(text).toContain("VALIDATION FEEDBACK");
      expect(text).toContain("- R1: kind mismatch");
      expect(text).toContain('{"bad":true}');
    });

    it("the summarize task states the ceiling and the focus", () => {
      const text = buildSummarizeTaskText({
        content: "body",
        focus: "exit codes",
        maxChars: 1_200,
      });
      expect(text).toContain("1200 characters");
      expect(text).toContain("exit codes");
      expect(text).toContain("body");
    });
  });
});
