import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/core/background.js";
import { readPersistedWorkflowSnapshot } from "../../src/core/workflow.js";
import {
  createSimulationHarness,
  numberField,
  stringField,
  type SimulationHarness,
} from "./harness.js";

/**
 * S9 (workflow) — M4 deterministic orchestration state machine over the M1
 * fake-vendor surface (ROADMAP_v0.4 M4 × M1).
 *
 * Not mapped to a specific r21/r22 defect: it proves the workflow engine runs
 * the dispatch → acceptance → review → rework loop through the REAL in-process
 * MCP surface (run_workflow/get_workflow via InMemoryTransport, plus
 * poll_task/cancel_task on the stage task ids) with REAL fake-vendor child
 * processes — no scripted dispatch fake anywhere in the chain.
 *
 * Three pinned behaviors:
 * 1. a worker stage with acceptance reaches `done`, its stage task is a
 *    first-class background task (tee'd output, session, reaped vendor);
 * 2. a reviewer-stage FAIL verdict drives one real rework round (fix turn via
 *    continue on the worker session) and the fail-closed UNKNOWN re-review
 *    escalates the workflow with the full evidence chain;
 * 3. cancel_task on a stalled stage task reaps the vendor process tree and
 *    escalates the workflow with per-stage failure attribution.
 */

type WorkflowPayload = Record<string, unknown> & {
  status?: string;
  workflowId?: string;
  stages?: Array<Record<string, unknown>>;
  failure?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
};

type TaskPayload = Record<string, unknown> & {
  status?: string;
  outputSinceOffset?: string;
  result?: Record<string, unknown>;
};

type CancelPayload = Record<string, unknown> & {
  status?: string;
  alreadyTerminal?: boolean;
  cancelReason?: string;
  result?: Record<string, unknown>;
};

function stageTransitions(stage: Record<string, unknown>): string[] {
  const transitions = stage.transitions as Array<Record<string, unknown>> | undefined;
  return (transitions ?? []).map((entry) => stringField(entry, "status") ?? "(missing)");
}

function stageTasks(stage: Record<string, unknown>): Array<Record<string, unknown>> {
  return (stage.tasks as Array<Record<string, unknown>> | undefined) ?? [];
}

