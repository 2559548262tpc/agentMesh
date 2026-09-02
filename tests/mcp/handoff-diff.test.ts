import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../../src/mcp/server.js";
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
 * M7 handoff_diff protocol tests: two in-process Bridge sessions built through
 * the real dispatch path (MultiAgentRunner + SessionManager with a persisted
 * storage file), so the shared-context audit sidecars the tool consumes are
 * produced by the production recordTurn seam. The dispatch cwd is an isolated
 * throwaway git repo so repository-fingerprint freshness (MATCHED) cannot be
 * perturbed by parallel test files writing into this repository's tree.
 */
class HandoffTestAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Handoff Test Codex";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "HANDOFF_TEST_CODEX_BIN";
  readonly defaultExecutableName = "node";

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    if (options.task.includes("LONG_ANSWER")) {
      return this.formatSuccessResult("vendor log line", Date.now(), {
        nativeSessionId: "native_handoff_source",
        exitCode: 0,
        summary: "Source task completed with an oversized answer",
        finalAnswer: "z".repeat(4600),
        role: options.role,
        reviewVerdictRequired: options.reviewVerdictRequired,
      });
    }
    return this.formatSuccessResult(`Executed: ${options.task}`, Date.now(), {
      nativeSessionId: "native_handoff_test",
      exitCode: 0,
      summary: `Completed: ${options.task}`,
      finalAnswer: `Final answer for: ${options.task}`,
      role: options.role,
      reviewVerdictRequired: options.reviewVerdictRequired,
    });
  }
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function extractText(result: ToolCallResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

describe("mcp/handoff_diff protocol", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let runner: MultiAgentRunner;
  let sessionManager: SessionManager;
  let homeDir: string;
  let repoDir: string;

  beforeEach(async () => {
    homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-handoff-home-")));
    process.env.AGENTMESH_SESSIONS_FILE = path.join(homeDir, "sessions.json");

    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-handoff-repo-")));
    execSync("git init", { cwd: repoDir, stdio: "ignore" });

    const registry = new AgentRegistry();
    registry.register(new HandoffTestAdapter());
    // Persisted manager on the relocated home so shared-context audit sidecars
    // (content basis) are written and readable by the tool.
    sessionManager = new SessionManager();
    runner = new MultiAgentRunner(registry, sessionManager);

    const server = createMcpServer({ runner });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    delete process.env.AGENTMESH_SESSIONS_FILE;
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    try {
      await clientTransport.close();
      await serverTransport.close();
    } catch {
      // ignore
    }
  });

  async function callHandoffDiff(
    upstreamSessionId: string,
    downstreamSessionId: string,
  ): Promise<ToolCallResult> {
    const result = (await client.callTool({
      name: "handoff_diff",
      arguments: { upstreamSessionId, downstreamSessionId },
    })) as ToolCallResult;
    return result;
  }

  it("exposes handoff_diff in the tool contract", async () => {
    const response = await client.listTools();
    const tool = response.tools.find((candidate) => candidate.name === "handoff_diff");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain(
      "lossless | minor-truncation | partial-loss | severe-loss | lost",
    );
  });

  it("judges an intact in-process handoff lossless from the recorded verbatim injection", async () => {
    const upstream = await runner.delegateTask({
      agent: "codex",
      task: "SOURCE implement the parser module",
      cwd: repoDir,
    });
    const downstream = await runner.delegateTask({
      agent: "codex",
      task: "CONSUMER continue the parser work",
      cwd: repoDir,
      contextSessionIds: [upstream.sessionId!],
    });

    const result = await callHandoffDiff(upstream.sessionId!, downstream.sessionId!);
    const text = extractText(result);

    expect(result.isError).toBe(false);
    expect(text).toContain("Handoff fidelity grade: lossless");
    expect(text).toContain('"grade": "lossless"');
    // The sidecar audit artifact was readable: judgments ran on the delivered bytes.
    expect(text).toContain('"basis": "content"');
    expect(text).toContain('"freshness": "MATCHED"');
    expect(text).toContain('"state": "preserved"');
    expect(text).toContain('"missingKeys": []');
  });

  it("detects the truncated oversized final answer (minor-truncation)", async () => {
    const upstream = await runner.delegateTask({
      agent: "codex",
      task: "SOURCE LONG_ANSWER produce the oversized report",
      cwd: repoDir,
    });
    const downstream = await runner.delegateTask({
      agent: "codex",
      task: "CONSUMER continue the report work",
      cwd: repoDir,
      contextSessionIds: [upstream.sessionId!],
    });

    const result = await callHandoffDiff(upstream.sessionId!, downstream.sessionId!);
    const text = extractText(result);

    expect(result.isError).toBe(false);
    expect(text).toContain('"grade": "minor-truncation"');
    expect(text).toContain('"section": "finalAnswer"');
    expect(text).toContain('"state": "truncated"');
    expect(text).toContain('"truncatedKeys": [\n    "finalAnswer"\n  ]');
  });

  it("grades lost when the downstream session consumed no context", async () => {
    const upstream = await runner.delegateTask({
      agent: "codex",
      task: "SOURCE implement the parser module",
      cwd: repoDir,
    });
    const downstream = await runner.delegateTask({
      agent: "codex",
      task: "CONSUMER without any context handoff",
      cwd: repoDir,
    });

    const result = await callHandoffDiff(upstream.sessionId!, downstream.sessionId!);
    const text = extractText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("Handoff fidelity grade: lost");
    expect(text).toContain('"grade": "lost"');
    expect(text).not.toContain('"state": "preserved"');
  });

  it("returns structured errors for unknown sessions and an empty upstream history", async () => {
    const missing = await callHandoffDiff("bridge-sess_missing", "bridge-sess_also_missing");
    expect(missing.isError).toBe(true);
    expect(extractText(missing)).toContain("Upstream session 'bridge-sess_missing' not found.");

    const emptyUpstream = sessionManager.createSession({ agent: "codex", cwd: repoDir });
    const result = await callHandoffDiff(emptyUpstream.id, "bridge-sess_any");
    expect(result.isError).toBe(true);
    expect(extractText(result)).toContain(
      `Upstream session '${emptyUpstream.id}' has no recorded turns to compare.`,
    );

    const upstream = await runner.delegateTask({
      agent: "codex",
      task: "SOURCE implement the parser module",
      cwd: repoDir,
    });
    const missingDownstream = await callHandoffDiff(upstream.sessionId!, "bridge-sess_missing");
    expect(missingDownstream.isError).toBe(true);
    expect(extractText(missingDownstream)).toContain(
      "Downstream session 'bridge-sess_missing' not found.",
    );
  });
});
