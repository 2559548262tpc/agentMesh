import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { BackgroundDispatchService } from "../../src/mcp/tools.js";
import { BackgroundTaskRegistry } from "../../src/core/background.js";
import { CheckpointStore } from "../../src/core/checkpoint.js";
import { createAgentMeshEventBus } from "../../src/core/events.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  TransportMode,
} from "../../src/agents/types.js";

/**
 * run_workflow / get_workflow MCP protocol tests (ROADMAP_v0.4 M4): the tool
 * contract (discovery, spec validation errors, async launch + terminal
 * observation, persisted NOT_FOUND) is exercised over the real MCP boundary
 * with a scripted in-process adapter — no real vendors, no quota.
 */

class WorkflowTestAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Workflow Test Adapter";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "TEST_CODEX_BIN";
  readonly defaultExecutableName = "node";

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    const verdictRequired = options.reviewVerdictRequired;
    if (options.role === "reviewer") {
      if (options.task.includes("FAIL_TRIGGER")) {
        const failOutput = `FAIL\n- severity: high\n  file: src/auth.ts\n  line: 42\n  issue: SQL Injection\n  suggestion: Use parameterized query`;
        return this.formatSuccessResult(failOutput, Date.now(), {
          nativeSessionId: "native_wf_rev_fail",
          exitCode: 0,
          role: "reviewer",
          reviewVerdictRequired: verdictRequired,
        });
      }
      return this.formatSuccessResult("PASS\nAll checks passed cleanly.", Date.now(), {
        nativeSessionId: "native_wf_rev_pass",
        exitCode: 0,
        role: "reviewer",
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.task.includes("REWORK ROUND")) {
      return this.formatSuccessResult("Rework fix applied", Date.now(), {
        nativeSessionId: options.nativeSessionId || "native_wf_fix",
        exitCode: 0,
        summary: "Rework fix applied",
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    return this.formatSuccessResult(`Executed: ${options.task}`, Date.now(), {
      nativeSessionId: options.nativeSessionId || "native_wf_worker",
      exitCode: 0,
      summary: `Executed: ${options.task}`,
      role: options.role,
      reviewVerdictRequired: verdictRequired,
    });
  }
}

interface WorkflowPayload {
  workflowId?: string;
  status?: string;
  name?: string;
  stages?: Array<{
    name: string;
    status: string;
    tasks?: Array<{ taskId: string; status: string }>;
    review?: { verdict?: string; rounds?: Array<{ reviewOutcome: string }> };
    acceptance?: { ok?: boolean };
  }>;
  stages_listed?: string[];
  ledgerRef?: string;
  error?: string;
  issues?: string[];
}

/** v0.5 compact envelope (P-080①): bounded stage list + flag bits, no payloads. */
interface CompactWorkflowPayload {
  workflowId?: string;
  status?: string;
  stageCount?: number;
  stages?: Array<{ name: string; status: string }>;
  flags?: { unresolvedP0P1?: number; coverage?: string; anomalies?: string[] };
  ledgerRef?: string;
  needsRulingIds?: string[];
}

function parsePayload(res: unknown): WorkflowPayload {
  const content = (res as { content?: Array<{ type: string; text: string }> }).content ?? [];
  const text = content[0]?.text ?? "{}";
  // Tier 0 (P-080②): an oversized full snapshot is persisted and replaced by
  // its tail + path — the honest way to read it back is from the artifact.
  const tier0 = text.match(
    /^\[tier0: return body \d+ chars exceeded \d+; full output persisted to (.+?); showing/,
  );
  if (tier0) {
    return JSON.parse(fs.readFileSync(tier0[1]!, "utf-8")) as WorkflowPayload;
  }
  return JSON.parse(text) as WorkflowPayload;
}

describe("mcp/workflow protocol integration (run_workflow + get_workflow)", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-wfmcp-home-")));
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-wfmcp-cwd-")));
    process.env.AGENTMESH_SESSIONS_FILE = path.join(homeDir, "sessions.json");

    const registry = new AgentRegistry();
    registry.register(new WorkflowTestAdapter());
    const runner = new MultiAgentRunner(registry, new SessionManager({ persist: false }));
    const background = new BackgroundDispatchService(
      new BackgroundTaskRegistry({ homeDir, eventBus: createAgentMeshEventBus() }),
      { checkpointStore: new CheckpointStore({ homeDir }) },
    );

    const server = createMcpServer({ runner, backgroundService: background });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    delete process.env.AGENTMESH_SESSIONS_FILE;
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
    try {
      await clientTransport.close();
      await serverTransport.close();
    } catch {
      // ignore
    }
  });

  it("exposes run_workflow and get_workflow in the tool contract", async () => {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);
    expect(names).toContain("run_workflow");
    expect(names).toContain("get_workflow");
    const run = response.tools.find((tool) => tool.name === "run_workflow")!;
    expect(run.description).toContain("deterministic state machine");
    expect(run.description).toContain("get_workflow");
  });

  it("rejects an invalid spec with structured per-issue errors", async () => {
    const res = await client.callTool({
      name: "run_workflow",
      arguments: {
        spec: {
          name: "broken",
          stages: [{ name: "s1", dispatch: { taskTemplate: "t" } }],
        },
      },
    });
    expect(res.isError).toBe(true);
    const payload = parsePayload(res);
    expect(payload.error).toBe("INVALID_SPEC");
    expect(payload.issues?.[0]).toContain("exactly one of");
  });

  it("runs a worker workflow asynchronously and observes the terminal snapshot", async () => {
    const launch = await client.callTool({
      name: "run_workflow",
      arguments: {
        cwd: workDir,
        spec: {
          name: "panel-build",
          stages: [
            {
              name: "implement",
              roles: ["worker"],
              dispatch: {
                agent: "codex",
                taskTemplate: "Build the {{workflowName}} {{stageName}}",
              },
              acceptance: { commands: [`node -e "process.exit(0)"`] },
            },
          ],
        },
      },
    });
    expect(launch.isError).toBeFalsy();
    const launched = parsePayload(launch);
    expect(launched.status).toBe("running");
    expect(launched.workflowId).toMatch(/^wf_/);
    expect(launched.stages).toEqual(["implement"]);

    // Event-driven long-poll until the terminal snapshot arrives. v0.5: the
    // full snapshot requires an explicit detail:"full" request — the compact
    // envelope is the default (asserted separately below).
    let payload: WorkflowPayload = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await client.callTool({
        name: "get_workflow",
        arguments: { workflowId: launched.workflowId!, maxWaitMs: 2_000, detail: "full" },
      });
      payload = parsePayload(res);
      if (
        payload.status === "done" ||
        payload.status === "failed" ||
        payload.status === "escalated"
      )
        break;
    }
    expect(payload.status).toBe("done");
    const stage = payload.stages?.[0];
    if (!stage) throw new Error("terminal snapshot carried no stage record");
    expect(stage.name).toBe("implement");
    expect(stage.status).toBe("passed");
    expect(stage.tasks).toHaveLength(1);
    expect(stage.tasks![0]!.taskId).toBe(`${launched.workflowId}_s0_1`);
    expect(stage.acceptance).toMatchObject({ ok: true });
    expect(resIsErrorFor(payload.status)).toBe(false);

    // Compact default (P-080①): bounded envelope with flag bits, no task
    // payloads, and the Tier 0 rule keeps it far below the spill threshold.
    const compactRes = await client.callTool({
      name: "get_workflow",
      arguments: { workflowId: launched.workflowId! },
    });
    const compactPayload = JSON.parse(
      (compactRes.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as CompactWorkflowPayload;
    expect(compactPayload.status).toBe("done");
    expect(compactPayload.stages).toEqual([{ name: "implement", status: "passed" }]);
    expect(compactPayload.flags?.unresolvedP0P1).toBe(0);
  });

  it("runs the reviewer-stage rework loop to a PASS verdict through MCP", async () => {
    const launch = await client.callTool({
      name: "run_workflow",
      arguments: {
        cwd: workDir,
        spec: {
          name: "reviewed-build",
          stages: [
            {
              name: "build",
              roles: ["worker"],
              dispatch: { agent: "codex", taskTemplate: "Build it" },
            },
            {
              name: "review",
              roles: ["reviewer"],
              dispatch: { agent: "codex", taskTemplate: "Review FAIL_TRIGGER" },
              policy: { maxReworkRounds: 1 },
            },
          ],
        },
      },
    });
    const launched = parsePayload(launch);
    expect(launched.status).toBe("running");

    let payload: WorkflowPayload = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await client.callTool({
        name: "get_workflow",
        arguments: { workflowId: launched.workflowId!, maxWaitMs: 2_000, detail: "full" },
      });
      payload = parsePayload(res);
      if (payload.status !== "running") break;
    }
    expect(payload.status).toBe("done");
    const review = payload.stages?.[1]?.review;
    if (!review) throw new Error("terminal snapshot carried no review record");
    expect(review.verdict).toBe("PASS");
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds![0]).toMatchObject({ fixStatus: "success", reviewOutcome: "PASS" });
  });

  it("reports an unknown workflow id as NOT_FOUND", async () => {
    const res = await client.callTool({
      name: "get_workflow",
      arguments: { workflowId: "wf_missing" },
    });
    expect(res.isError).toBe(true);
    expect(parsePayload(res).error).toBe("NOT_FOUND");
  });

  describe("v0.5 requirements reconciliation over MCP", () => {
    const writeRequirements = (options: { quote?: string } = {}) => {
      const sourceDoc = "# Spec\n\n- build the widget\n- 要好看\n";
      fs.writeFileSync(path.join(workDir, "spec-doc.md"), sourceDoc, "utf-8");
      fs.writeFileSync(
        path.join(workDir, "requirements.json"),
        JSON.stringify({
          source: "spec-doc.md",
          items: [
            {
              id: "R1",
              ears: "The system SHALL build the widget",
              kind: "unconditional",
              quote: options.quote ?? "build the widget",
              decidable: true,
            },
            { id: "R2", ears: null, kind: null, quote: "要好看", decidable: false },
          ],
        }),
        "utf-8",
      );
    };

    const stageWithRequirements = {
      name: "implement",
      roles: ["worker"],
      requirements: ["R1", "R2"],
      dispatch: { agent: "codex", taskTemplate: "Build it" },
      acceptance: {
        commands: [{ cmd: `node -e "process.exit(0)"`, covers: ["R1"] }],
      },
    };

    it("fails closed on a quote that is not a verbatim source substring", async () => {
      writeRequirements({ quote: "fabricated sentence" });
      const res = await client.callTool({
        name: "run_workflow",
        arguments: {
          cwd: workDir,
          requirementsPath: "requirements.json",
          spec: { name: "wf", stages: [stageWithRequirements] },
        },
      });
      expect(res.isError).toBe(true);
      const payload = parsePayload(res) as unknown as { error?: string; source?: string };
      expect(payload.error).toBe("QUOTE_VERIFICATION_FAILED");
      expect(payload.source).toBe("spec-doc.md");
    });

    it("rejects spec-declared requirement ids missing from the requirements set", async () => {
      writeRequirements();
      const res = await client.callTool({
        name: "run_workflow",
        arguments: {
          cwd: workDir,
          requirementsPath: "requirements.json",
          spec: {
            name: "wf",
            stages: [
              {
                ...stageWithRequirements,
                requirements: ["R1", "R9"],
              },
            ],
          },
        },
      });
      expect(res.isError).toBe(true);
      const payload = parsePayload(res) as unknown as { error?: string; issues?: string[] };
      expect(payload.error).toBe("INVALID_REQUIREMENTS");
      expect(payload.issues?.[0]).toContain("R9");
    });

    it("runs to needs_ruling with the compact envelope carrying coverage and the ledger pointer", async () => {
      writeRequirements();
      const launch = await client.callTool({
        name: "run_workflow",
        arguments: {
          cwd: workDir,
          requirementsPath: "requirements.json",
          spec: { name: "reconciled", stages: [stageWithRequirements] },
        },
      });
      expect(launch.isError).toBeFalsy();
      const launched = parsePayload(launch);

      let payload: WorkflowPayload & CompactWorkflowPayload = {};
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const res = await client.callTool({
          name: "get_workflow",
          arguments: { workflowId: launched.workflowId!, maxWaitMs: 2_000 },
        });
        payload = parsePayload(res);
        if (payload.status !== "running") break;
      }
      expect(payload.status).toBe("needs_ruling");
      expect(payload.flags?.coverage).toBe("1/2（1 PENDING_RULING）");
      expect((payload.flags?.anomalies ?? []).join("\n")).toContain("needs_ruling:1");
      expect(payload.ledgerRef).toContain(path.join("out", `ledger_${launched.workflowId}.json`));
      const ledger = JSON.parse(fs.readFileSync(payload.ledgerRef!, "utf-8")) as {
        rows: Array<{ id: string; status: string }>;
        invariant: { ok: boolean };
      };
      expect(ledger.rows.find((row) => row.id === "R1")).toMatchObject({ status: "PASS" });
      expect(ledger.rows.find((row) => row.id === "R2")).toMatchObject({
        status: "PENDING_RULING",
      });
      expect(ledger.invariant.ok).toBe(true);
      expect(resIsErrorFor(payload.status)).toBe(false);
    });
  });
});

/** Terminal failure statuses surface as MCP errors (delegate_task convention). */
function resIsErrorFor(status: string | undefined): boolean {
  return status === "failed" || status === "escalated";
}