describe("S9 workflow: the deterministic state machine drives real fake-vendor stages", () => {
  let harness: SimulationHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  /** MCP tool call with a JSON payload boundary cast (validated by JSON.parse). */
  async function callJson(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
    const client = harness?.client;
    if (!client) throw new Error("simulation harness client missing");
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    return {
      payload: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>,
      isError: res.isError === true,
    };
  }

  /** Long-polls get_workflow (event-driven) until a terminal status arrives. */
  async function awaitTerminalWorkflow(workflowId: string): Promise<WorkflowPayload> {
    let payload: WorkflowPayload = {};
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await callJson("get_workflow", { workflowId, maxWaitMs: 5_000 });
      payload = res.payload;
      if (payload.status !== "running") return payload;
    }
    return payload;
  }

  it("runs a worker stage with acceptance to done as a first-class background task", async () => {
    harness = await createSimulationHarness({ label: "s9" });
    const launch = await callJson("run_workflow", {
      cwd: harness.workDir,
      spec: {
        name: "s9-build",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: {
              agent: "codex",
              mode: "cli",
              taskTemplate: [
                "Produce the simulated implementation log.",
                "fake-vendor-sim: mode=ok, delay-ms=100, interval-ms=80, heartbeats=3, out-chars=80",
              ].join("\n"),
            },
            acceptance: {
              commands: [`node -e "require('node:fs').writeFileSync('artifact.txt','ok')"`],
              files: ["artifact.txt"],
            },
          },
        ],
      },
    });
    expect(launch.isError).toBe(false);
    const workflowId = stringField(launch.payload, "workflowId");
    expect(stringField(launch.payload, "status")).toBe("running");
    expect(workflowId).toMatch(/^wf_/);
    expect(launch.payload.stages).toEqual(["implement"]);

    // The stage dispatch is a real background task: its vendor child spawns
    // under the workflow-scoped task id and is reaped after completion.
    const stageTaskId = `${workflowId}_s0_1`;
    const childPid = await harness.waitForChildPid(stageTaskId);

    const terminal = await awaitTerminalWorkflow(workflowId!);
    expect(terminal.status).toBe("done");

    const stage = terminal.stages?.[0];
    expect(stringField(stage, "status")).toBe("passed");
    expect(stageTransitions(stage!)).toEqual([
      "pending",
      "dispatched",
      "running",
      "acceptance",
      "passed",
    ]);

    // Acceptance evidence: the command really ran in the target cwd.
    const acceptance = stage?.acceptance as Record<string, unknown> | undefined;
    expect(acceptance?.ok).toBe(true);
    const command = (acceptance?.commands as Array<Record<string, unknown>>)[0]!;
    expect(command.ok).toBe(true);
    expect(numberField(command, "exitCode")).toBe(0);
    expect((acceptance?.files as Array<Record<string, unknown>>)[0]).toMatchObject({
      file: "artifact.txt",
      exists: true,
    });

    // The dispatch task record carries the real vendor summary and session.
    const task = stageTasks(stage!)[0]!;
    expect(task).toMatchObject({
      taskId: stageTaskId,
      role: "worker",
      agent: "codex",
      status: "completed",
    });
    expect(stringField(task, "summary")).toContain("DONE:");
    expect(stringField(task, "sessionId")).toBeDefined();
    expect(stage?.sessionIds).toHaveLength(1);

    // poll_task sees the stage task like any background dispatch: terminal
    // result plus the tee'd vendor output (heartbeats prove incremental tee).
    const pollRes = await callJson("poll_task", { taskId: stageTaskId, maxWaitMs: 5_000 });
    const poll = pollRes.payload as TaskPayload;
    expect(poll.status).toBe("completed");
    expect(stringField(poll.result, "finalAnswer")).toContain("DONE:");
    expect(poll.outputSinceOffset ?? "").toContain("heartbeat");

    expect(harness.events.some((e) => e.type === "task.started" && e.taskId === stageTaskId)).toBe(
      true,
    );
    expect(
      harness.events.some(
        (e) => e.type === "task.completed" && e.taskId === stageTaskId && e.status === "completed",
      ),
    ).toBe(true);

    // Windows process discipline: the vendor child is reaped.
    await harness.waitFor(() => !isPidAlive(childPid));

    // The workflow state log persists the terminal snapshot in the home dir.
    const persisted = readPersistedWorkflowSnapshot(workflowId!, { homeDir: harness.homeDir });
    expect(persisted?.status).toBe("done");
  });

  it("drives a real rework round on review FAIL and escalates fail-closed on UNKNOWN re-review", async () => {
    harness = await createSimulationHarness({ label: "s9" });
    const launch = await callJson("run_workflow", {
      cwd: harness.workDir,
      spec: {
        name: "s9-reviewed",
        stages: [
          {
            name: "build",
            roles: ["worker"],
            dispatch: {
              agent: "codex",
              mode: "cli",
              taskTemplate: "Build the thing.\nfake-vendor-sim: mode=ok, out-chars=80",
            },
          },
          {
            name: "review",
            roles: ["reviewer"],
            dispatch: {
              agent: "codex",
              mode: "cli",
              taskTemplate:
                "Review the working tree. fake-vendor-sim: mode=ok, text=Verdict:+FAIL+missing+edge+case+coverage",
            },
            policy: { maxReworkRounds: 1 },
          },
        ],
      },
    });
    const workflowId = stringField(launch.payload, "workflowId")!;

    const terminal = await awaitTerminalWorkflow(workflowId);
    expect(terminal.status).toBe("escalated");

    const buildStage = terminal.stages?.[0] as Record<string, unknown>;
    const reviewStage = terminal.stages?.[1] as Record<string, unknown>;
    expect(stringField(buildStage, "status")).toBe("passed");
    expect(stringField(reviewStage, "status")).toBe("escalated");

    // The initial review FAIL came through the real review contract parse.
    const review = reviewStage.review as Record<string, unknown>;
    expect(review.initialVerdict).toBe("FAIL");
    // The fix turn succeeded, but the re-review is engine-built (no fake-vendor
    // directive) and its default narrative parses fail-closed as UNKNOWN —
    // exactly the "review did not return a PASS verdict" escalation path.
    const rounds = review.rounds as Array<Record<string, unknown>>;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1, fixStatus: "success", reviewOutcome: "UNKNOWN" });
    expect(review.verdict).toBe("UNKNOWN");

    // Stage task accounting: initial review, fix continue, re-review.
    const tasks = stageTasks(reviewStage);
    expect(tasks.map((task) => stringField(task, "role"))).toEqual([
      "reviewer",
      "worker",
      "reviewer",
    ]);
    expect(tasks.map((task) => stringField(task, "status"))).toEqual([
      "completed",
      "completed",
      "completed",
    ]);

    // escalateOn defaults to "any": a review failure escalates (evidence
    // chain), it does not produce the plain-failure record.
    expect(terminal.evidence).toMatchObject({ outcome: "escalated", stageName: "review" });
    expect(stringField(terminal.evidence, "reason")).toContain("PASS verdict");
    expect(terminal.failure).toBeUndefined();
  });

  it("cancel_task reaps a stalled stage vendor and escalates the workflow", async () => {
    harness = await createSimulationHarness({ label: "s9" });
    const launch = await callJson("run_workflow", {
      cwd: harness.workDir,
      spec: {
        name: "s9-cancel",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: {
              agent: "codex",
              mode: "cli",
              taskTemplate: "Stream the simulated log.\nfake-vendor-sim: mode=stall",
            },
          },
        ],
      },
    });
    const workflowId = stringField(launch.payload, "workflowId")!;
    const stageTaskId = `${workflowId}_s0_1`;
    const childPid = await harness.waitForChildPid(stageTaskId);

    // M4 × M7: the stage task id is a first-class cancel_task target.
    const cancelRes = await callJson("cancel_task", {
      taskId: stageTaskId,
      reason: "s9-sim-cancel",
    });
    const cancel = cancelRes.payload as CancelPayload;
    expect(cancel.status).toBe("cancelled");
    expect(cancel.alreadyTerminal).toBe(false);
    expect(cancel.cancelReason).toBe("s9-sim-cancel");
    expect(stringField(cancel.result, "status")).toBe("failed");

    const terminal = await awaitTerminalWorkflow(workflowId);
    expect(terminal.status).toBe("escalated");
    expect(terminal.evidence).toMatchObject({ outcome: "escalated", stageName: "implement" });
    expect(stringField(terminal.evidence, "reason")).toContain("Stage dispatch failed");
    expect(terminal.failure).toBeUndefined();

    const stage = terminal.stages?.[0] as Record<string, unknown>;
    expect(stringField(stage, "status")).toBe("escalated");
    expect(stageTasks(stage)[0]).toMatchObject({ taskId: stageTaskId, status: "failed" });

    // Windows process-tree discipline: no orphan vendor child survives cancel.
    await harness.waitFor(() => !isPidAlive(childPid));

    const persisted = readPersistedWorkflowSnapshot(workflowId, { homeDir: harness.homeDir });
    expect(persisted?.status).toBe("escalated");
  });
});
