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
  error?: string;
  issues?: string[];
}

function parsePayload(res: unknown): WorkflowPayload {
  const content = (res as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as WorkflowPayload;
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

    // Event-driven long-poll until the terminal snapshot arrives.
    let payload: WorkflowPayload = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await client.callTool({
        name: "get_workflow",
        arguments: { workflowId: launched.workflowId!, maxWaitMs: 2_000 },
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
        arguments: { workflowId: launched.workflowId!, maxWaitMs: 2_000 },
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
});

/** Terminal failure statuses surface as MCP errors (delegate_task convention). */
function resIsErrorFor(status: string | undefined): boolean {
  return status === "failed" || status === "escalated";
}
