import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleUiApiRequest } from "../../src/ui/api.js";

// ---------------------------------------------------------------------------
// Helpers to build seed data inside a throwaway homeDir.
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<{
    id: string;
    agent: string;
    role: string;
    cwd: string;
    createdAt: string;
    updatedAt: string;
    history: unknown[];
    metadata: Record<string, unknown>;
  }> = {},
) {
  return {
    id: overrides.id ?? "sess_1",
    agent: (overrides.agent as string) ?? "codex",
    role: (overrides.role as string) ?? "worker",
    cwd: overrides.cwd ?? "/tmp/project",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:01:00.000Z",
    history: overrides.history ?? [
      {
        role: "worker",
        task: "implement feature X",
        timestamp: "2026-01-01T00:00:30.000Z",
        status: "success",
        summary: "done",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
    ],
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

function makeRegistryLine(
  taskId: string,
  overrides: Partial<{
    pid: number;
    startedAtMs: number;
    outputFile: string;
    orphanedAtMs: number;
  }> = {},
) {
  return JSON.stringify({
    taskId,
    pid: overrides.pid ?? process.pid,
    startedAtMs: overrides.startedAtMs ?? 1_000_000,
    outputFile: overrides.outputFile ?? "",
    ...(overrides.orphanedAtMs !== undefined ? { orphanedAtMs: overrides.orphanedAtMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ui/api", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_ui_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const call = (method: string, pathname: string, query: Record<string, string> = {}) => {
    const params = new URLSearchParams(query);
    return handleUiApiRequest({ method, pathname, query: params, homeDir });
  };

  // -----------------------------------------------------------------------
  // /api/sessions — list + sorting
  // -----------------------------------------------------------------------

  it("returns sessions sorted by updatedAt descending", async () => {
    const sessions = [
      makeSession({ id: "older", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeSession({ id: "newer", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const res = await call("GET", "/api/sessions");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { sessions: Array<{ id: string }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]!.id).toBe("newer");
    expect(body.sessions[1]!.id).toBe("older");
  });

  it("returns lastModelId equal to the most recent requestedModel in history", async () => {
    const sessions = [
      makeSession({
        id: "model_session",
        updatedAt: "2026-01-01T00:02:00.000Z",
        history: [
          {
            role: "worker",
            task: "step 1",
            timestamp: "2026-01-01T00:00:00Z",
            status: "success",
            requestedModel: "model-old",
          },
          {
            role: "worker",
            task: "step 2",
            timestamp: "2026-01-01T00:01:00Z",
            status: "success",
            requestedModel: "model-new",
          },
        ],
      }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const res = await call("GET", "/api/sessions");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { sessions: Array<{ id: string; lastModelId?: string }> };
    expect(body.sessions[0]!.id).toBe("model_session");
    expect(body.sessions[0]!.lastModelId).toBe("model-new");
  });

  it("omits lastModelId when history has no requestedModel entries", async () => {
    const sessions = [
      makeSession({
        id: "no_model_session",
        updatedAt: "2026-01-01T00:02:00.000Z",
        history: [
          {
            role: "worker",
            task: "run tests",
            timestamp: "2026-01-01T00:00:00Z",
            status: "success",
            summary: "all green",
          },
        ],
      }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const res = await call("GET", "/api/sessions");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { sessions: Array<{ id: string; lastModelId?: string }> };
    expect(body.sessions[0]!.id).toBe("no_model_session");
    expect(body.sessions[0]!).not.toHaveProperty("lastModelId");
  });

  // -----------------------------------------------------------------------
  // /api/sessions/{id} — detail with full history
  // -----------------------------------------------------------------------

  it("returns full session detail including all history turns", async () => {
    const session = makeSession({
      id: "detail_test",
      history: [
        {
          role: "worker",
          task: "step 1",
          timestamp: "2026-01-01T00:00:00Z",
          status: "success",
          usage: { totalTokens: 100 },
        },
        {
          role: "reviewer",
          task: "review step 1",
          timestamp: "2026-01-01T00:01:00Z",
          status: "success",
          usage: { totalTokens: 200 },
        },
      ],
    });
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify([session]), "utf-8");

    const res = await call("GET", "/api/sessions/detail_test");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { history: unknown[]; id: string };
    expect(body.id).toBe("detail_test");
    expect(body.history).toHaveLength(2);
  });

  it("returns 404 for a non-existent session", async () => {
    fs.writeFileSync(path.join(homeDir, "sessions.json"), "[]", "utf-8");
    const res = await call("GET", "/api/sessions/missing");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // /api/tasks — status derivation
  // -----------------------------------------------------------------------

  it("derives interrupted status for an orphaned task", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_orphan.output");
    fs.writeFileSync(outputFile, "partial output", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_orphan", { orphanedAtMs: 2_000_000, outputFile }) + "\n",
      "utf-8",
    );

    const res = await call("GET", "/api/tasks");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { tasks: Array<{ taskId: string; status: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.taskId).toBe("task_orphan");
    expect(body.tasks[0]!.status).toBe("interrupted");
  });

  it("derives completed status from a stored result file", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_done.output");
    fs.writeFileSync(outputFile, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_done", { outputFile }) + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tasksDir, "task_done.result.json"),
      JSON.stringify({
        taskId: "task_done",
        status: "completed",
        summary: "all good",
        completedAtMs: 3_000_000,
      }),
      "utf-8",
    );

    const res = await call("GET", "/api/tasks");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      tasks: Array<{ taskId: string; status: string; result: unknown }>;
    };
    expect(body.tasks[0]!.status).toBe("completed");
    expect(body.tasks[0]!.result).toBeDefined();
  });

  it("lets a terminal result win over the orphan dead-letter mark (bridge restart after completion)", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_late.output");
    fs.writeFileSync(outputFile, "done output", "utf-8");
    // Duplicate registry lines mirror the append-only orphan scan: the task
    // finished, then a bridge restart dead-lettered its record anyway.
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      [
        makeRegistryLine("task_late", { outputFile, startedAtMs: 1_000_000 }),
        makeRegistryLine("task_late", {
          outputFile,
          startedAtMs: 1_000_000,
          orphanedAtMs: 2_000_000,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tasksDir, "task_late.result.json"),
      JSON.stringify({
        taskId: "task_late",
        status: "completed",
        summary: "finished before restart",
        completedAtMs: 1_500_000,
      }),
      "utf-8",
    );

    const res = await call("GET", "/api/tasks");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { tasks: Array<{ taskId: string; status: string }> };
    // Deduped to one entry, and the finished work is not mislabeled as interrupted.
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.taskId).toBe("task_late");
    expect(body.tasks[0]!.status).toBe("completed");
  });

  // -----------------------------------------------------------------------
  // /api/file — directory traversal rejection
  // -----------------------------------------------------------------------

  it("rejects directory traversal with 403", async () => {
    const res = await call("GET", "/api/file", { path: "../../secret.txt" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = JSON.parse(res!.body) as { error: string };
    expect(body.error).toBe("FORBIDDEN");
  });

  it("rejects absolute paths with 403", async () => {
    const res = await call("GET", "/api/file", { path: "/etc/passwd" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns 404 for a non-existent file", async () => {
    const res = await call("GET", "/api/file", { path: "no-such-file.txt" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 400 for a directory path", async () => {
    fs.mkdirSync(path.join(homeDir, "adir"), { recursive: true });
    const res = await call("GET", "/api/file", { path: "adir" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it("returns file content for a valid path", async () => {
    fs.writeFileSync(path.join(homeDir, "artifact.txt"), "hello world", "utf-8");
    const res = await call("GET", "/api/file", { path: "artifact.txt" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { path: string; content: string };
    expect(body.content).toBe("hello world");
    expect(body.path).toBe("artifact.txt");
  });

  it("rejects empty path parameter", async () => {
    const res = await call("GET", "/api/file", { path: "" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // /api/tasks/{id}/output — incremental read with offset
  // -----------------------------------------------------------------------

  it("reads output incrementally respecting byte offset", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_inc.output");
    fs.writeFileSync(outputFile, "hello\nworld\n", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_inc", { outputFile }) + "\n",
      "utf-8",
    );

    // First read from offset 0.
    const first = await call("GET", "/api/tasks/task_inc/output", { offset: "0" });
    expect(first).not.toBeNull();
    expect(first!.status).toBe(200);
    const body1 = JSON.parse(first!.body) as {
      output: string;
      nextOffset: number;
      hasMore: boolean;
    };
    expect(body1.output).toBe("hello\nworld\n");
    expect(body1.hasMore).toBe(false);

    // Write more data.
    fs.appendFileSync(outputFile, "again", "utf-8");

    // Second read from previous nextOffset.
    const second = await call("GET", "/api/tasks/task_inc/output", {
      offset: String(body1.nextOffset),
    });
    expect(second).not.toBeNull();
    expect(second!.status).toBe(200);
    const body2 = JSON.parse(second!.body) as {
      output: string;
      nextOffset: number;
      hasMore: boolean;
    };
    expect(body2.output).toBe("again");
    expect(body2.hasMore).toBe(false);
  });

  it("returns 404 for a non-existent task output", async () => {
    fs.mkdirSync(path.join(homeDir, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, "tasks", "registry.jsonl"), "", "utf-8");
    const res = await call("GET", "/api/tasks/missing_task/output");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("rejects negative offset with 400", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_neg.output");
    fs.writeFileSync(outputFile, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_neg", { outputFile }) + "\n",
      "utf-8",
    );

    const res = await call("GET", "/api/tasks/task_neg/output", { offset: "-1" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Non-GET method → 405
  // -----------------------------------------------------------------------

  it("returns 405 for non-GET methods on API routes", async () => {
    const post = await call("POST", "/api/sessions");
    expect(post).not.toBeNull();
    expect(post!.status).toBe(405);

    const put = await call("PUT", "/api/tasks");
    expect(put).not.toBeNull();
    expect(put!.status).toBe(405);

    const del = await call("DELETE", "/api/summary");
    expect(del).not.toBeNull();
    expect(del!.status).toBe(405);
  });

  // -----------------------------------------------------------------------
  // Non-API path → null (server fallback)
  // -----------------------------------------------------------------------

  it("returns null for non-API paths", async () => {
    const res = await call("GET", "/not/api/route");
    expect(res).toBeNull();
  });

  // -----------------------------------------------------------------------
  // /api/summary
  // -----------------------------------------------------------------------

  it("returns summary with session and task counts", async () => {
    const sessions = [
      makeSession({
        id: "sum_s1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [
          {
            role: "worker",
            task: "t",
            timestamp: "2026-01-01T00:00:00Z",
            status: "success",
            usage: { totalTokens: 42 },
          },
        ],
      }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "registry.jsonl"), "", "utf-8");

    const res = await call("GET", "/api/summary");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      sessionCount: number;
      totalTokens: number;
      taskCounts: { total: number };
      dataHome: string;
    };
    expect(body.sessionCount).toBe(1);
    expect(body.totalTokens).toBe(42);
    expect(body.dataHome).toBe(homeDir);
  });

  // -----------------------------------------------------------------------
  // /api/stats — agent x role aggregation
  // -----------------------------------------------------------------------

  it("aggregates stats by agent and role with success rate, avg duration and tokens", async () => {
    const history = (statuses: string[], durations: number[], tokens: number[]) =>
      statuses.map((status, i) => ({
        role: "worker",
        task: `t${i}`,
        timestamp: "2026-01-01T00:00:00Z",
        status,
        ...(durations[i] !== undefined ? { evidence: { durationMs: durations[i] } } : {}),
        ...(tokens[i] !== undefined ? { usage: { totalTokens: tokens[i] } } : {}),
      }));
    const sessions = [
      makeSession({
        id: "s1",
        agent: "opencode",
        role: "worker",
        history: history(["success", "failed"], [1000, 3000], [100, 200]),
      }),
      makeSession({
        id: "s2",
        agent: "opencode",
        role: "reviewer",
        history: history(["success"], [2000], [50]),
      }),
      makeSession({
        id: "s3",
        agent: "codex",
        role: "worker",
        history: history(["success"], [], [10]),
      }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const res = await call("GET", "/api/stats");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      stats: Array<{
        agent: string;
        role: string;
        turns: number;
        successCount: number;
        successRate: number;
        avgDurationMs: number | null;
        totalTokens: number;
      }>;
    };
    expect(body.stats).toHaveLength(3);
    const byKey = new Map(body.stats.map((s) => [`${s.agent}/${s.role}`, s]));
    const ocWorker = byKey.get("opencode/worker");
    expect(ocWorker).toMatchObject({
      turns: 2,
      successCount: 1,
      successRate: 0.5,
      avgDurationMs: 2000,
      totalTokens: 300,
    });
    const ocReviewer = byKey.get("opencode/reviewer");
    expect(ocReviewer).toMatchObject({
      turns: 1,
      successRate: 1,
      avgDurationMs: 2000,
      totalTokens: 50,
    });
    // Turns without duration evidence must not count toward the average.
    const codexWorker = byKey.get("codex/worker");
    expect(codexWorker).toMatchObject({
      turns: 1,
      successRate: 1,
      avgDurationMs: null,
      totalTokens: 10,
    });
  });

  it("returns an empty stats list for an empty session store", async () => {
    fs.writeFileSync(path.join(homeDir, "sessions.json"), "[]", "utf-8");
    const res = await call("GET", "/api/stats");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { stats: unknown[] };
    expect(body.stats).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // /api/tasks/{taskId} — detail convenience endpoint
  // -----------------------------------------------------------------------

  it("returns task detail by id and 404 for unknown ids", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_detail") + "\n",
      "utf-8",
    );

    const found = await call("GET", "/api/tasks/task_detail");
    expect(found).not.toBeNull();
    expect(found!.status).toBe(200);
    const body = JSON.parse(found!.body) as { taskId: string; status: string };
    expect(body.taskId).toBe("task_detail");

    const missing = await call("GET", "/api/tasks/task_missing");
    expect(missing).not.toBeNull();
    expect(missing!.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Timeline derivation
  // -----------------------------------------------------------------------

  it('maps worker turn with finalAnswer to from:"worker" and propagates modelId', async () => {
    const session = makeSession({
      id: "timeline_worker",
      history: [
        {
          role: "worker",
          task: "implement feature",
          timestamp: "2026-01-01T00:00:30Z",
          status: "success",
          finalAnswer: "Done implementing feature",
          requestedModel: "claude-sonnet-4-20250514",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
      ],
    });
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify([session]), "utf-8");

    const res = await call("GET", "/api/sessions/timeline_worker");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      history: unknown[];
      timeline: Array<{
        from: string;
        modelId: string;
        finalAnswer: string;
        role: string;
        status: string;
        timestamp: string;
        task: string;
      }>;
    };
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0]!.from).toBe("worker");
    expect(body.timeline[0]!.modelId).toBe("claude-sonnet-4-20250514");
    expect(body.timeline[0]!.finalAnswer).toBe("Done implementing feature");
    expect(body.timeline[0]!.role).toBe("worker");
    expect(body.timeline[0]!.status).toBe("success");
    // Original history field preserved for backward compatibility.
    expect(body.history).toHaveLength(1);
  });

  it('maps pure dispatch turn (no execution output) to from:"orchestrator"', async () => {
    const session = makeSession({
      id: "timeline_orch",
      history: [
        {
          role: "worker",
          task: "implement feature X",
          timestamp: "2026-01-01T00:00:00Z",
          status: "success",
        },
      ],
    });
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify([session]), "utf-8");

    const res = await call("GET", "/api/sessions/timeline_orch");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      timeline: Array<{ from: string; task: string; modelId?: string }>;
    };
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0]!.from).toBe("orchestrator");
  });

  it("omits modelId when requestedModel is absent", async () => {
    const session = makeSession({
      id: "timeline_no_model",
      history: [
        {
          role: "worker",
          task: "run tests",
          timestamp: "2026-01-01T00:00:10Z",
          status: "success",
          summary: "all green",
        },
      ],
    });
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify([session]), "utf-8");

    const res = await call("GET", "/api/sessions/timeline_no_model");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      timeline: Array<{ from: string; modelId?: string; summary: string }>;
    };
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0]!.from).toBe("worker");
    expect(body.timeline[0]!.summary).toBe("all green");
    expect(body.timeline[0]!).not.toHaveProperty("modelId");
  });

  // -----------------------------------------------------------------------
  // /api/board — v2 three-level task tree aggregation
  // -----------------------------------------------------------------------

  function writeSessions(sessions: unknown[]) {
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");
  }

  interface BoardGroupJson {
    groupId: string;
    title: string;
    status: string;
    totalTokens: number;
    roles: Partial<
      Record<
        "worker" | "reviewer" | "tester",
        Array<{
          sessionId: string;
          title: string;
          agent: string;
          status: string;
          model?: string;
          totalTokens: number;
          instruction: string;
          usageSplit?: { input: number; output: number; reasoning: number; cached: number };
          review: {
            verdict: string;
            conclusion?: string;
            checkedAt?: string | null;
            findings?: string[];
            inferred?: boolean;
          } | null;
          terminal: { bgTaskId: string; bgStatus: string } | null;
          live?: boolean;
          inferred?: boolean;
        }>
      >
    >;
  }

  interface BoardMcpCallJson {
    index: number;
    task: string;
    status: string;
    finishedAt: string;
    durationMs?: number;
    transport?: string;
    exitCode?: number;
    model?: string;
  }

  interface BoardShallowJson {
    groups: Array<{
      roles: { worker: Array<{ sessionId: string; mcpCalls: BoardMcpCallJson[] }> };
    }>;
  }

  function groupById(body: { groups: BoardGroupJson[] }, id: string): BoardGroupJson {
    const g = body.groups.find((x) => x.groupId === id);
    if (!g)
      throw new Error(
        `group ${id} not found: ${JSON.stringify(body.groups.map((x) => x.groupId))}`,
      );
    return g;
  }

  it("groups a worker anchor, a member, and a checker into one role-bucketed group", async () => {
    const sessions = [
      makeSession({
        id: "anch_1",
        role: "worker",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
        history: [
          {
            role: "worker",
            task: "task one title\nfull instruction body",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done work",
            usage: { totalTokens: 100 },
            requestedModel: "model-a",
          },
        ],
      }),
      makeSession({
        id: "mem_1",
        role: "worker",
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:03:00.000Z",
        history: [
          {
            role: "worker",
            task: "follow-up",
            timestamp: "2026-01-01T00:02:00.000Z",
            status: "success",
            summary: "revised",
            usage: { totalTokens: 50 },
            contextSources: ["anch_1"],
          },
        ],
      }),
      makeSession({
        id: "rev_1",
        role: "reviewer",
        createdAt: "2026-01-01T00:04:00.000Z",
        updatedAt: "2026-01-01T00:04:30.000Z",
        history: [
          {
            role: "reviewer",
            task: "review",
            timestamp: "2026-01-01T00:04:30.000Z",
            status: "success",
            summary: "PASS everything",
            contextSources: ["anch_1", "mem_1"],
          },
        ],
      }),
    ];
    writeSessions(sessions);

    const res = await call("GET", "/api/board");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    expect(body.groups).toHaveLength(1);
    const g = body.groups[0]!;
    expect(g.groupId).toBe("anch_1");
    expect(g.title).toBe("task one title");
    expect(g.roles.worker!.map((w) => w.sessionId)).toEqual(["anch_1", "mem_1"]);
    expect(g.roles.reviewer!.map((c) => c.sessionId)).toEqual(["rev_1"]);
    // worker (100) + member (50)
    expect(g.totalTokens).toBe(150);
    // Both workers are PASS-reviewed by rev_1 → passed; reviewer subtask passed.
    expect(g.status).toBe("passed");
    const anchorSub = g.roles.worker![0]!;
    expect(anchorSub.model).toBe("model-a");
    expect(anchorSub.review!.verdict).toBe("PASS");
    expect(anchorSub.terminal).toBeNull();
    expect(anchorSub.live).toBe(false);
  });

  it("derives FAIL verdict from the FAIL keyword in the checker conclusion", async () => {
    const sessions = [
      makeSession({
        id: "anch_fail_kw",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task with failing review",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
      makeSession({
        id: "rev_fail_kw",
        role: "reviewer",
        history: [
          {
            role: "reviewer",
            task: "review",
            timestamp: "2026-01-01T00:04:30.000Z",
            status: "success",
            summary: "FAIL: scoreboard mapping is wrong",
            contextSources: ["anch_fail_kw"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_fail_kw");
    expect(g.roles.worker![0]!.review!.verdict).toBe("FAIL");
    expect(g.status).toBe("failed");
  });

  it("derives FAIL verdict when the checker entry status is failed", async () => {
    const sessions = [
      makeSession({
        id: "anch_fail_st",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task two",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
      makeSession({
        id: "rev_fail_st",
        role: "reviewer",
        history: [
          {
            role: "reviewer",
            task: "review",
            timestamp: "2026-01-01T00:04:30.000Z",
            status: "failed",
            summary: "no PASS/FAIL keyword here",
            contextSources: ["anch_fail_st"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_fail_st");
    expect(g.roles.worker![0]!.review!.verdict).toBe("FAIL");
    expect(g.status).toBe("failed");
  });

  it("groups a checker via a checker→checker chain (dynamic task session set)", async () => {
    const sessions = [
      makeSession({
        id: "anch_chain",
        role: "worker",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:04:30.000Z",
        history: [
          {
            role: "worker",
            task: "task chain",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done work",
          },
        ],
      }),
      makeSession({
        id: "rev_a",
        role: "reviewer",
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
        history: [
          {
            role: "reviewer",
            task: "first check",
            timestamp: "2026-01-01T00:02:00.000Z",
            status: "success",
            summary: "still needs verification",
            contextSources: ["anch_chain"],
          },
        ],
      }),
      makeSession({
        id: "rev_b",
        role: "reviewer",
        createdAt: "2026-01-01T00:03:00.000Z",
        updatedAt: "2026-01-01T00:04:30.000Z",
        history: [
          {
            role: "reviewer",
            task: "second check",
            timestamp: "2026-01-01T00:04:30.000Z",
            status: "success",
            summary: "PASS everything",
            contextSources: ["rev_a"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_chain");
    expect(g.roles.worker!.map((w) => w.sessionId)).toEqual(["anch_chain"]);
    expect(g.roles.reviewer!.map((c) => c.sessionId)).toEqual(["rev_a", "rev_b"]);
    // v2: subtask review binds only checkers that reference this subtask's
    // sessionId. rev_b references rev_a (not the anchor), so the anchor only
    // sees rev_a's UNKNOWN conclusion → the anchor stays running, and so does
    // the group under the rolling priority.
    expect(g.roles.worker![0]!.review!.verdict).toBe("UNKNOWN");
    expect(g.status).toBe("running");
  });

  it("derives UNKNOWN verdict when the checker has no PASS/FAIL signal", async () => {
    const sessions = [
      makeSession({
        id: "anch_unk",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task three",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
      makeSession({
        id: "rev_unk",
        role: "reviewer",
        history: [
          {
            role: "reviewer",
            task: "review",
            timestamp: "2026-01-01T00:04:30.000Z",
            status: "success",
            summary: "looks mostly fine, needs retest",
            contextSources: ["anch_unk"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_unk");
    expect(g.roles.worker![0]!.review!.verdict).toBe("UNKNOWN");
    // UNKNOWN verdict + output + a checker present → running per the contract.
    expect(g.roles.worker![0]!.status).toBe("running");
    expect(g.status).toBe("running");
  });

  it("derives pending_review when there is output but no checker", async () => {
    const sessions = [
      makeSession({
        id: "anch_pending",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task four",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "implementation complete",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_pending");
    expect(g.roles.worker![0]!.status).toBe("pending_review");
    expect(g.roles.worker![0]!.review === null).toBe(true);
    expect(g.status).toBe("pending_review");
  });

  it("derives running when the anchor has not produced output yet", async () => {
    const sessions = [
      makeSession({
        id: "anch_running",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task five",
            timestamp: "2026-01-01T00:00:10.000Z",
            status: "running",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_running");
    expect(g.roles.worker![0]!.status).toBe("running");
    expect(g.status).toBe("running");
  });

  it("derives failed when the anchor's last entry status is failed", async () => {
    const sessions = [
      makeSession({
        id: "anch_failed",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task six",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "failed",
            // Output evidence present so the dirty-data filter (§7.4) keeps it.
            summary: "failed with detail",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_failed");
    expect(g.roles.worker![0]!.status).toBe("failed");
    expect(g.status).toBe("failed");
  });

  it("buckets group sessions by role, omitting empty role folders", async () => {
    const sessions = [
      makeSession({
        id: "anch_roles",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task with tester",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "implementation done",
          },
        ],
      }),
      makeSession({
        id: "rev_roles",
        role: "reviewer",
        history: [
          {
            role: "reviewer",
            task: "review",
            timestamp: "2026-01-01T00:04:30.000Z",
            status: "success",
            summary: "PASS",
            contextSources: ["anch_roles"],
          },
        ],
      }),
      makeSession({
        id: "test_roles",
        role: "tester",
        history: [
          {
            role: "tester",
            task: "test run",
            timestamp: "2026-01-01T00:05:00.000Z",
            status: "success",
            summary: "all tests pass",
            contextSources: ["anch_roles", "rev_roles"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_roles");
    expect(g.roles.worker!.map((w) => w.sessionId)).toEqual(["anch_roles"]);
    expect(g.roles.reviewer!.map((r) => r.sessionId)).toEqual(["rev_roles"]);
    expect(g.roles.tester!.map((t) => t.sessionId)).toEqual(["test_roles"]);
    // A group with only the three defined roles: no extra/empty keys appear.
    expect(Object.keys(g.roles).sort()).toEqual(["reviewer", "tester", "worker"]);
  });

  it("rolls group status to the worst subtask per running > failed > pending_review > passed", async () => {
    const sessions = [
      makeSession({
        id: "anch_roll",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "roll task",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
      makeSession({
        id: "worker_pending_roll",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "rolled follow-up",
            timestamp: "2026-01-01T00:01:30.000Z",
            status: "success",
            summary: "done follow-up",
            contextSources: ["anch_roll"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_roll");
    // Neither worker has a reviewer referencing it, so both complete with
    // output → pending_review, outranking any passed state → group pending_review.
    expect(g.roles.worker!.map((w) => w.status).sort()).toEqual([
      "pending_review",
      "pending_review",
    ]);
    expect(g.status).toBe("pending_review");
  });

  it("sums per-turn usage components into subtask usageSplit", async () => {
    const sessions = [
      makeSession({
        id: "anch_usage",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "usage task",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
            usage: {
              inputTokens: 100,
              outputTokens: 40,
              reasoningOutputTokens: 10,
              cachedInputTokens: 20,
              cacheWriteInputTokens: 5,
              totalTokens: 175,
            },
          },
          {
            role: "worker",
            task: "usage task 2",
            timestamp: "2026-01-01T00:01:30.000Z",
            status: "success",
            summary: "done 2",
            usage: {
              inputTokens: 50,
              outputTokens: 30,
              reasoningOutputTokens: 15,
              cachedInputTokens: 10,
              cacheWriteInputTokens: 8,
              totalTokens: 113,
            },
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_usage");
    const sub = g.roles.worker![0]!;
    expect(sub.usageSplit).toEqual({
      input: 150,
      output: 70,
      reasoning: 25,
      // cached = cachedInput + cacheWrite summed across both turns.
      cached: 20 + 5 + 10 + 8,
    });
  });

  it("omits usageSplit when a session has no usage metering", async () => {
    const sessions = [
      makeSession({
        id: "anch_nousage",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "no usage task",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_nousage");
    expect(g.roles.worker![0]!).not.toHaveProperty("usageSplit");
  });

  it("binds one background terminal per subtask greedily by closest startedAtMs", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const registry = [
      makeRegistryLine("bg_r1", { pid: 0, startedAtMs: 1_000, outputFile: "f1" }),
      makeRegistryLine("bg_r2", { pid: 0, startedAtMs: 9_900, outputFile: "f2" }),
    ];
    fs.writeFileSync(path.join(tasksDir, "registry.jsonl"), registry.join("\n") + "\n", "utf-8");

    const sessions = [
      // updatedAt ~= 1000ms epoch → closest to bg_r1 (startedAtMs 1_000).
      makeSession({
        id: "anch_t1",
        role: "worker",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:01.000Z",
        history: [
          {
            role: "worker",
            task: "task t1",
            timestamp: "1970-01-01T00:00:01.000Z",
            status: "success",
            summary: "done t1",
          },
        ],
      }),
      // updatedAt ~= 9900ms epoch → closest to bg_r2 (startedAtMs 9_900).
      makeSession({
        id: "anch_t2",
        role: "worker",
        createdAt: "1970-01-01T00:00:02.000Z",
        updatedAt: "1970-01-01T00:00:09.900Z",
        history: [
          {
            role: "worker",
            task: "task t2",
            timestamp: "1970-01-01T00:00:09.900Z",
            status: "success",
            summary: "done t2",
          },
        ],
      }),
    ];
    // pid 0 is not alive; completed result files keep the derived status stable.
    fs.writeFileSync(
      path.join(tasksDir, "bg_r1.result.json"),
      JSON.stringify({ taskId: "bg_r1", status: "completed", completedAtMs: 2_000 }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tasksDir, "bg_r2.result.json"),
      JSON.stringify({ taskId: "bg_r2", status: "completed", completedAtMs: 10_000 }),
      "utf-8",
    );
    writeSessions(sessions);

    const res = await call("GET", "/api/board");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    expect(body.groups).toHaveLength(2);
    const g1 = groupById(body, "anch_t1");
    const g2 = groupById(body, "anch_t2");
    expect(g1.roles.worker![0]!.terminal!.bgTaskId).toBe("bg_r1");
    expect(g2.roles.worker![0]!.terminal!.bgTaskId).toBe("bg_r2");
    // Fully claimed → no live group is synthesized.
    expect(body.groups.some((g) => g.groupId === "__live__")).toBe(false);
  });

  it("sets terminal to null when no registry record matches", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "registry.jsonl"), "", "utf-8");

    const sessions = [
      makeSession({
        id: "anch_no_term",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task no terminal",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_no_term");
    expect(g.roles.worker![0]!.terminal).toBeNull();
    expect(body.groups.some((x) => x.groupId === "__live__")).toBe(false);
  });

  // v5 (ORCHESTRATION.md §10): sessions stamped with metadata.bgTaskId bind
  // their terminal by fact; the greedy time-proximity rule must never steal a
  // stamped record, and unstamped sessions keep the legacy greedy behavior.
  it("binds terminals by stamped bgTaskId over the greedy time-proximity guess", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const registry = [
      // bg_near is temporally closest to the stamped session, but belongs to
      // the unstamped session by stamp; the two-pass pass must not steal it.
      makeRegistryLine("bg_near", { pid: 0, startedAtMs: 1_000, outputFile: "f_near" }),
      makeRegistryLine("bg_far", { pid: 0, startedAtMs: 900_000, outputFile: "f_far" }),
    ];
    fs.writeFileSync(path.join(tasksDir, "registry.jsonl"), registry.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "bg_near.result.json"),
      JSON.stringify({ taskId: "bg_near", status: "completed", completedAtMs: 2_000 }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tasksDir, "bg_far.result.json"),
      JSON.stringify({ taskId: "bg_far", status: "completed", completedAtMs: 910_000 }),
      "utf-8",
    );

    const sessions = [
      // Stamped session: updatedAt far from bg_far, yet bg_far is a fact.
      makeSession({
        id: "anch_stamped",
        role: "worker",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:01.000Z",
        metadata: { bgTaskId: "bg_far" },
        history: [
          {
            role: "worker",
            task: "stamped task",
            timestamp: "1970-01-01T00:00:01.000Z",
            status: "success",
            summary: "done stamped",
          },
        ],
      }),
      // Unstamped session temporally closest to bg_far: greedy would steal it
      // in a single pass, so the two-pass order is what this asserts against.
      makeSession({
        id: "anch_legacy",
        role: "worker",
        createdAt: "1970-01-01T00:15:00.000Z",
        updatedAt: "1970-01-01T00:15:00.000Z",
        history: [
          {
            role: "worker",
            task: "legacy task",
            timestamp: "1970-01-01T00:15:00.000Z",
            status: "success",
            summary: "done legacy",
          },
        ],
      }),
    ];
    writeSessions(sessions);

    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const stamped = groupById(body, "anch_stamped");
    const legacy = groupById(body, "anch_legacy");
    // Fact wins over the guess, regardless of temporal distance.
    expect(stamped.roles.worker![0]!.terminal!.bgTaskId).toBe("bg_far");
    // Legacy session falls back to the remaining record via greedy.
    expect(legacy.roles.worker![0]!.terminal!.bgTaskId).toBe("bg_near");
  });

  it("falls back to greedy binding when a stamped record is missing from the registry", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("bg_real", { pid: 0, startedAtMs: 5_000, outputFile: "f_real" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tasksDir, "bg_real.result.json"),
      JSON.stringify({ taskId: "bg_real", status: "completed", completedAtMs: 6_000 }),
      "utf-8",
    );

    const sessions = [
      makeSession({
        id: "anch_stale_stamp",
        role: "worker",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:05.000Z",
        metadata: { bgTaskId: "bg_gone" },
        history: [
          {
            role: "worker",
            task: "stale stamp task",
            timestamp: "1970-01-01T00:00:05.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
    ];
    writeSessions(sessions);

    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_stale_stamp");
    expect(g.roles.worker![0]!.terminal!.bgTaskId).toBe("bg_real");
  });

  // v6 inferred checker attribution: reviewers without contextSources join the
  // group sharing an explicit round marker and cwd, always flagged `inferred`.
  it("attributes marker-matching reviewers without contextSources as inferred", async () => {
    const sessions = [
      makeSession({
        id: "anch_v4",
        role: "worker",
        cwd: "/tmp/proj",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
        history: [
          {
            role: "worker",
            task: "v4 迭代：修复面板 Token 消耗卡",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
      makeSession({
        id: "rev_v4",
        role: "reviewer",
        cwd: "/tmp/proj",
        createdAt: "2026-01-01T00:09:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
        history: [
          {
            role: "reviewer",
            task: "复审 v4 迭代：验证 6 个发现已修复到位且无回归",
            timestamp: "2026-01-01T00:10:00.000Z",
            status: "failed",
            summary: "FAIL：回归未修复",
            findings: [{ issue: "Token 分项列表全 0 时渲染空" }],
          },
        ],
      }),
      makeSession({
        id: "rev_v4_r2",
        role: "reviewer",
        cwd: "/tmp/proj",
        createdAt: "2026-01-01T00:20:00.000Z",
        updatedAt: "2026-01-01T00:21:00.000Z",
        history: [
          {
            role: "reviewer",
            task: "复审 v4 迭代（第 2 轮）：逐条验证修复到位且无回归",
            timestamp: "2026-01-01T00:21:00.000Z",
            status: "success",
            summary: "PASS：6 个发现全部修复",
          },
        ],
      }),
    ];
    writeSessions(sessions);

    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_v4");
    expect(g.roles.reviewer).toHaveLength(2);
    expect(g.roles.reviewer![0]!.sessionId).toBe("rev_v4");
    expect(g.roles.reviewer![0]!.inferred).toBe(true);
    // Checker subtasks describe themselves: own latest turn fills the review.
    expect(g.roles.reviewer![0]!.review!.verdict).toBe("FAIL");
    expect(g.roles.reviewer![0]!.review!.findings).toContain("Token 分项列表全 0 时渲染空");
    // Worker binding takes the LATEST inferred verdict (final, not first).
    const worker = g.roles.worker![0]!;
    expect(worker.review!.verdict).toBe("PASS");
    expect(worker.review!.inferred).toBe(true);
    expect(worker.review!.conclusion).toContain("6 个发现全部修复");
    expect(worker.status).toBe("passed");
  });

  it("does not attribute checkers lacking a round marker or cwd match", async () => {
    const sessions = [
      makeSession({
        id: "anch_nomark",
        role: "worker",
        cwd: "/tmp/proj",
        history: [
          {
            role: "worker",
            task: "修复登录页换行溢出",
            timestamp: "2026-01-01T00:00:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
      makeSession({
        id: "rev_nomark",
        role: "reviewer",
        cwd: "/tmp/proj",
        createdAt: "2026-01-01T00:09:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
        history: [
          {
            role: "reviewer",
            task: "审查工作区未提交变更（git diff 可见，涉及 4 个文件）",
            timestamp: "2026-01-01T00:10:00.000Z",
            status: "success",
            summary: "PASS",
          },
        ],
      }),
      makeSession({
        id: "rev_wrongcwd",
        role: "reviewer",
        cwd: "/tmp/elsewhere",
        createdAt: "2026-01-01T00:09:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
        history: [
          {
            role: "reviewer",
            task: "复审 v4 迭代：另一仓库的评审不归这个任务",
            timestamp: "2026-01-01T00:10:00.000Z",
            status: "success",
            summary: "PASS",
          },
        ],
      }),
    ];
    writeSessions(sessions);

    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_nomark");
    expect(g.roles.reviewer).toBeUndefined();
  });

  it("renders a live synthetic group for unclaimed running background tasks", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "live_task.output");
    fs.writeFileSync(outputFile, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("live_task", { pid: process.pid, startedAtMs: 5_000_000, outputFile }) +
        "\n",
      "utf-8",
    );

    // No sessions yet: the running background task is unclaimed → live group.
    writeSessions([]);
    const first = await call("GET", "/api/board");
    const firstBody = JSON.parse(first!.body) as { groups: BoardGroupJson[] };
    expect(firstBody.groups[0]!.groupId).toBe("__live__");
    expect(firstBody.groups[0]!.title).toBe("实时任务");
    const live = firstBody.groups[0]!.roles.worker![0]!;
    expect(live.sessionId).toBe("live_task");
    expect(live.title).toBe("后台任务 live_task");
    expect(live.agent).toBe("-");
    expect(live.totalTokens).toBe(0);
    expect(live.live).toBe(true);
    expect(live.instruction).toBe("（执行中，指令将在完成后可见）");
    expect(live.terminal!.bgTaskId).toBe("live_task");
    expect(live.terminal!.bgStatus).toBe("running");

    // Once a session lands whose updatedAt sits closest to the live task, the
    // greedy binding claims it → the live group disappears.
    writeSessions([
      makeSession({
        id: "anch_live",
        role: "worker",
        createdAt: "1970-01-01T00:00:05.000Z",
        updatedAt: "1970-01-01T00:00:05.000Z",
        history: [
          {
            role: "worker",
            task: "claims the live task",
            timestamp: "1970-01-01T00:00:05.000Z",
            status: "running",
          },
        ],
      }),
    ]);
    const second = await call("GET", "/api/board");
    const secondBody = JSON.parse(second!.body) as { groups: BoardGroupJson[] };
    expect(secondBody.groups.some((g) => g.groupId === "__live__")).toBe(false);
    expect(secondBody.groups.some((g) => g.groupId === "anch_live")).toBe(true);
    const claimed = groupById(secondBody, "anch_live");
    expect(claimed.roles.worker![0]!.terminal!.bgTaskId).toBe("live_task");
  });

  it("marks an interrupted live subtask as failed carrying interrupted terminal data", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "live_int.output");
    fs.writeFileSync(outputFile, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("live_int", {
        pid: process.pid,
        orphanedAtMs: 2_000_000,
        outputFile,
      }) + "\n",
      "utf-8",
    );

    // No sessions: the orphaned background task becomes an interrupted live subtask.
    writeSessions([]);
    const res = await call("GET", "/api/board");
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    expect(body.groups).toHaveLength(1);
    const live = body.groups[0]!;
    expect(live.groupId).toBe("__live__");
    // The interrupted-only live group rolls to failed.
    expect(live.status).toBe("failed");
    const sub = live.roles.worker![0]!;
    expect(sub.sessionId).toBe("live_int");
    expect(sub.live).toBe(true);
    // Four-state enum keeps "failed", while terminal.bgStatus distinguishes the interruption.
    expect(sub.status).toBe("failed");
    expect(sub.terminal!.bgTaskId).toBe("live_int");
    expect(sub.terminal!.bgStatus).toBe("interrupted");
  });

  it("rolls __live__ group status from its live subtasks, running outranking failed", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outRun = path.join(tasksDir, "run.output");
    const outInt = path.join(tasksDir, "int.output");
    fs.writeFileSync(outRun, "", "utf-8");
    fs.writeFileSync(outInt, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      [
        makeRegistryLine("task_run", {
          pid: process.pid,
          startedAtMs: 1_000_000,
          outputFile: outRun,
        }),
        makeRegistryLine("task_int", {
          pid: process.pid,
          startedAtMs: 2_000_000,
          orphanedAtMs: 2_500_000,
          outputFile: outInt,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    writeSessions([]);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const live = body.groups[0]!;
    expect(live.groupId).toBe("__live__");
    // Mixed live tasks: the still-running one outranks the interrupted one.
    expect(live.status).toBe("running");
  });

  it("never binds a background terminal to a reviewer subtask even when its updatedAt is closer", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "bg_rev.output");
    fs.writeFileSync(outputFile, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("bg_rev", { pid: process.pid, startedAtMs: 5_000_000, outputFile }) + "\n",
      "utf-8",
    );

    // worker updatedAt delta ~10,000ms; reviewer delta ~100ms (much closer to the task).
    const sessions = [
      makeSession({
        id: "anch_rv_w",
        role: "worker",
        createdAt: "1970-01-01T00:00:05.000Z",
        updatedAt: "1970-01-01T00:00:05.010Z",
        history: [
          {
            role: "worker",
            task: "worker task",
            timestamp: "1970-01-01T00:00:05.010Z",
            status: "running",
          },
        ],
      }),
      makeSession({
        id: "rev_rv",
        role: "reviewer",
        createdAt: "1970-01-01T00:00:05.000Z",
        updatedAt: "1970-01-01T00:00:05.000100Z",
        history: [
          {
            role: "reviewer",
            task: "review worker task",
            timestamp: "1970-01-01T00:00:05.000100Z",
            status: "running",
            contextSources: ["anch_rv_w"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_rv_w");
    // The greedy binding is limited to worker-owned subtasks.
    expect(g.roles.worker![0]!.terminal!.bgTaskId).toBe("bg_rev");
    // The reviewer subtask is never bound and always reports a null terminal.
    expect(g.roles.reviewer![0]!.terminal).toBeNull();
    // The background task is claimed exactly once by the worker → no live group.
    expect(body.groups.some((x) => x.groupId === "__live__")).toBe(false);
  });

  it("binds review at the subtask level via the reviewer's contextSources", async () => {
    const sessions = [
      makeSession({
        id: "anch_rev_a",
        role: "worker",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
        history: [
          {
            role: "worker",
            task: "task a",
            timestamp: "2026-01-01T00:02:00.000Z",
            status: "success",
            summary: "done a",
          },
        ],
      }),
      makeSession({
        id: "rev_target",
        role: "reviewer",
        createdAt: "2026-01-01T00:03:00.000Z",
        updatedAt: "2026-01-01T00:04:00.000Z",
        history: [
          {
            role: "reviewer",
            task: "review a only",
            timestamp: "2026-01-01T00:04:00.000Z",
            status: "success",
            summary: "PASS only a",
            contextSources: ["anch_rev_a"],
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_rev_a");
    // The single worker subtask is the bound review target.
    expect(g.roles.worker).toHaveLength(1);
    expect(g.roles.worker![0]!.review!.verdict).toBe("PASS");
    expect(g.roles.worker![0]!.review!.conclusion).toBe("PASS only a");
    // The reviewer itself is grouped as a reviewer subtask that describes its
    // own conclusion (v6: the 检查结论 card fills from the checker's own turn).
    expect(g.roles.reviewer![0]!.review!.verdict).toBe("PASS");
    expect(g.roles.reviewer![0]!.review!.conclusion).toBe("PASS only a");
    expect(g.roles.reviewer![0]!.review!.inferred).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // /api/board — dataSource inspection (v3 §7.1)
  // -----------------------------------------------------------------------

  it("returns a healthy dataSource with empty warnings", async () => {
    writeSessions([makeSession({ id: "ds_ok", role: "worker", history: [] })]);
    const res = await call("GET", "/api/board");
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      dataSource: { homeDir: string; sessionsFile: string; warnings: string[] };
    };
    expect(body.dataSource.homeDir).toBe(homeDir);
    expect(body.dataSource.sessionsFile).toBe(path.join(homeDir, "sessions.json"));
    expect(body.dataSource.warnings).toEqual([]);
  });

  it("reports a warning when the sessions directory does not exist", async () => {
    // Remove the homeDir entirely so the directory existence check fires.
    fs.rmSync(homeDir, { recursive: true, force: true });
    const res = await call("GET", "/api/board");
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      groups: unknown[];
      dataSource: { warnings: string[] };
    };
    expect(body.dataSource.warnings).toContain("任务目录不存在");
    // The board degrades to an empty group list rather than failing.
    expect(body.groups).toEqual([]);
  });

  it("reports a warning when sessions.json contains invalid JSON", async () => {
    fs.writeFileSync(path.join(homeDir, "sessions.json"), "{not valid json", "utf-8");
    const res = await call("GET", "/api/board");
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { dataSource: { warnings: string[] } };
    expect(body.dataSource.warnings).toContain("sessions.json 文件损坏，JSON 解析失败");

    // A healthy file clears the warning.
    writeSessions([makeSession({ id: "ds_after", role: "worker", history: [] })]);
    const again = await call("GET", "/api/board");
    expect(again!.status).toBe(200);
    const body2 = JSON.parse(again!.body) as { dataSource: { warnings: string[] } };
    expect(body2.dataSource.warnings).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // /api/board — mcpCalls mapping (v3 §7.2)
  // -----------------------------------------------------------------------

  it("maps multi-round history into mcpCalls extracting duration/transport/exitCode/model", async () => {
    const sessions = [
      makeSession({
        id: "anch_mcp",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "call one prompt",
            timestamp: "2026-01-01T00:00:00.000Z",
            status: "success",
            summary: "done one",
            requestedModel: "model-a",
            evidence: { transportUsed: "mcp", durationMs: 1500, exitCode: 0 },
            usage: { totalTokens: 100 },
          },
          {
            role: "worker",
            task: "call two prompt",
            timestamp: "2026-01-01T00:00:05.000Z",
            status: "success",
            summary: "done two",
            requestedModel: "model-b",
            usage: { totalTokens: 60 },
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as BoardShallowJson;
    const sub = body.groups[0]!.roles.worker[0]!;
    expect(sub.sessionId).toBe("anch_mcp");
    expect(sub.mcpCalls).toHaveLength(2);
    // First call: explicit evidence numbers win.
    expect(sub.mcpCalls[0]).toMatchObject({
      index: 0,
      task: "call one prompt",
      status: "success",
      durationMs: 1500,
      transport: "mcp",
      exitCode: 0,
      model: "model-a",
    });
    // Second call: duration falls back to adjacency delta (5s), no transport.
    expect(sub.mcpCalls[1]).toMatchObject({
      index: 1,
      task: "call two prompt",
      status: "success",
      durationMs: 5000,
      model: "model-b",
    });
    expect(sub.mcpCalls[1]).not.toHaveProperty("transport");
  });

  it("omits optional mcpCall fields when the surrounding evidence is absent", async () => {
    const sessions = [
      makeSession({
        id: "anch_mcp_min",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "bare dispatch",
            timestamp: "2026-01-01T00:00:00.000Z",
            status: "success",
            summary: "out",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as BoardShallowJson;
    const sub = body.groups[0]!.roles.worker[0]!;
    expect(sub.mcpCalls).toHaveLength(1);
    expect(sub.mcpCalls[0]).toMatchObject({ index: 0, task: "bare dispatch", status: "success" });
    expect(sub.mcpCalls[0]).not.toHaveProperty("durationMs");
    expect(sub.mcpCalls[0]).not.toHaveProperty("transport");
    expect(sub.mcpCalls[0]).not.toHaveProperty("exitCode");
    expect(sub.mcpCalls[0]).not.toHaveProperty("model");
  });

  // -----------------------------------------------------------------------
  // /api/board — dirty data filtering (v3 §7.4)
  // -----------------------------------------------------------------------

  it("filters a worker session whose history is empty", async () => {
    const sessions = [
      makeSession({ id: "anch_empty", role: "worker", history: [] }),
      makeSession({
        id: "anch_real",
        role: "worker",
        createdAt: "2026-01-01T00:01:00.000Z",
        history: [
          {
            role: "worker",
            task: "real task",
            timestamp: "2026-01-01T00:01:30.000Z",
            status: "success",
            summary: "done",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    expect(body.groups.some((g) => g.groupId === "anch_empty")).toBe(false);
    expect(groupById(body, "anch_real")).toBeDefined();
  });

  it("filters a worker session whose entries carry no task/evidence at all", async () => {
    const sessions = [
      makeSession({
        id: "anch_bare",
        role: "worker",
        history: [
          { role: "worker", task: "", timestamp: "2026-01-01T00:00:00.000Z", status: "success" },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    expect(body.groups).toHaveLength(0);
  });

  it("filters a failed session with no output evidence", async () => {
    const sessions = [
      makeSession({
        id: "anch_fail_nodata",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "task that only failed",
            timestamp: "2026-01-01T00:00:00.000Z",
            status: "failed",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    expect(body.groups).toHaveLength(0);
  });

  it("keeps a failed session that still carries output evidence", async () => {
    const sessions = [
      makeSession({
        id: "anch_fail_keep",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "t",
            timestamp: "2026-01-01T00:00:00.000Z",
            status: "failed",
            summary: "failure log",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_fail_keep");
    expect(g.roles.worker![0]!.status).toBe("failed");
  });

  it("keeps a failed session whose output evidence is only in a non-last entry", async () => {
    const sessions = [
      makeSession({
        id: "anch_fail_early_evidence",
        role: "worker",
        history: [
          {
            role: "worker",
            task: "t",
            timestamp: "2026-01-01T00:00:00.000Z",
            status: "success",
            summary: "produced output earlier, before the failure",
          },
          {
            role: "worker",
            task: "t",
            timestamp: "2026-01-01T00:01:00.000Z",
            status: "failed",
          },
        ],
      }),
    ];
    writeSessions(sessions);
    const res = await call("GET", "/api/board");
    const body = JSON.parse(res!.body) as { groups: BoardGroupJson[] };
    const g = groupById(body, "anch_fail_early_evidence");
    expect(g.roles.worker![0]!.status).toBe("failed");
  });
});
