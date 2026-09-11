import { describe, it, expect } from "vitest";
import type { SessionHistoryEntry } from "../../src/core/types.js";
import {
  AUTOCOMPACT_CHARS_PER_TOKEN,
  AUTOCOMPACT_DEFAULT_PCT,
  AUTOCOMPACT_DEFAULT_WINDOW_TOKENS,
  estimateSessionTokens,
  evaluateSessionAutoCompact,
  resolveAutoCompactConfig,
} from "../../src/core/autocompact.js";

/**
 * v0.5 Batch 3 #13 Tier 2 autocompact trigger math. Pure-logic tests; the
 * runner-level trigger behavior (compact actually firing on crossing) lives in
 * tests/core/runner.test.ts.
 */

function entry(
  task: string,
  usage?: { inputTokens?: number; outputTokens?: number },
): SessionHistoryEntry {
  return {
    role: "worker",
    task,
    timestamp: new Date().toISOString(),
    status: "success",
    summary: "did things",
    ...(usage ? { usage } : {}),
  };
}

describe("core/autocompact (v0.5 Batch 3 #13)", () => {
  describe("resolveAutoCompactConfig", () => {
    it("defaults to 70% of a 200k window", () => {
      expect(resolveAutoCompactConfig({})).toEqual({
        pct: AUTOCOMPACT_DEFAULT_PCT,
        windowTokens: AUTOCOMPACT_DEFAULT_WINDOW_TOKENS,
      });
    });

    it("reads pct and window from the environment", () => {
      expect(
        resolveAutoCompactConfig({
          AGENTMESH_AUTOCOMPACT_PCT: "50",
          AGENTMESH_CONTEXT_WINDOW_TOKENS: "8000",
        }),
      ).toEqual({ pct: 50, windowTokens: 8000 });
    });

    it("clamps pct into 0..100 and treats 0 as the disable switch", () => {
      expect(resolveAutoCompactConfig({ AGENTMESH_AUTOCOMPACT_PCT: "150" }).pct).toBe(100);
      expect(resolveAutoCompactConfig({ AGENTMESH_AUTOCOMPACT_PCT: "-5" }).pct).toBe(0);
      expect(resolveAutoCompactConfig({ AGENTMESH_AUTOCOMPACT_PCT: "0" }).pct).toBe(0);
    });

    it("falls back to defaults on malformed values (fail-safe)", () => {
      expect(resolveAutoCompactConfig({ AGENTMESH_AUTOCOMPACT_PCT: "abc" })).toEqual({
        pct: AUTOCOMPACT_DEFAULT_PCT,
        windowTokens: AUTOCOMPACT_DEFAULT_WINDOW_TOKENS,
      });
      expect(resolveAutoCompactConfig({ AGENTMESH_CONTEXT_WINDOW_TOKENS: "-3" }).windowTokens).toBe(
        AUTOCOMPACT_DEFAULT_WINDOW_TOKENS,
      );
      expect(resolveAutoCompactConfig({ AGENTMESH_CONTEXT_WINDOW_TOKENS: "" }).windowTokens).toBe(
        AUTOCOMPACT_DEFAULT_WINDOW_TOKENS,
      );
    });
  });

  describe("estimateSessionTokens", () => {
    it("sums vendor-reported usage on metered turns", () => {
      const history = [
        entry("a", { inputTokens: 100, outputTokens: 20 }),
        entry("b", { inputTokens: 50, outputTokens: 10 }),
      ];
      expect(estimateSessionTokens(history)).toBe(180);
    });

    it("estimates chars/4 on unmetered turns (honest heuristic, no fabrication)", () => {
      const task = "x".repeat(400);
      const history = [entry(task)];
      expect(estimateSessionTokens(history)).toBe(
        Math.ceil((400 + "did things".length) / AUTOCOMPACT_CHARS_PER_TOKEN),
      );
    });

    it("mixes metered and unmetered turns", () => {
      const unmetered = entry("y".repeat(80));
      const metered = entry("z", { inputTokens: 100, outputTokens: 0 });
      expect(estimateSessionTokens([unmetered, metered])).toBe(
        Math.ceil((80 + "did things".length) / AUTOCOMPACT_CHARS_PER_TOKEN) + 100,
      );
    });

    it("returns zero for an empty history", () => {
      expect(estimateSessionTokens([])).toBe(0);
    });
  });

  describe("evaluateSessionAutoCompact", () => {
    const config = { pct: 70, windowTokens: 1_000 };

    it("does not trigger below the threshold", () => {
      const history = [entry("a", { inputTokens: 300, outputTokens: 0 })];
      const decision = evaluateSessionAutoCompact(history, config);
      expect(decision.trigger).toBe(false);
      expect(decision.estimateTokens).toBe(300);
      expect(decision.thresholdTokens).toBe(700);
    });

    it("triggers at the threshold crossing", () => {
      const history = [entry("a", { inputTokens: 700, outputTokens: 0 })];
      expect(evaluateSessionAutoCompact(history, config).trigger).toBe(true);
    });

    it("never triggers when pct is 0 (disable switch)", () => {
      const history = [entry("a", { inputTokens: 999_999, outputTokens: 0 })];
      expect(evaluateSessionAutoCompact(history, { pct: 0, windowTokens: 1_000 }).trigger).toBe(
        false,
      );
    });
  });
});
