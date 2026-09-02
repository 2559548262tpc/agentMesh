import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  WorkflowEngine,
  parseWorkflowSpec,
  renderTaskTemplate,
  readPersistedWorkflowSnapshot,
  readPersistedWorkflowSnapshots,
  type WorkflowDispatchService,
  type WorkflowEngineOptions,
  type WorkflowSpec,
} from "../../src/core/workflow.js";
import { BackgroundDispatchService } from "../../src/mcp/tools.js";
import { BackgroundTaskRegistry } from "../../src/core/background.js";
import { CheckpointStore } from "../../src/core/checkpoint.js";
import { createAgentMeshEventBus } from "../../src/core/events.js";
import type { AgentResult, AgentRole } from "../../src/agents/types.js";
import type {
  ContinueTaskParams,
  DelegateTaskParams,
  ReviewChangesParams,
} from "../../src/core/runner.js";

/**
 * M4 deterministic workflow state machine (ROADMAP_v0.4 M4). The dispatch seam
 * is a scripted fake (in-process MultiAgentRunner stand-in) riding the REAL
 * BackgroundDispatchService with an isolated temp home, so stage dispatches
 * exercise the same launch/registry/watchdog path the MCP tools use — no real
 * vendors, no quota, no real AgentMesh home writes.
 */

interface RecordedCall {
  kind: "delegate" | "review" | "continue";
  agent?: string;
  role?: AgentRole;
  task: string;
  contextSessionIds?: string[];
  continueSessionId?: string;
  /** Session id produced by the scripted result (back-filled after the call). */
  sessionId?: string;
  group?: string;
  mode?: string;
}

class FakeDispatchService implements WorkflowDispatchService {
  readonly calls: RecordedCall[] = [];
  private scripts: Array<
    (call: RecordedCall, index: number) => AgentResult | Promise<AgentResult>
  > = [];

  /** Scripts results in dispatch order; the last script repeats for overflow. */
  script(handler: (call: RecordedCall, index: number) => AgentResult | Promise<AgentResult>): this {
    this.scripts.push(handler);
    return this;
  }

  private async handle(
    kind: RecordedCall["kind"],
    params: {
      agent?: string;
      role?: AgentRole;
      task?: string;
      contextSessionIds?: string[];
      sessionId?: string;
      group?: string;
      mode?: string;
    },
  ): Promise<AgentResult> {
    const call: RecordedCall = {
      kind,
      task: params.task ?? "",
      ...(params.agent ? { agent: params.agent } : {}),
      ...(params.role ? { role: params.role } : {}),
      ...(params.contextSessionIds ? { contextSessionIds: params.contextSessionIds } : {}),
      ...(params.sessionId ? { continueSessionId: params.sessionId } : {}),
      ...(params.group ? { group: params.group } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
    };
    const index = this.calls.length;
    this.calls.push(call);
    const script = this.scripts[index] ?? this.scripts[this.scripts.length - 1];
    if (!script) throw new Error(`no scripted result for dispatch #${index} (${kind})`);
    const result = await script(call, index);
    if (result.sessionId) call.sessionId = result.sessionId;
    return result;
  }

  delegateTask(params: DelegateTaskParams): Promise<AgentResult> {
    return this.handle("delegate", params);
  }

  reviewChanges(params: ReviewChangesParams): Promise<AgentResult> {
    return this.handle("review", params);
  }

  continueTask(params: ContinueTaskParams): Promise<AgentResult> {
    return this.handle("continue", params);
  }
}

let sessionSeq = 0;
const okResult = (overrides: Partial<AgentResult> = {}): AgentResult => {
  sessionSeq += 1;
  return {
    status: "success",
    agent: "codex",
    summary: `ok ${sessionSeq}`,
    output: "ok",
    sessionId: `sess_${sessionSeq}`,
    ...overrides,
  };
};

const failResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  status: "failed",
  agent: "codex",
  summary: "dispatch failed",
  output: "",
  ...overrides,
});

/**
 * Faithful review-contract shape: reviewChanges fails closed — a FAIL or
 * unparseable verdict arrives as a failed RESULT carrying the parsed verdict,
 * while PASS rides a successful result.
 */
const reviewResult = (
  verdict: "PASS" | "FAIL" | "UNKNOWN",
  overrides: Partial<AgentResult> = {},
): AgentResult => ({
  ...okResult(),
  status: verdict === "PASS" ? "success" : "failed",
  summary: `Review outcome: ${verdict}`,
  reviewOutcome: verdict,
  ...overrides,
});

