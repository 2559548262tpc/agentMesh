import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import { readFindings } from "../../src/core/findings.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  TransportMode,
} from "../../src/agents/types.js";

class TestAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Test Codex Adapter";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "TEST_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public lastRunOptions?: RunAgentOptions;

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    this.lastRunOptions = options;
    const verdictRequired = options.reviewVerdictRequired;
    if (options.task.includes("CANCEL_WAIT")) {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 15_000);
      });
      return this.formatSuccessResult("Finished after cancellation", Date.now(), {
        nativeSessionId: "native_cancel",
        exitCode: 0,
        summary: "Completed",
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.task.includes("RAW_OUTPUT_TRIGGER")) {
      return this.formatSuccessResult("vendor log line A\nvendor log line B", Date.now(), {
        nativeSessionId: "native_raw",
        exitCode: 0,
        summary: "Task completed: RAW_OUTPUT_TRIGGER",
        finalAnswer: "Clean final answer",
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.role === "reviewer") {
      if (options.task.includes("UNKNOWN_TRIGGER")) {
        return this.formatSuccessResult("Review finished without a verdict.", Date.now(), {
          nativeSessionId: "native_rev_unknown",
          exitCode: 0,
          finalAnswer: "Review finished without a verdict.",
          role: "reviewer",
          reviewVerdictRequired: verdictRequired,
        });
      }
      if (options.task.includes("FAIL_TRIGGER")) {
        const failOutput = `FAIL\n- severity: high\n  file: src/auth.ts\n  line: 42\n  issue: SQL Injection\n  suggestion: Use parameterized query`;
        return this.formatSuccessResult(failOutput, Date.now(), {
          nativeSessionId: "native_rev_fail",
          exitCode: 0,
          role: "reviewer",
          reviewVerdictRequired: verdictRequired,
        });
      }
      if (options.task.includes("FAIL_NOOP_TRIGGER")) {
        const failOutput = `FAIL\n- severity: medium\n  file: src/config.ts\n  line: 7\n  issue: Unused variable\n  suggestion: Remove it`;
        return this.formatSuccessResult(failOutput, Date.now(), {
          nativeSessionId: "native_rev_fail_noop",
          exitCode: 0,
          role: "reviewer",
          reviewVerdictRequired: verdictRequired,
        });
      }
      return this.formatSuccessResult("PASS\nAll checks passed cleanly.", Date.now(), {
        nativeSessionId: "native_rev_123",
        exitCode: 0,
        role: "reviewer",
        reviewVerdictRequired: verdictRequired,
      });
    }

    // M3 rework-closure fixture: a worker fix turn that (only for the SQL
    // Injection finding scenario) repairs the repository by writing a file so
    // the rework loop's repository fingerprints differ across the fix turn.
    if (options.task.includes("REWORK ROUND")) {
      if (options.task.includes("SQL Injection") && options.cwd) {
        fs.writeFileSync(path.join(options.cwd, "rework-fix-applied.txt"), "fix applied", "utf-8");
      }
      return this.formatSuccessResult("Rework fix applied", Date.now(), {
        nativeSessionId: options.nativeSessionId || "native_rework_fix",
        exitCode: 0,
        summary: "Rework fix applied",
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }

    return this.formatSuccessResult(`Executed successfully: ${options.task}`, Date.now(), {
      nativeSessionId: options.nativeSessionId || "native_sess_999",
      exitCode: 0,
      summary: `Task completed: ${options.task}`,
      finalAnswer: `Executed successfully: ${options.task}`,
      role: options.role,
      reviewVerdictRequired: verdictRequired,
    });
  }
}

describe("mcp/tools protocol integration", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let runner: MultiAgentRunner;
  let adapter: TestAdapter;
  // M3 findings-store isolation: review_changes persists findings.jsonl under
  // the AgentMesh home, so every test in this file relocates the home into a
  // temp directory (same relocation seam as AGENTMESH_SESSIONS_FILE).
  let findingsHomeDir: string;

  beforeEach(async () => {
    findingsHomeDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-tools-home-")),
    );
    process.env.AGENTMESH_SESSIONS_FILE = path.join(findingsHomeDir, "sessions.json");

    const registry = new AgentRegistry();
    const sessionManager = new SessionManager({ persist: false });
    adapter = new TestAdapter();
    registry.register(adapter);
    runner = new MultiAgentRunner(registry, sessionManager);

    const server = createMcpServer({ runner });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    delete process.env.AGENTMESH_SESSIONS_FILE;
    fs.rmSync(findingsHomeDir, { recursive: true, force: true });
    try {
      await clientTransport.close();
      await serverTransport.close();
    } catch {
      // ignore
    }
  });

  it("discovers the complete MCP tool contract", async () => {
    const response = await client.listTools();
    const toolNames = response.tools.map((t) => t.name);

    expect(toolNames).toContain("delegate_task");
    expect(toolNames).toContain("review_changes");
    expect(toolNames).toContain("continue_task");
    expect(toolNames).toContain("list_agents");
    expect(toolNames).toContain("get_session");
    expect(toolNames).toContain("get_role_config");
    expect(toolNames).toContain("compact_context");
  });

  it("encodes the delegation disciplines in the delegate_task description (T4.3)", async () => {
    const response = await client.listTools();
    const description = response.tools.find((tool) => tool.name === "delegate_task")?.description;

    expect(description).toContain("NEVER delegate understanding");
    expect(description).toContain("based on your findings");
    expect(description).toContain("serialize write tasks");
    expect(description).toContain("SAME session");
    expect(description).toContain("fresh eyes");
    expect(description).toContain("test results and a summary of changes");
    // v5 discipline additions (ORCHESTRATION.md §9 checklist as protocol-as-prompt).
    expect(description).toContain("MUST use background:true");
    expect(description).toContain("MUST pass contextSessionIds");
    expect(description).toContain("never skip the reviewer");
    expect(description).toContain("Complexity gate");

    const reviewDescription = response.tools.find(
      (tool) => tool.name === "review_changes",
    )?.description;
    expect(reviewDescription).toContain("contextSessionIds");
  });

  it("includes long-poll guidance in the background dispatch response", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Long-running background work",
        background: true,
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("[Background Task Accepted]");
    expect(content[0]?.text).toContain("maxWaitMs=30000");
    expect(content[0]?.text).toContain("Long-poll guidance");
  });

  it("compacts a source session over MCP and reports the summarized outcome (T2.3)", async () => {
    const source = await runner.delegateTask({ agent: "codex", task: "Seed compaction source" });

    const res = await client.callTool({
      name: "compact_context",
      arguments: { sourceSessionIds: [source.sessionId!] },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("| Status: SUMMARIZED] Turns covered: 1");
    // The echoed answer unwraps to the template's eight-section deliverable.
    expect(content[0]?.text).toContain("Original Intent");
    expect(runner.getSession(source.sessionId!)?.history).toHaveLength(1);
  });

  it("reports a failed compaction for an unknown session as an MCP error", async () => {
    const res = await client.callTool({
      name: "compact_context",
      arguments: { sourceSessionIds: ["bridge-sess_missing"] },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("| Status: FAILED]");
    expect(content[0]?.text).toContain("not found");
  });

  it("delegates a worker task through MCP", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Implement user registration",
        role: "worker",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Status: SUCCESS");
    expect(content[0]?.text).toContain("Summary: Task completed: Implement user registration");
    // Output equals the final answer here, so no separate Raw Output section is added.
    expect(content[0]?.text).not.toContain("Raw Output:");
    expect(content[0]?.text).toContain("Final Answer:");
    expect(content[0]?.text).toContain("Executed successfully: Implement user registration");
  });

  it("emits MCP progress notifications for agent tasks", async () => {
    const messages: string[] = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      if (notification.params.message) messages.push(notification.params.message);
    });

    const result = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "Report progress", role: "worker" },
      _meta: { progressToken: "agentmesh-progress-test" },
    });

    expect(result.isError).toBeFalsy();
    expect(messages).toEqual(["Agent task started", "Agent task success"]);
  });

  it("returns a successful reviewer verdict through MCP", async () => {
    const res = await client.callTool({
      name: "review_changes",
      arguments: {
        agent: "codex",
        task: "Review PR #42",
        baseCommit: "main",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("[Reviewer: codex | Review Outcome: PASS | Status: SUCCESS");
    expect(content[0]?.text).toContain("PASS");
    expect(content[0]?.text).toContain("Reviewer Safety:");
    expect(content[0]?.text).toContain('"mechanism": "prompt-only"');
  });

  it("propagates reviewer findings as an MCP error", async () => {
    const res = await client.callTool({
      name: "review_changes",
      arguments: {
        agent: "codex",
        task: "Review PR #42 FAIL_TRIGGER",
        baseCommit: "main",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: FAIL");
    expect(content[0]?.text).toContain("Status: FAILED");
    expect(content[0]?.text).toContain("Findings: 1");
    expect(content[0]?.text).toContain("SQL Injection");
  });

  it("fails closed for an unknown reviewer verdict", async () => {
    const res = await client.callTool({
      name: "review_changes",
      arguments: {
        agent: "codex",
        task: "UNKNOWN_TRIGGER",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: UNKNOWN");
    expect(content[0]?.text).not.toContain("Review Outcome: PASS");
    expect(content[0]?.text).not.toContain("--- REVIEW FINDINGS ---");
  });

  it("keeps a verdict-less reviewer reply non-fatal outside the review contract (N-R11-A)", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        role: "reviewer",
        task: "UNKNOWN_TRIGGER",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: UNKNOWN");
    expect(content[0]?.text).toContain("Status: SUCCESS");
    expect(content[0]?.text).toContain("No explicit PASS/FAIL verdict");
  });

  it("continues a Bridge session through MCP", async () => {
    const firstRun = await runner.delegateTask({
      agent: "codex",
      task: "Initial feature",
    });

    const res = await client.callTool({
      name: "continue_task",
      arguments: {
        sessionId: firstRun.sessionId!,
        task: "Fix review findings",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Status: SUCCESS");
    expect(content[0]?.text).toContain(firstRun.sessionId!);
  });

  it("marks an inherited reviewer FAIL verdict as an MCP error on continuation", async () => {
    const reviewRun = await runner.reviewChanges({ agent: "codex", task: "Review PR #42" });

    const res = await client.callTool({
      name: "continue_task",
      arguments: {
        sessionId: reviewRun.sessionId!,
        task: "Re-review after fixes FAIL_TRIGGER",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: FAIL");
  });

  it("passes multi-source context ids through the MCP boundary", async () => {
    const sourceRun = await runner.delegateTask({ agent: "codex", task: "Source turn" });

    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Consume sources over MCP",
        contextSessionIds: [sourceRun.sessionId!],
      },
    });

    expect(res.isError).toBeFalsy();
    expect(adapter.lastRunOptions?.historyContext).toContain(sourceRun.sessionId!);
    expect(adapter.lastRunOptions?.historyContext).toContain("Shared Turn 1");
  });

  it("rejects invalid task and timeout inputs at the MCP boundary", async () => {
    const blankTask = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "   " },
    });
    expect(blankTask.isError).toBe(true);

    const invalidTimeout = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "Valid task", timeoutMs: -1 },
    });
    expect(invalidTimeout.isError).toBe(true);
  });

  it("includes bounded vendor raw output for remote diagnostics", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "RAW_OUTPUT_TRIGGER", role: "worker" },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Final Answer:\nClean final answer");
    expect(content[0]?.text).toContain("Raw Output:\nvendor log line A");
  });

  it("records a cancelled turn as failed history instead of losing it", async () => {
    const callPromise = client
      .callTool({
        name: "delegate_task",
        arguments: { agent: "codex", task: "CANCEL_WAIT slow task" },
        _meta: { progressToken: "cancel-test" },
      })
      .catch(() => "connection closed");

    await new Promise((resolve) => setTimeout(resolve, 500));
    await clientTransport.close();
    await callPromise;

    for (let attempt = 0; attempt < 50; attempt++) {
      const target = runner
        .listSessions()
        .find((session) => session.history.some((turn) => turn.task.includes("CANCEL_WAIT")));
      if (target) {
        const turn = target.history.find((entry) => entry.task.includes("CANCEL_WAIT"));
        expect(turn?.status).toBe("failed");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("cancelled turn was never recorded in session history");
  });

  it("reports a missing project role assignment when agent is omitted", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        task: "Use configured worker",
        role: "worker",
        cwd: process.cwd(),
      },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("is not configured");
  });

  it("renders list_agents as a routing table with metadata, variants, and unmetered fallback (T4.2)", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-routing-"));
    try {
      fs.mkdirSync(path.join(projectRoot, ".agentmesh"));
      fs.writeFileSync(
        path.join(projectRoot, ".agentmesh", "config.json"),
        JSON.stringify({
          version: 1,
          roles: { worker: "codex" },
          agents: {
            codex: {
              tier: "weak",
              costLevel: 1,
              strengths: ["bulk edits"],
              notGoodAt: ["architecture decisions"],
              notes: "cheap lane for mechanical work",
              candidates: ["codex-medium"],
            },
            "codex-medium": { tier: "medium", costLevel: 3 },
          },
        }),
      );

      const res = await client.callTool({
        name: "list_agents",
        arguments: { cwd: projectRoot },
      });

      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      const text = content[0]?.text ?? "";
      expect(text).toContain("Agent Routing Table");
      expect(text).toContain("metadata source: configured");
      expect(text).toContain("== codex (Test Codex Adapter) ==");
      expect(text).toContain("Tier: weak | Cost level: 1");
      expect(text).toContain("Strengths: bulk edits");
      expect(text).toContain("Not good at: architecture decisions");
      expect(text).toContain("Candidates chain: codex-medium");
      // Channels without declared metadata degrade to unmetered, not errors.
      expect(text).toContain("Tier: unmetered | Cost level: unmetered");
      // A non-binary profile variant is listed in its own section.
      expect(text).toContain("Declared routing variants");
      expect(text).toContain("== codex-medium (variant) ==");
      expect(text).toContain("Tier: medium | Cost level: 3");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("exposes the verify_contract_map quick-review tool (M3)", async () => {
    const response = await client.listTools();
    const tool = response.tools.find((candidate) => candidate.name === "verify_contract_map");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("contract map");
    expect(tool!.description).toContain("without spending LLM tokens");
  });

  it("attaches the M3 enriched shape to review findings and records them in the findings store", async () => {
    const res = await client.callTool({
      name: "review_changes",
      arguments: {
        agent: "codex",
        task: "Review PR #42 FAIL_TRIGGER",
        baseCommit: "main",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    const findingsStart = text.indexOf("Findings:\n");
    expect(findingsStart).toBeGreaterThan(-1);
    const findingsEnd = text.indexOf("\nReviewer Safety:", findingsStart);
    const findings = JSON.parse(
      text.slice(findingsStart + "Findings:\n".length, findingsEnd),
    ) as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(1);
    // Existing parsed fields are unchanged; id/category/kind are additive.
    expect(findings[0]).toMatchObject({
      severity: "high",
      file: "src/auth.ts",
      line: "42",
      issue: "SQL Injection",
      suggestion: "Use parameterized query",
      category: "security",
      kind: "security",
    });
    expect(String(findings[0]!.id)).toMatch(/^fnd_[0-9a-f]{16}$/);

    const records = readFindings({ homeDir: findingsHomeDir });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      findingId: findings[0]!.id,
      reviewerAgent: "codex",
      category: "security",
      kind: "security",
      severity: "high",
      file: "src/auth.ts",
    });
    // No rework closure signal exists for a single-pass FAIL review.
    expect(records[0]!.confirmed).toBeUndefined();
  });

  it("marks rework-triggering findings confirmed when the rework closes PASS", async () => {
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-rework-")));
    try {
      execSync("git init", { cwd: projectDir, stdio: "ignore" });
      const seed = await runner.delegateTask({
        agent: "codex",
        task: "Seed worker for rework",
        cwd: projectDir,
      });

      const res = await client.callTool({
        name: "review_changes",
        arguments: {
          agent: "codex",
          task: "Review PR #42 FAIL_TRIGGER",
          cwd: projectDir,
          maxReworkRounds: 1,
          workerSessionId: seed.sessionId!,
        },
      });

      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("Review Outcome: PASS");
      expect(content[0]?.text).toContain("Rework Rounds: 1");
      // The fake worker fix turn wrote into the repo, so the fingerprints differ.
      expect(fs.existsSync(path.join(projectDir, "rework-fix-applied.txt"))).toBe(true);

      const records = readFindings({ homeDir: findingsHomeDir });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        reviewerAgent: "codex",
        category: "security",
        kind: "security",
        severity: "high",
        file: "src/auth.ts",
        confirmed: true,
        sessionId: seed.sessionId!,
      });
      expect(records[0]!.evidence).toContain("changed the repository");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("marks rework findings as false positives when the fix turn changes nothing", async () => {
    const projectDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-rework-noop-")),
    );
    try {
      execSync("git init", { cwd: projectDir, stdio: "ignore" });
      const seed = await runner.delegateTask({
        agent: "codex",
        task: "Seed worker for noop rework",
        cwd: projectDir,
      });

      const res = await client.callTool({
        name: "review_changes",
        arguments: {
          agent: "codex",
          task: "Review PR #7 FAIL_NOOP_TRIGGER",
          cwd: projectDir,
          maxReworkRounds: 1,
          workerSessionId: seed.sessionId!,
        },
      });

      expect(res.isError).toBeFalsy();

      const records = readFindings({ homeDir: findingsHomeDir });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        file: "src/config.ts",
        severity: "medium",
        confirmed: false,
      });
      expect(records[0]!.evidence).toContain("false positive");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("verifies a broken contract map over MCP with per-item failure statuses", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-contractmap-"));
    try {
      fs.writeFileSync(
        path.join(projectDir, "src.ts"),
        "export const a = 1;\n\nexport const b = 2;\n",
        "utf-8",
      );
      const res = await client.callTool({
        name: "verify_contract_map",
        arguments: {
          contractItems: [
            { id: "C1", text: "exports a" },
            { id: "C2", text: "exports b on a non-blank line" },
            { id: "C3", text: "covers the tests" },
          ],
          map: [
            { id: "C1", file: "src.ts", line: 1 },
            { id: "C2", file: "src.ts", line: 2 }, // blank line
            { id: "C4", file: "src.ts", line: 3 }, // not a contract item
            { id: "C3", file: "absent.ts", line: 1 }, // unreadable file
          ],
          cwd: projectDir,
        },
      });

      expect(res.isError).toBe(true);
      const content = res.content as Array<{ type: string; text: string }>;
      const report = JSON.parse(content[0]!.text) as {
        pass: boolean;
        items: Array<{ id: string; status: string; detail?: string }>;
      };
      expect(report.pass).toBe(false);
      const byId = new Map(report.items.map((item) => [item.id, item]));
      expect(byId.get("C1")).toMatchObject({ status: "ok", detail: "src.ts:1" });
      expect(byId.get("C2")).toMatchObject({ status: "empty" });
      expect(byId.get("C3")).toMatchObject({ status: "missing" });
      expect(byId.get("C3")?.detail).toContain("File not readable");
      expect(byId.get("C4")).toMatchObject({ status: "unknown-item" });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("passes a complete contract map over MCP without an error flag", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-contractmap-ok-"));
    try {
      fs.writeFileSync(path.join(projectDir, "src.ts"), "export const a = 1;\n", "utf-8");
      const res = await client.callTool({
        name: "verify_contract_map",
        arguments: {
          contractItems: [{ id: "C1", text: "exports a" }],
          map: [{ id: "C1", file: "src.ts", line: 1 }],
          cwd: projectDir,
        },
      });

      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toMatchObject({ pass: true });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
