import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import {
  createSimulationHarness,
  numberField,
  stringField,
  type SimulationHarness,
} from "./harness.js";

/**
 * S6 (exit-mismatch) — process exit status and semantic status are separate
 * signals and BOTH paths stay surfaced when they disagree.
 *
 * Maps to the real rounds:
 * - P-R21-1: "执行失败" and "裁决 FAIL" semantics were conflated — six vendor
 *   aborted reviews were rendered as FAIL verdicts while one real PASS was
 *   rendered UNKNOWN, so operators had to read full transcripts to know what
 *   actually happened.
 * - P-R21-6: verdict/status derivation must keep the two channels apart.
 *
 * What is pinned as regression behavior: a vendor that prints a clean
 * "all checks passed" answer but exits non-zero produces ONE record that
 * carries both facts without merging them —
 * 1. the process signal wins the terminal status: status=failed, exitCode=7;
 * 2. the semantic signal survives untouched: the clean finalAnswer text is
 *    still extractable for the orchestrator/panel;
 * 3. the summary names the exit code as the failure cause.
 */
describe("S6 exit-mismatch: clean text plus non-zero exit keeps both signals surfaced", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("fails on the process exit while preserving the clean semantic answer", async () => {
    harness = await createSimulationHarness({ label: "s6" });
    const taskId = await harness.dispatchBackground(
      [
        "Finish the simulated feature and verify it.",
        "fake-vendor-sim: mode=exit-mismatch, exit-code=7",
      ].join("\n"),
    );
    const childPid = await harness.waitForChildPid(taskId);

    const registry = harness.registry;
    await harness.waitFor(() => registry.hasStoredResult(taskId));
    const stored = await harness.registry.readStoredResult(taskId);

    // Process signal: non-zero exit → failed terminal state with the code.
    expect(stored?.status).toBe("failed");
    expect(stored?.exitCode).toBe(7);
    expect(stored?.summary ?? "").toContain("exited with code 7");

    // Semantic signal: the vendor's clean answer text is still recoverable
    // from the same record instead of being discarded or re-labeled.
    expect(stored?.finalAnswer ?? "").toContain("All checks passed");

    const terminal = await harness.pollTask(taskId, { maxWaitMs: 0 });
    expect(terminal.status).toBe("failed");
    expect(numberField(terminal.result, "exitCode")).toBe(7);
    expect(stringField(terminal.result, "finalAnswer") ?? "").toContain("All checks passed");

    expect(harness.background.activeCount).toBe(0);
    await harness.waitFor(() => !isPidAlive(childPid));
  });
});