describe("core/workflow (M4 deterministic orchestration state machine)", () => {
  let homeDir: string;
  let workDir: string;

  const makeEngine = (
    spec: WorkflowSpec,
    dispatch: FakeDispatchService,
    options: Partial<WorkflowEngineOptions> = {},
  ): WorkflowEngine => {
    const registry = new BackgroundTaskRegistry({
      homeDir,
      eventBus: createAgentMeshEventBus(),
    });
    const background = new BackgroundDispatchService(registry, {
      checkpointStore: new CheckpointStore({ homeDir }),
    });
    return new WorkflowEngine(spec, {
      dispatch,
      background,
      cwd: workDir,
      ...options,
    });
  };

  beforeEach(() => {
    homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-wf-home-")));
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-wf-cwd-")));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe("spec parsing", () => {
    it("rejects schema violations with per-issue messages", () => {
      const result = parseWorkflowSpec({ name: "", stages: [] });
      expect(result.success).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("enforces exactly one of roles / parallelGroups per stage", () => {
      const both = parseWorkflowSpec({
        name: "wf",
        stages: [
          {
            name: "s1",
            roles: ["worker"],
            parallelGroups: ["a"],
            dispatch: { taskTemplate: "t" },
          },
        ],
      });
      expect(both.success).toBe(false);
      expect(both.issues[0]).toContain("exactly one of");

      const neither = parseWorkflowSpec({
        name: "wf",
        stages: [{ name: "s1", dispatch: { taskTemplate: "t" } }],
      });
      expect(neither.success).toBe(false);
      expect(neither.issues[0]).toContain("exactly one of");
    });

    it("accepts a valid spec and rejects unknown top-level keys", () => {
      const valid = parseWorkflowSpec({
        name: "wf",
        stages: [{ name: "s1", roles: ["worker"], dispatch: { taskTemplate: "t" } }],
      });
      expect(valid.success).toBe(true);
      expect(valid.spec?.stages).toHaveLength(1);

      const strict = parseWorkflowSpec({ name: "wf", surprise: true, stages: [] });
      expect(strict.success).toBe(false);
    });
  });

  it("substitutes template placeholders and leaves unknown ones intact", () => {
    const rendered = renderTaskTemplate(
      "Do {{ stageName }} for {{workflowName}} ({{group}}) keep {{unknown}}",
      {
        workflowName: "panel",
        stageName: "implement",
        group: "w1",
        upstreamSummaries: "",
      },
    );
    expect(rendered).toBe("Do implement for panel (w1) keep {{unknown}}");
  });

  it("runs a worker stage with acceptance to done and persists the state log", async () => {
    fs.writeFileSync(path.join(workDir, "expected.txt"), "seed", "utf-8");
    const dispatch = new FakeDispatchService().script(() => okResult());
    const engine = makeEngine(
      {
        name: "simple",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: {
              agent: "codex",
              taskTemplate: "Build {{workflowName}} stage {{stageName}}",
            },
            acceptance: {
              commands: [`node -e "process.exit(0)"`],
              files: ["expected.txt"],
            },
          },
        ],
      },
      dispatch,
    );

    const snapshot = await engine.run();

    expect(snapshot.status).toBe("done");
    expect(snapshot.workflowId).toMatch(/^wf_/);
    const stage = snapshot.stages[0]!;
    expect(stage.status).toBe("passed");
    expect(stage.transitions.map((t) => t.status)).toEqual([
      "pending",
      "dispatched",
      "running",
      "acceptance",
      "passed",
    ]);
    expect(stage.tasks).toHaveLength(1);
    expect(stage.tasks[0]).toMatchObject({ role: "worker", agent: "codex", status: "completed" });
    expect(stage.sessionIds).toEqual([stage.tasks[0]!.sessionId]);
    expect(stage.acceptance).toMatchObject({ ok: true });
    expect(stage.acceptance!.commands[0]).toMatchObject({ ok: true, exitCode: 0 });
    expect(stage.acceptance!.files[0]).toMatchObject({ file: "expected.txt", exists: true });
    // The dispatch task template received the rendered context.
    expect(dispatch.calls[0]!.task).toBe("Build simple stage implement");

    const persisted = readPersistedWorkflowSnapshot(snapshot.workflowId, { homeDir });
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe("done");
  });

  it("injects upstream sessions and summaries into the next stage per contextPolicy", async () => {
    const dispatch = new FakeDispatchService().script(() =>
      okResult({ summary: "stage one conclusion" }),
    );
    const engine = makeEngine(
      {
        name: "handoff",
        stages: [
          { name: "s1", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "first" } },
          {
            name: "s2",
            roles: ["worker"],
            dispatch: {
              agent: "codex",
              taskTemplate: "second after:\n{{upstreamSummaries}}",
              contextPolicy: { contextSessionIds: "upstream" },
            },
          },
        ],
      },
      dispatch,
    );

    const snapshot = await engine.run();
    expect(snapshot.status).toBe("done");

    const first = dispatch.calls[0]!;
    const second = dispatch.calls[1]!;
    expect(first.contextSessionIds).toBeUndefined();
    expect(second.contextSessionIds).toEqual([first.sessionId ?? expect.any(String)]);
    // The first-stage sessionIds feed the second stage's context injection.
    expect(snapshot.stages[0]!.sessionIds).toEqual(second.contextSessionIds);
    expect(second.task).toContain("stage one conclusion");
  });

  it("runs the reviewer-stage rework loop through reviewChanges + worker continue to PASS", async () => {
    const finding = {
      severity: "high" as const,
      file: "src/auth.ts",
      line: 42,
      issue: "SQL Injection",
      suggestion: "Use parameterized query",
    };
    const dispatch = new FakeDispatchService()
      .script(() => okResult({ summary: "worker did the thing" })) // stage 1 worker
      .script(() => reviewResult("FAIL", { findings: [finding] })) // stage 2 initial review (via reviewChanges)
      .script(() => okResult({ summary: "fix applied" })) // rework fix via continue_task
      .script(() => reviewResult("PASS")); // re-review

    const engine = makeEngine(
      {
        name: "reviewed",
        stages: [
          { name: "build", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "build" } },
          {
            name: "review",
            roles: ["reviewer"],
            dispatch: { agent: "codex", taskTemplate: "review it" },
            policy: { maxReworkRounds: 2 },
          },
        ],
      },
      dispatch,
    );

    const snapshot = await engine.run();
    expect(snapshot.status).toBe("done");
    expect(snapshot.stages[1]!.status).toBe("passed");

    // The review dispatch went through reviewChanges (strict fail-closed contract).
    expect(dispatch.calls[1]!.kind).toBe("review");
    // A FAIL verdict is a completed review execution, not a dispatch failure.
    expect(snapshot.stages[1]!.tasks[0]!.status).toBe("completed");
    const review = snapshot.stages[1]!.review!;
    expect(review.initialVerdict).toBe("FAIL");
    expect(review.findings).toEqual([finding]);
    expect(review.verdict).toBe("PASS");
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds[0]).toMatchObject({
      round: 1,
      fixStatus: "success",
      reviewOutcome: "PASS",
    });

    // The fix turn continued the WORKER session with the rework fix prompt.
    const fixCall = dispatch.calls[2]!;
    expect(fixCall.kind).toBe("continue");
    expect(fixCall.continueSessionId).toBe(snapshot.stages[0]!.workerSessionId);
    expect(fixCall.task).toContain("REWORK ROUND 1 OF 2");
    expect(fixCall.task).toContain("SQL Injection");
    // The re-review rode the reviewChanges contract as well.
    expect(dispatch.calls[3]!.kind).toBe("review");
  });

  it("escalates with the full evidence chain when rework rounds are exhausted", async () => {
    const finding = {
      severity: "critical" as const,
      file: "src/db.ts",
      issue: "data loss",
    };
    const dispatch = new FakeDispatchService()
      .script(() => okResult())
      .script(() => reviewResult("FAIL", { findings: [finding] }))
      .script(() => okResult({ summary: "fix applied" }))
      .script(() => reviewResult("FAIL", { findings: [] }))
      .script(() => okResult({ summary: "fix applied again" }))
      .script(() => reviewResult("FAIL", { findings: [] }));

    const engine = makeEngine(
      {
        name: "escalate",
        stages: [
          { name: "build", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "build" } },
          {
            name: "review",
            roles: ["reviewer"],
            dispatch: { agent: "codex", taskTemplate: "review it" },
            policy: { maxReworkRounds: 2 },
          },
        ],
      },
      dispatch,
    );

    const snapshot = await engine.run();
    expect(snapshot.status).toBe("escalated");
    expect(snapshot.stages[1]!.status).toBe("escalated");
    const evidence = snapshot.evidence!;
    expect(evidence.outcome).toBe("escalated");
    expect(evidence.stageName).toBe("review");
    expect(evidence.rounds).toHaveLength(2);
    expect(evidence.rounds[0]!.findings).toEqual([finding]);
    // The failure is the ONLY place the evidence chain is attached.
    expect(snapshot.failure).toBeUndefined();
    expect(reviewRoundCount(snapshot)).toBe(2);
  });

  it("fails (not escalates) on review failure when escalateOn is acceptanceFail", async () => {
    const dispatch = new FakeDispatchService()
      .script(() => okResult())
      .script(() => reviewResult("UNKNOWN"));
    const engine = makeEngine(
      {
        name: "fail-path",
        stages: [
          {
            name: "review",
            roles: ["reviewer"],
            dispatch: { agent: "codex", taskTemplate: "review it" },
            policy: { escalateOn: "acceptanceFail" },
          },
        ],
      },
      dispatch,
    );

    const snapshot = await engine.run();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.stages[0]!.status).toBe("failed");
    expect(snapshot.failure).toMatchObject({ stageName: "review" });
    expect(snapshot.evidence).toBeUndefined();
  });

  it("escalates acceptance failures with per-command output evidence", async () => {
    const dispatch = new FakeDispatchService().script(() => okResult());
    const engine = makeEngine(
      {
        name: "acceptance-escalate",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: { agent: "codex", taskTemplate: "build" },
            acceptance: {
              commands: [`node -e "process.stderr.write('boom'); process.exit(3)"`],
            },
            policy: { escalateOn: "acceptanceFail" },
          },
        ],
      },
      dispatch,
    );

    const snapshot = await engine.run();
    expect(snapshot.status).toBe("escalated");
    const evidence = snapshot.evidence!;
    expect(evidence.stageName).toBe("implement");
    const command = evidence.acceptance!.commands[0]!;
    expect(command.ok).toBe(false);
    expect(command.exitCode).toBe(3);
    expect(command.stderr).toContain("boom");
    expect(evidence.finalError).toContain("exit 3");
  });

  it("re-routes stall-classified dispatch failures along the health-ordered candidate chain", async () => {
    const dispatch = new FakeDispatchService()
      .script(() =>
        failResult({
          summary: "timed out",
          error: "timeout",
          errorCode: "TIMEOUT",
          timedOut: true,
        }),
      )
      .script(() => okResult());
    const engine = makeEngine(
      {
        name: "reroute",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: { agent: "primary-agent", taskTemplate: "build" },
            policy: { reRouteOnStall: true },
          },
        ],
      },
      dispatch,
      {
        candidateResolver: (agent: string) => ({
          candidates: [{ agent }, { agent: "fallback-agent" }],
        }),
      },
    );

    const snapshot = await engine.run();
    expect(snapshot.status).toBe("done");
    expect(dispatch.calls).toHaveLength(2);
    expect(dispatch.calls[0]!.agent).toBe("primary-agent");
    expect(dispatch.calls[1]!.agent).toBe("fallback-agent");

    const tasks = snapshot.stages[0]!.tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ agent: "primary-agent", status: "failed" });
    expect(tasks[1]).toMatchObject({
      agent: "fallback-agent",
      status: "completed",
      reroutedFrom: "primary-agent",
    });
  });

  it("does not re-route without the policy flag and escalates with the stall evidence", async () => {
    const dispatch = new FakeDispatchService().script(() =>
      failResult({ summary: "timed out", errorCode: "TIMEOUT", timedOut: true }),
    );
    const engine = makeEngine(
      {
        name: "no-reroute",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: { agent: "primary-agent", taskTemplate: "build" },
          },
        ],
      },
      dispatch,
      {
        candidateResolver: (agent: string) => ({ candidates: [{ agent }, { agent: "fallback" }] }),
      },
    );

    const snapshot = await engine.run();
    // Default escalateOn="any": a non-rerouted stall escalates to the orchestrator.
    expect(snapshot.status).toBe("escalated");
    expect(dispatch.calls).toHaveLength(1);
    expect(snapshot.evidence!.stageName).toBe("implement");
  });

  it("dispatches parallelGroups concurrently with per-group records", async () => {
    let resolveSlow!: (result: AgentResult) => void;
    const slowGate = new Promise<AgentResult>((resolve) => {
      resolveSlow = resolve;
    });
    const startedGroups: string[] = [];
    const dispatch = new FakeDispatchService().script((call) => {
      // The group name reaches the vendor only through the rendered template.
      const group = call.task.replace("Build package ", "");
      startedGroups.push(group);
      return group === "w1" ? slowGate : okResult({ summary: `done ${group}` });
    });
    const engine = makeEngine(
      {
        name: "parallel",
        stages: [
          {
            name: "packages",
            parallelGroups: ["w1", "w2"],
            dispatch: { agent: "codex", taskTemplate: "Build package {{group}}" },
          },
        ],
      },
      dispatch,
    );

    const runPromise = engine.run();
    // Both groups are dispatched before either completes: concurrent fan-out.
    expect([...startedGroups].sort()).toEqual(["w1", "w2"]);
    resolveSlow(okResult({ summary: "done w1" }));
    const snapshot = await runPromise;

    expect(snapshot.status).toBe("done");
    expect(dispatch.calls.map((call) => call.task).sort()).toEqual([
      "Build package w1",
      "Build package w2",
    ]);
    const groups = snapshot.stages[0]!.tasks.map((task) => task.group).sort();
    expect(groups).toEqual(["w1", "w2"]);
  });

  it("converts a throwing dispatch into a terminal escalation without aborting the engine loop", async () => {
    const dispatch = new FakeDispatchService().script(() => {
      throw new Error("runner exploded");
    });
    const engine = makeEngine(
      {
        name: "throwing",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: { agent: "codex", taskTemplate: "build" },
          },
        ],
      },
      dispatch,
    );

    const snapshot = await engine.run();
    // The engine never throws: the rejected dispatch degrades to a failed task
    // record and the default escalateOn="any" policy escalates with evidence.
    expect(snapshot.status).toBe("escalated");
    expect(snapshot.stages[0]!.status).toBe("escalated");
    expect(snapshot.evidence!.stageName).toBe("implement");
    expect(JSON.stringify(snapshot.evidence)).toContain("runner exploded");
    // The failed dispatch still landed in the task registry (cancel/poll visible).
    expect(snapshot.stages[0]!.tasks[0]!.status).toBe("failed");
  });

  it("notifies waiting observers on every state update and resolves terminal waits immediately", async () => {
    let resolveGate!: (result: AgentResult) => void;
    const gate = new Promise<AgentResult>((resolve) => {
      resolveGate = resolve;
    });
    const dispatch = new FakeDispatchService().script(() => gate);
    const engine = makeEngine(
      {
        name: "observed",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: { agent: "codex", taskTemplate: "build" },
          },
        ],
      },
      dispatch,
    );

    // Arm the waiter before run(): the dispatch transitions fired by run() must
    // wake it event-driven (well under the 5s budget), not by timeout.
    const startedAt = Date.now();
    const observedPromise = engine.waitForUpdate(5_000);
    const runPromise = engine.run();
    const observed = await observedPromise;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(observed.status).toBe("running");
    expect(["dispatched", "running"]).toContain(observed.stages[0]!.status);

    resolveGate(okResult());
    const snapshot = await runPromise;
    expect(snapshot.status).toBe("done");
    // Terminal workflows return immediately regardless of the wait budget.
    const terminal = await engine.waitForUpdate(60_000);
    expect(terminal.status).toBe("done");
  });

  it("skips corrupt lines in the JSONL state log and reads the latest snapshot per workflow", async () => {
    const dispatch = new FakeDispatchService().script(() => okResult());
    const engine = makeEngine(
      {
        name: "logged",
        stages: [
          {
            name: "implement",
            roles: ["worker"],
            dispatch: { agent: "codex", taskTemplate: "build" },
          },
        ],
      },
      dispatch,
    );
    const snapshot = await engine.run();

    const logPath = path.join(homeDir, "workflows.jsonl");
    const before = fs.readFileSync(logPath, "utf-8");
    expect(before.trim().length).toBeGreaterThan(0);

    // Corrupt (crashed-append) line + a later snapshot for the same id.
    fs.appendFileSync(logPath, "{corrupt\n", "utf-8");
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ ...snapshot, status: "escalated", stages: [] })}\n`,
      "utf-8",
    );

    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    };
    try {
      const latest = readPersistedWorkflowSnapshot(snapshot.workflowId, { homeDir });
      expect(latest).toBeDefined();
      expect(latest!.status).toBe("escalated");
      // Every valid line is readable; the corrupt one is skipped with a warning.
      const records = readPersistedWorkflowSnapshots({ homeDir });
      expect(records.length).toBeGreaterThanOrEqual(2);
      expect(records.at(-1)).toMatchObject({
        workflowId: snapshot.workflowId,
        status: "escalated",
      });
      expect(warnings.some((line) => line.includes("corrupt line"))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("reports an unknown workflow id as absent from the state log", () => {
    expect(readPersistedWorkflowSnapshot("wf_missing", { homeDir })).toBeUndefined();
  });
});

/** Counts rework rounds across a snapshot (evidence chain sanity helper). */
function reviewRoundCount(snapshot: { stages: Array<{ review?: { rounds: unknown[] } }> }): number {
  return snapshot.stages.reduce((sum, stage) => sum + (stage.review?.rounds.length ?? 0), 0);
}
