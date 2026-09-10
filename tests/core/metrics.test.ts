import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateTaskMetrics,
  appendTaskMetrics,
  computeLeaderShare,
  readTaskMetrics,
  resolveMetricsFilePath,
  sumDispatchedTokens,
} from "../../src/core/metrics.js";
import type { MetricsGroupStats, TaskMetrics } from "../../src/core/metrics.js";

describe("core/metrics recorder", () => {
  const createdDirectories: string[] = [];

  function createTempHome(): string {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-metrics-")));
    createdDirectories.push(home);
    return home;
  }

  afterEach(() => {
    for (const directory of createdDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  const baseRecord: TaskMetrics = {
    taskId: "bgtask_1",
    sessionId: "bridge-sess_1",
    role: "worker",
    agent: "codex",
    model: "gpt-5-codex",
    tokensIn: 120,
    tokensOut: 45,
    durationMs: 1500,
    retries: 0,
    stallEvents: 0,
    cancelEvents: 0,
    outcome: "ok",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: "2026-09-01T10:00:01.500Z",
  };

  it("resolves the metrics file inside the given home directory", () => {
    expect(resolveMetricsFilePath("/tmp/agentmesh-home")).toBe(
      path.join("/tmp/agentmesh-home", "metrics.jsonl"),
    );
  });

  it("round-trips appended records through the JSONL store in order", () => {
    const home = createTempHome();
    expect(appendTaskMetrics(baseRecord, { homeDir: home })).toBe(true);
    expect(
      appendTaskMetrics({ ...baseRecord, taskId: undefined, outcome: "error" }, { homeDir: home }),
    ).toBe(true);

    const raw = fs.readFileSync(resolveMetricsFilePath(home), "utf-8");
    expect(raw.split("\n")).toHaveLength(3); // two records + trailing newline

    const records = readTaskMetrics({ homeDir: home });
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(baseRecord);
    expect(records[1]).toMatchObject({ outcome: "error" });
    expect(records[1]?.taskId).toBeUndefined();
  });

  it("treats a missing metrics file as an empty store", () => {
    const home = createTempHome();
    expect(readTaskMetrics({ homeDir: home })).toEqual([]);
  });

  it("skips corrupt lines fail-closed and warns on stderr", () => {
    const home = createTempHome();
    const filePath = resolveMetricsFilePath(home);
    fs.mkdirSync(home, { recursive: true });
    const valid = { ...baseRecord, taskId: undefined };
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(valid),
        "{broken json",
        JSON.stringify({ ...baseRecord, outcome: "explosion" }),
        JSON.stringify({ ...baseRecord, role: "boss" }),
        JSON.stringify({ ...baseRecord, endedAt: "not-a-date" }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const records = readTaskMetrics({ homeDir: home });
    expect(records).toEqual([valid]);
    expect(stderrSpy).toHaveBeenCalledTimes(4);
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warnings).toContain("corrupt line");
    expect(warnings).toContain(filePath);
  });

  it("reports append failures as false with a stderr warning instead of throwing", () => {
    const home = createTempHome();
    // A regular file where the home directory should be makes mkdir/append fail.
    const blocker = path.join(home, "blocker");
    fs.writeFileSync(blocker, "not a directory", "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(appendTaskMetrics(baseRecord, { homeDir: blocker })).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("could not be appended");
  });
});

describe("core/metrics aggregation", () => {
  const baseRecord: TaskMetrics = {
    role: "worker",
    agent: "codex",
    model: "gpt-5-codex",
    tokensIn: 100,
    tokensOut: 50,
    durationMs: 1000,
    retries: 0,
    stallEvents: 0,
    cancelEvents: 0,
    outcome: "ok",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: "2026-09-01T10:00:01.000Z",
  };

  function groupOf(groups: MetricsGroupStats[], key: string): MetricsGroupStats {
    const group = groups.find((candidate) => candidate.key === key);
    expect(group).toBeDefined();
    return group!;
  }

  it("computes nearest-rank p50/p95 over dispatch durations", () => {
    const records = [10, 20, 30, 40, 50].map((durationMs, index) => ({
      ...baseRecord,
      model: `m${index}`,
      durationMs,
    }));
    const aggregate = aggregateTaskMetrics(records);
    expect(aggregate.taskCount).toBe(5);
    const byModel = aggregate.byModel.map((group) => group.p50DurationMs);
    expect(byModel).toEqual([10, 20, 30, 40, 50]);

    const sameModel = [10, 20, 30, 40, 50].map((durationMs) => ({
      ...baseRecord,
      durationMs,
    }));
    const single = aggregateTaskMetrics(sameModel);
    expect(groupOf(single.byModel, "gpt-5-codex").p50DurationMs).toBe(30);
    expect(groupOf(single.byModel, "gpt-5-codex").p95DurationMs).toBe(50);

    const even = aggregateTaskMetrics(
      [10, 20, 30, 40].map((durationMs) => ({ ...baseRecord, durationMs })),
    );
    expect(groupOf(even.byModel, "gpt-5-codex").p50DurationMs).toBe(20);
    expect(groupOf(even.byModel, "gpt-5-codex").p95DurationMs).toBe(40);
  });

  it("groups token totals and outcome breakdown by model and by role", () => {
    const aggregate = aggregateTaskMetrics([
      { ...baseRecord, model: "m1", role: "worker", tokensIn: 10, tokensOut: 1, outcome: "ok" },
      { ...baseRecord, model: "m1", role: "worker", tokensIn: 20, tokensOut: 2, outcome: "ok" },
      {
        ...baseRecord,
        model: "m2",
        role: "reviewer",
        tokensIn: 40,
        tokensOut: 4,
        outcome: "error",
      },
      {
        ...baseRecord,
        model: "m2",
        role: "tester",
        tokensIn: 80,
        tokensOut: 8,
        outcome: "timeout",
      },
    ]);

    const m1 = groupOf(aggregate.byModel, "m1");
    const m2 = groupOf(aggregate.byModel, "m2");
    expect(aggregate.taskCount).toBe(4);
    expect(m1.taskCount).toBe(2);
    expect(m1.tokensIn).toBe(30);
    expect(m1.tokensOut).toBe(3);
    expect(m1.outcomes).toEqual({ ok: 2, error: 0, stalled: 0, cancelled: 0, timeout: 0 });
    expect(m2.taskCount).toBe(2);
    expect(m2.tokensIn).toBe(120);
    expect(m2.outcomes).toEqual({ ok: 0, error: 1, stalled: 0, cancelled: 0, timeout: 1 });

    expect(groupOf(aggregate.byRole, "worker").taskCount).toBe(2);
    expect(groupOf(aggregate.byRole, "reviewer").taskCount).toBe(1);
    expect(groupOf(aggregate.byRole, "tester").taskCount).toBe(1);
  });

  it("groups records with unknown model or role under 'unknown'", () => {
    const aggregate = aggregateTaskMetrics([{ ...baseRecord, model: undefined, role: undefined }]);
    expect(groupOf(aggregate.byModel, "unknown").taskCount).toBe(1);
    expect(groupOf(aggregate.byRole, "unknown").taskCount).toBe(1);
  });

  it("computes retry rate and cancel counts per group", () => {
    const aggregate = aggregateTaskMetrics([
      { ...baseRecord, model: "m1", retries: 1 },
      { ...baseRecord, model: "m1", retries: 0 },
      { ...baseRecord, model: "m1", retries: 2, outcome: "cancelled", cancelEvents: 1 },
      { ...baseRecord, model: "m2", retries: 0 },
    ]);
    const m1 = groupOf(aggregate.byModel, "m1");
    expect(m1.taskCount).toBe(3);
    expect(m1.retryRate).toBeCloseTo(2 / 3);
    expect(m1.cancelCount).toBe(1);
    expect(groupOf(aggregate.byModel, "m2").retryRate).toBe(0);
  });

  it("attributes watchdog stall lines to dispatch records via taskId", () => {
    const nowMs = Date.parse("2026-09-01T12:00:00.000Z");
    const aggregate = aggregateTaskMetrics(
      [
        { ...baseRecord, model: "m1", taskId: "bgtask_a", outcome: "error" },
        { ...baseRecord, model: "m1", taskId: "bgtask_b" },
        { ...baseRecord, model: "m2", taskId: "bgtask_c" },
        {
          taskId: "bgtask_a",
          outcome: "stalled",
          stallEvents: 1,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: 0,
          retries: 0,
          cancelEvents: 0,
          startedAt: new Date(nowMs - 60_000).toISOString(),
          endedAt: new Date(nowMs).toISOString(),
        },
        {
          taskId: "bgtask_c",
          outcome: "stalled",
          stallEvents: 1,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: 0,
          retries: 0,
          cancelEvents: 0,
          startedAt: new Date(nowMs - 60_000).toISOString(),
          endedAt: new Date(nowMs).toISOString(),
        },
      ],
      { nowMs },
    );
    expect(aggregate.taskCount).toBe(3);
    expect(groupOf(aggregate.byModel, "m1").stallRate).toBeCloseTo(1 / 2);
    expect(groupOf(aggregate.byModel, "m2").stallRate).toBe(1);
    expect(aggregate.unattributedStallEvents).toBe(0);
  });

  it("reports stall events whose dispatch record is missing as unattributed", () => {
    const nowMs = Date.parse("2026-09-01T12:00:00.000Z");
    const aggregate = aggregateTaskMetrics(
      [
        {
          taskId: "bgtask_lost",
          outcome: "stalled",
          stallEvents: 1,
          tokensIn: 0,
          tokensOut: 0,
          durationMs: 0,
          retries: 0,
          cancelEvents: 0,
          startedAt: new Date(nowMs - 60_000).toISOString(),
          endedAt: new Date(nowMs).toISOString(),
        },
        { ...baseRecord, taskId: "bgtask_a" },
      ],
      { nowMs },
    );
    expect(aggregate.taskCount).toBe(1);
    expect(groupOf(aggregate.byModel, "gpt-5-codex").stallRate).toBe(0);
    expect(aggregate.unattributedStallEvents).toBe(1);
  });

  it("filters records by the requested time window", () => {
    const nowMs = Date.parse("2026-09-01T12:00:00.000Z");
    const fresh = {
      ...baseRecord,
      model: "fresh",
      endedAt: new Date(nowMs - 3600_000).toISOString(),
    };
    const stale = {
      ...baseRecord,
      model: "stale",
      endedAt: new Date(nowMs - 25 * 3600_000).toISOString(),
    };
    const old = {
      ...baseRecord,
      model: "old",
      endedAt: new Date(nowMs - 8 * 24 * 3600_000).toISOString(),
    };

    expect(
      aggregateTaskMetrics([fresh, stale, old], { window: "24h", nowMs }).byModel,
    ).toHaveLength(1);
    const week = aggregateTaskMetrics([fresh, stale, old], { window: "7d", nowMs });
    expect(week.byModel.map((group) => group.key)).toEqual(["fresh", "stale"]);
    const all = aggregateTaskMetrics([fresh, stale, old], { window: "all", nowMs });
    expect(all.taskCount).toBe(3);
  });

  it("aggregates dispatches by v0.5 triage lane, grouping unlabeled records under unknown", () => {
    const fast = { ...baseRecord, lane: "fast" as const, taskId: "t-fast" };
    const full = { ...baseRecord, lane: "full" as const, taskId: "t-full" };
    const unlabeled = { ...baseRecord, taskId: "t-unknown" };

    const aggregate = aggregateTaskMetrics([fast, full, unlabeled]);
    const keys = aggregate.byLane.map((group) => group.key).sort();
    expect(keys).toEqual(["fast", "full", "unknown"]);
  });

  it("drops unknown lane values at parse time instead of guessing", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-metrics-lane-")));
    try {
      appendTaskMetrics(baseRecord, { homeDir: home });
      const filePath = resolveMetricsFilePath(home);
      fs.appendFileSync(
        filePath,
        `${JSON.stringify({ ...baseRecord, taskId: "t-bogus", lane: "express" })}\n`,
        "utf-8",
      );
      const records = readTaskMetrics({ homeDir: home });
      expect(records).toHaveLength(1);
      expect(records[0]!.lane).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("core/metrics leaderShare (v0.5 P-080④)", () => {
  const baseRecord: TaskMetrics = {
    role: "worker",
    agent: "codex",
    tokensIn: 100,
    tokensOut: 50,
    durationMs: 10,
    retries: 0,
    stallEvents: 0,
    cancelEvents: 0,
    outcome: "ok",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: "2026-09-01T10:00:00.010Z",
  };

  it("sums dispatch tokens excluding stall events", () => {
    expect(sumDispatchedTokens([baseRecord, { ...baseRecord, outcome: "stalled" }])).toBe(150);
  });

  it("derives the share and warns above the 25% threshold", () => {
    const within = computeLeaderShare({ leaderTokens: 50, dispatchedTokens: 150 });
    expect(within.share).toBeCloseTo(0.25);
    expect(within.warning).toBeUndefined();

    const exceeding = computeLeaderShare({ leaderTokens: 75, dispatchedTokens: 25 });
    expect(exceeding.share).toBeCloseTo(0.75);
    expect(exceeding.warning).toContain("LEADER_SHARE_EXCEEDED");
  });

  it("never fabricates a share without a positive denominator", () => {
    const report = computeLeaderShare({ dispatchedTokens: 0 });
    expect(report.share).toBeUndefined();
    expect(report.warning).toBeUndefined();
  });
});
