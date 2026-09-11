import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
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
import { readTaskMetrics } from "../../src/core/metrics.js";
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
  /** v0.5 Batch 2 #8 triage lane stamped by the workflow engine. */
  lane?: string;
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
      lane?: string;
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
      ...(params.lane ? { lane: params.lane } : {}),
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
      // Deterministic tests: the default 0.15 sampled-review rate flips on the
      // random workflowId, so tests that don't exercise the sampler pin it to
      // 0 and the #9 sampler tests override it explicitly.
      samplingRate: 0,
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

  describe("v0.5 reconciliation ledger + needs_ruling + Tier 1 archive", () => {
    const requirements = {
      source: "doc.md",
      items: [
        {
          id: "R1",
          ears: "The system SHALL build the widget",
          kind: "unconditional" as const,
          quote: "build the widget",
          decidable: true,
        },
        {
          id: "R2",
          ears: null,
          kind: null,
          quote: "要好看",
          decidable: false,
        },
      ],
    };

    it("terminates as needs_ruling when undecidable rows remain and persists the ledger", async () => {
      const dispatch = new FakeDispatchService().script(() => okResult());
      const archiveCalls: Array<{ archive: string[]; keep: string[]; ledgerRef: string }> = [];
      const engine = makeEngine(
        {
          name: "reconciled",
          stages: [
            {
              name: "implement",
              roles: ["worker"],
              requirements: ["R1", "R2"],
              dispatch: { agent: "codex", taskTemplate: "build" },
              acceptance: {
                // R1 covered; R2 declared without covering command → PENDING_RULING.
                commands: [{ cmd: `node -e "process.exit(0)"`, covers: ["R1"] }],
              },
            },
          ],
        },
        dispatch,
        {
          requirements,
          archiveSessions: (params) => {
            archiveCalls.push({
              archive: params.archiveSessionIds,
              keep: params.keepSessionIds,
              ledgerRef: params.ledgerRef,
            });
            return Promise.resolve({ archived: params.archiveSessionIds.length });
          },
        },
      );

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("needs_ruling");
      expect(snapshot.needsRulingIds).toEqual(["R2"]);
      expect(snapshot.ledgerRef).toBe(
        path.join(homeDir, "out", `ledger_${snapshot.workflowId}.json`),
      );
      const ledger = JSON.parse(fs.readFileSync(snapshot.ledgerRef!, "utf-8")) as {
        rows: Array<{ id: string; status: string; ears: string }>;
        invariant: { requirements: number; rows: number; ok: boolean };
      };
      expect(ledger.rows).toHaveLength(2);
      expect(ledger.rows.find((row) => row.id === "R1")).toMatchObject({ status: "PASS" });
      expect(ledger.rows.find((row) => row.id === "R2")).toMatchObject({
        status: "PENDING_RULING",
        ears: "要好看",
      });
      expect(ledger.invariant).toEqual({ requirements: 2, rows: 2, ok: true });

      // Tier 1 archive: the workflow's only stage is also the last stage, so
      // its sessions are kept (nothing to archive) — no archive call fires.
      expect(archiveCalls).toHaveLength(0);
    });

    it("stays done when every declared row carries covering command evidence", async () => {
      const dispatch = new FakeDispatchService().script(() => okResult());
      const engine = makeEngine(
        {
          name: "fully-covered",
          stages: [
            {
              name: "implement",
              roles: ["worker"],
              requirements: ["R1", "R2"],
              dispatch: { agent: "codex", taskTemplate: "build" },
              acceptance: {
                commands: [
                  { cmd: `node -e "process.exit(0)"`, covers: ["R1"] },
                  { cmd: `node -e "process.exit(0)"`, covers: ["R2"] },
                ],
              },
            },
          ],
        },
        dispatch,
        { requirements },
      );

      const snapshot = await engine.run();
      expect(snapshot.status).toBe("done");
      expect(snapshot.needsRulingIds).toBeUndefined();
      const ledger = JSON.parse(fs.readFileSync(snapshot.ledgerRef!, "utf-8")) as {
        rows: Array<{ id: string; status: string }>;
      };
      expect(ledger.rows.map((row) => row.status)).toEqual(["PASS", "PASS"]);
    });

    it("normalizes legacy string acceptance commands and keeps covers off the record", async () => {
      const dispatch = new FakeDispatchService().script(() => okResult());
      const engine = makeEngine(
        {
          name: "legacy-commands",
          stages: [
            {
              name: "implement",
              roles: ["worker"],
              dispatch: { agent: "codex", taskTemplate: "build" },
              acceptance: { commands: [`node -e "process.exit(0)"`] },
            },
          ],
        },
        dispatch,
      );

      const snapshot = await engine.run();
      expect(snapshot.status).toBe("done");
      expect(snapshot.stages[0]!.acceptance!.commands[0]!.covers).toBeUndefined();
    });

    it("archives the previous stage's sessions and keeps the last stage's newest turn", async () => {
      let sessionSeq = 0;
      const dispatch = new FakeDispatchService().script(() =>
        okResult({ sessionId: `sess_arch_${(sessionSeq += 1)}` }),
      );
      const archiveCalls: Array<{ archive: string[]; keep: string[] }> = [];
      const engine = makeEngine(
        {
          name: "archived",
          stages: [
            { name: "s1", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "one" } },
            { name: "s2", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "two" } },
          ],
        },
        dispatch,
        {
          archiveSessions: (params) => {
            archiveCalls.push({ archive: params.archiveSessionIds, keep: params.keepSessionIds });
            return Promise.resolve({ archived: params.archiveSessionIds.length });
          },
        },
      );

      const snapshot = await engine.run();
      expect(snapshot.status).toBe("done");
      expect(archiveCalls).toHaveLength(1);
      const [s1Session, s2Session] = snapshot.stages.map((stage) => stage.sessionIds[0]!);
      expect(archiveCalls[0]!.archive).toEqual([s1Session]);
      expect(archiveCalls[0]!.keep).toEqual([s2Session]);
    });
  });

  // v0.5 Batch 2 #8: triage engine + gated gateway (design §5). The gated
  // fail-closed gate must fire BEFORE any dispatch; the lane rides the
  // dispatch options into the metrics records and the snapshot.
  describe("v0.5 Batch 2 #8 triage lane + gated gateway", () => {
    /** 3-file spec whose taskTemplate hits the risk table → triage lane "gated". */
    const gatedSpec = (gateRuling?: "standard" | "full"): WorkflowSpec => ({
      name: "gated-run",
      stages: [
        {
          name: "implement",
          roles: ["worker"],
          dispatch: { agent: "codex", taskTemplate: "Rotate the session AUTH handling" },
          acceptance: {
            commands: [{ cmd: `node -e "process.exit(0)"`, covers: ["R1"] }],
            files: ["a.txt", "b.txt", "c.txt"],
          },
        },
      ],
      ...(gateRuling !== undefined ? { gateRuling } : {}),
    });

    it("fails closed with GATE_RULING_REQUIRED before any dispatch when gated and unruled", async () => {
      const dispatch = new FakeDispatchService().script(() => okResult());
      const engine = makeEngine(gatedSpec(), dispatch);

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("failed");
      expect(snapshot.failure?.errorCode).toBe("GATE_RULING_REQUIRED");
      expect(snapshot.failure?.reason).toContain("GATE_RULING_REQUIRED");
      // The evidence chain carries the triage decision reasons.
      expect(snapshot.failure?.reason).toContain("auth");
      expect(snapshot.failure?.reason).toContain("= 3");
      // Fail-closed: no dispatch, no task record, stage still pending.
      expect(dispatch.calls).toHaveLength(0);
      expect(snapshot.stages[0]!.tasks).toHaveLength(0);
      expect(snapshot.stages[0]!.status).toBe("pending");
    });

    it("runs a gated spec with gateRuling and stamps the ruling lane everywhere", async () => {
      for (const file of ["a.txt", "b.txt", "c.txt"]) {
        fs.writeFileSync(path.join(workDir, file), "seed", "utf-8");
      }
      const dispatch = new FakeDispatchService().script(() => okResult());
      const engine = makeEngine(gatedSpec("full"), dispatch);

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("done");
      expect(snapshot.lane).toBe("full");
      expect(dispatch.calls[0]!.lane).toBe("full");
      const persisted = readPersistedWorkflowSnapshot(snapshot.workflowId, { homeDir });
      expect(persisted?.lane).toBe("full");
    });

    it("tags stage dispatches and the persisted snapshot with the triage lane", async () => {
      // 3-file set without risk keywords → lane "standard"; the registry task
      // record carries the same lane for watchdog attribution.
      for (const file of ["a.txt", "b.txt", "c.txt"]) {
        fs.writeFileSync(path.join(workDir, file), "seed", "utf-8");
      }
      const dispatch = new FakeDispatchService().script(() => okResult());
      const engine = makeEngine(
        {
          name: "lane-tagged",
          stages: [
            {
              name: "implement",
              roles: ["worker"],
              dispatch: { agent: "codex", taskTemplate: "Build the widget module" },
              acceptance: {
                commands: [`node -e "process.exit(0)"`],
                files: ["a.txt", "b.txt", "c.txt"],
              },
            },
          ],
        },
        dispatch,
      );

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("done");
      expect(snapshot.lane).toBe("standard");
      expect(dispatch.calls[0]!.lane).toBe("standard");
      const persisted = readPersistedWorkflowSnapshot(snapshot.workflowId, { homeDir });
      expect(persisted?.lane).toBe("standard");
    });

    it("records the lane on watchdog stall events for lane-tagged registry tasks", async () => {
      // Regression for the background.ts stall-line lane attribution. Lives
      // here because the Batch 2 #8 edit boundary excludes background.test.ts.
      const registry = new BackgroundTaskRegistry({
        homeDir,
        eventBus: createAgentMeshEventBus(),
      });
      const taskId = "wf_lane_stall_s1_1";
      registry.registerTask({
        taskId,
        pid: process.pid,
        startedAtMs: 0,
        outputFile: registry.outputFilePath(taskId),
        lane: "standard",
      });

      // Silence past the 10-minute stall threshold → the watchdog appends the
      // stall metrics line with the record's lane.
      registry.checkStalledTasks(11 * 60_000);
      const stall = readTaskMetrics({ homeDir }).find(
        (record) => record.taskId === taskId && record.outcome === "stalled",
      );
      expect(stall?.lane).toBe("standard");

      // Stop the watchdog timer before the temp home is removed.
      registry.releaseTask(taskId);
    });
  });

  // v0.5 Batch 2 #9 (design §5): fast-lane tree guard and seeded sampled
  // review. The guard needs a real git work tree (repository evidence), so
  // these tests init one in the temp cwd; the scripted fake dispatch plays the
  // worker and simulates the file writes in-process.
  describe("v0.5 Batch 2 #9 fast-lane tree guard + sampled review", () => {
    const fastRequirements = {
      source: "doc.md",
      items: [
        {
          id: "R1",
          ears: "The system SHALL build the widget",
          kind: "unconditional" as const,
          quote: "build the widget",
          decidable: true,
        },
      ],
    };

    /** 1-file spec, R1 covered, no context plumbing, no risk keywords → fast. */
    const makeFastSpec = (policy?: { maxReworkRounds: number }): WorkflowSpec => ({
      name: "fastlane",
      stages: [
        {
          name: "implement",
          roles: ["worker"],
          requirements: ["R1"],
          dispatch: { agent: "codex", taskTemplate: "build the widget" },
          acceptance: {
            commands: [{ cmd: `node -e "process.exit(0)"`, covers: ["R1"] }],
            files: ["expected.txt"],
          },
          ...(policy ? { policy } : {}),
        },
      ],
    });

    it("passes the tree guard when the worker stays inside the declared file set", async () => {
      execSync("git init", { cwd: workDir, stdio: "ignore" });
      fs.writeFileSync(path.join(workDir, "expected.txt"), "seed", "utf-8");
      const dispatch = new FakeDispatchService().script(() => {
        // In-scope write only.
        fs.writeFileSync(path.join(workDir, "expected.txt"), "built", "utf-8");
        return okResult();
      });
      const engine = makeEngine(makeFastSpec(), dispatch, { requirements: fastRequirements });

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("done");
      expect(snapshot.lane).toBe("fast");
      const stage = snapshot.stages[0]!;
      expect(stage.treeGuard).toMatchObject({ checked: true, outOfScopePaths: [] });
      expect(stage.treeGuard?.upgraded).toBeUndefined();
      expect(dispatch.calls).toHaveLength(1);
      expect(snapshot.laneEvents ?? []).toHaveLength(0);
    });

    it("upgrades in place to a reviewed run when the worker writes out of scope", async () => {
      execSync("git init", { cwd: workDir, stdio: "ignore" });
      fs.writeFileSync(path.join(workDir, "expected.txt"), "seed", "utf-8");
      const dispatch = new FakeDispatchService()
        .script(() => {
          // In-scope write PLUS an undeclared file → the guard must see it.
          fs.writeFileSync(path.join(workDir, "expected.txt"), "built", "utf-8");
          fs.writeFileSync(path.join(workDir, "unplanned.txt"), "boom", "utf-8");
          return okResult();
        })
        .script(() => reviewResult("PASS"));
      const engine = makeEngine(makeFastSpec(), dispatch, { requirements: fastRequirements });

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("done");
      expect(snapshot.lane).toBe("fast");
      const stage = snapshot.stages[0]!;
      expect(stage.treeGuard).toMatchObject({
        checked: true,
        outOfScopePaths: ["unplanned.txt"],
        upgraded: true,
      });
      // The upgrade dispatched a read-only review after the worker turn.
      expect(dispatch.calls).toHaveLength(2);
      expect(dispatch.calls[1]!.kind).toBe("review");
      // The upgrade review inherits the stage's declared agent — real role
      // resolution has no reviewer config to fall back on in the fast lane.
      expect(dispatch.calls[1]!.agent).toBe("codex");
      expect(dispatch.calls[1]!.task).toContain("outside the");
      expect(dispatch.calls[1]!.task).toContain("unplanned.txt");
      // The lane event is recorded for the ledger audit trail.
      expect(snapshot.laneEvents).toHaveLength(1);
      expect(snapshot.laneEvents![0]).toMatchObject({
        stage: "implement",
        event: "tree-guard-upgrade",
      });
      expect(snapshot.laneEvents![0]!.detail).toContain("unplanned.txt");
      // The stage transitions show the in-place review insertion.
      expect(stage.transitions.map((t) => t.status)).toEqual([
        "pending",
        "dispatched",
        "running",
        "acceptance",
        "review",
        "passed",
      ]);
    });

    it("escalates when the tree-guard upgrade review still fails", async () => {
      execSync("git init", { cwd: workDir, stdio: "ignore" });
      fs.writeFileSync(path.join(workDir, "expected.txt"), "seed", "utf-8");
      const dispatch = new FakeDispatchService()
        .script(() => {
          fs.writeFileSync(path.join(workDir, "unplanned.txt"), "boom", "utf-8");
          return okResult();
        })
        .script(() => reviewResult("FAIL"));
      const engine = makeEngine(makeFastSpec({ maxReworkRounds: 0 }), dispatch, {
        requirements: fastRequirements,
      });

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("escalated");
      expect(snapshot.stages[0]!.treeGuard).toMatchObject({
        checked: true,
        outOfScopePaths: ["unplanned.txt"],
        upgraded: true,
      });
    });

    it("forces a sampled post-acceptance review when the seeded sampler selects the stage", async () => {
      execSync("git init", { cwd: workDir, stdio: "ignore" });
      fs.writeFileSync(path.join(workDir, "expected.txt"), "seed", "utf-8");
      const dispatch = new FakeDispatchService()
        .script(() => okResult())
        .script(() => reviewResult("PASS"));
      const engine = makeEngine(makeFastSpec(), dispatch, {
        requirements: fastRequirements,
        // rate 1 → always sampled; deterministic by construction.
        samplingRate: 1,
      });

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("done");
      const stage = snapshot.stages[0]!;
      expect(stage.sampleReview).toMatchObject({ verdict: "PASS" });
      expect(dispatch.calls).toHaveLength(2);
      expect(dispatch.calls[1]!.kind).toBe("review");
      // The sampled audit inherits the stage's declared agent — real role
      // resolution has no reviewer config to fall back on in the fast lane.
      expect(dispatch.calls[1]!.agent).toBe("codex");
      expect(dispatch.calls[1]!.task).toContain("Sampled post-acceptance review");
      expect(snapshot.laneEvents).toHaveLength(1);
      expect(snapshot.laneEvents![0]).toMatchObject({
        stage: "implement",
        event: "sampled-review",
      });
    });

    it("fails closed when the sampled review returns a non-PASS verdict", async () => {
      execSync("git init", { cwd: workDir, stdio: "ignore" });
      fs.writeFileSync(path.join(workDir, "expected.txt"), "seed", "utf-8");
      const dispatch = new FakeDispatchService()
        .script(() => okResult())
        .script(() => reviewResult("FAIL", { findings: [] }));
      const engine = makeEngine(makeFastSpec(), dispatch, {
        requirements: fastRequirements,
        samplingRate: 1,
      });

      const snapshot = await engine.run();

      expect(snapshot.status).toBe("escalated");
      expect(snapshot.stages[0]!.sampleReview).toMatchObject({ verdict: "FAIL" });
      expect(snapshot.evidence?.reason).toContain("Sampled post-acceptance review returned FAIL");
    });
  });

  // P-079②: a resumed run inherits already-passed stage records from the
  // prior terminal snapshot and re-dispatches ONLY the pending stages.
  describe("resume (P-079② checkpoint resume)", () => {
    const twoStageSpec: WorkflowSpec = {
      name: "resumable",
      stages: [
        { name: "s1", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "one" } },
        { name: "s2", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "two" } },
      ],
    };

    it("skips passed stages and re-runs only pending ones", async () => {
      // First run: s1 passes, s2 dispatch-fails → terminal escalated
      // (fail-closed default policy.escalateOn="any").
      const first = new FakeDispatchService()
        .script(() => okResult())
        .script(() => failResult({ error: "vendor 503" }));
      const firstEngine = makeEngine(twoStageSpec, first);
      const firstSnapshot = await firstEngine.run();
      expect(firstSnapshot.status).toBe("escalated");
      expect(firstSnapshot.stages.map((s) => s.status)).toEqual(["passed", "escalated"]);

      const persisted = readPersistedWorkflowSnapshot(firstSnapshot.workflowId, { homeDir });
      expect(persisted).toBeDefined();

      // Resumed run: only s2 re-dispatches; s1 is inherited as passed.
      const second = new FakeDispatchService().script(() => okResult());
      const secondEngine = makeEngine(twoStageSpec, second, { resumeSnapshot: persisted });
      const snapshot = await secondEngine.run();

      expect(snapshot.status).toBe("done");
      expect(snapshot.stages.map((s) => s.status)).toEqual(["passed", "passed"]);
      expect(second.calls).toHaveLength(1);
      expect(second.calls[0]!.task).toBe("two");
    });

    it("ignores a resume snapshot from a DIFFERENT spec name and runs everything", async () => {
      const first = new FakeDispatchService().script(() => okResult());
      const firstEngine = makeEngine(
        {
          name: "other-spec",
          stages: [
            { name: "s1", roles: ["worker"], dispatch: { agent: "codex", taskTemplate: "x" } },
          ],
        },
        first,
      );
      const firstSnapshot = await firstEngine.run();
      const persisted = readPersistedWorkflowSnapshot(firstSnapshot.workflowId, { homeDir });

      const second = new FakeDispatchService().script(() => okResult());
      const snapshot = await makeEngine(twoStageSpec, second, { resumeSnapshot: persisted }).run();
      expect(snapshot.status).toBe("done");
      expect(second.calls).toHaveLength(2);
    });
  });
});

/** Counts rework rounds across a snapshot (evidence chain sanity helper). */
function reviewRoundCount(snapshot: { stages: Array<{ review?: { rounds: unknown[] } }> }): number {
  return snapshot.stages.reduce((sum, stage) => sum + (stage.review?.rounds.length ?? 0), 0);
}
