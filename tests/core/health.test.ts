import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_DURATION_SAMPLES,
  ModelHealthStore,
  appendStallEvent,
  foldModelHealth,
  healthEventWeight,
  orderCandidatesByHealth,
  readHealthLines,
  resolveAgentHealthCandidate,
  resolveHealthFilePath,
} from "../../src/core/health.js";
import type { HealthWeightedCandidate } from "../../src/core/health.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BackgroundTaskRegistry } from "../../src/core/background.js";
import { BaseAdapter } from "../../src/agents/base.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import type { ModelHealthEntry } from "../../src/core/health.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "../../src/agents/types.js";

describe("core/health store", () => {
  const createdDirectories: string[] = [];

  function createTempHome(): string {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-health-")));
    createdDirectories.push(home);
    return home;
  }

  afterEach(() => {
    for (const directory of createdDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("resolves the health file inside the given home directory", () => {
    expect(resolveHealthFilePath("/tmp/agentmesh-home")).toBe(
      path.join("/tmp/agentmesh-home", "health.jsonl"),
    );
  });

  it("round-trips success and failure records through the JSONL store", () => {
    const home = createTempHome();
    const store = new ModelHealthStore({ homeDir: home });
    expect(store.recordSuccess({ agent: "codex", model: "m1", durationMs: 120, atMs: 1000 })).toBe(
      true,
    );
    expect(
      store.recordFailure("error", { agent: "codex", model: "m1", durationMs: 80, atMs: 2000 }),
    ).toBe(true);
    expect(store.recordFailure("stall", { agent: "codex", model: "m2", atMs: 3000 })).toBe(true);

    const raw = fs.readFileSync(resolveHealthFilePath(home), "utf-8");
    expect(raw.split("\n")).toHaveLength(4); // three records + trailing newline

    const snapshot = store.snapshot(3000);
    expect(snapshot.entries).toHaveLength(2);
    const m1 = snapshot.entries.find((entry) => entry.model === "m1");
    expect(m1).toMatchObject({
      agent: "codex",
      model: "m1",
      successCount: 1,
      errorCount: 1,
      stallCount: 0,
      p50DurationMs: 80,
      p95DurationMs: 120,
      consecutiveFailures: 1,
      lastFailureAt: new Date(2000).toISOString(),
      quarantined: false,
    });
    const m2 = snapshot.entries.find((entry) => entry.model === "m2");
    expect(m2).toMatchObject({ stallCount: 1, errorCount: 0, consecutiveFailures: 1 });
  });

  it("treats a missing health file as an empty store", () => {
    const home = createTempHome();
    const snapshot = new ModelHealthStore({ homeDir: home }).snapshot(1000);
    expect(snapshot.entries).toEqual([]);
    expect(readHealthLines({ homeDir: home })).toEqual([]);
  });

  it("skips corrupt lines fail-closed and warns on stderr", () => {
    const home = createTempHome();
    const filePath = resolveHealthFilePath(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "success", agent: "codex", model: "m1", atMs: 1000 }),
        "{broken json",
        JSON.stringify({ type: "explosion", atMs: 1000 }),
        "[]",
        JSON.stringify({
          type: "failure",
          kind: "explosion",
          agent: "codex",
          model: "m1",
          atMs: 2000,
        }),
        JSON.stringify({ type: "success", agent: "", model: "m1", atMs: 2000 }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const snapshot = new ModelHealthStore({ homeDir: home }).snapshot(2000);
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ agent: "codex", model: "m1", successCount: 1 }),
    ]);
    expect(stderrSpy).toHaveBeenCalledTimes(5);
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
    const store = new ModelHealthStore({ homeDir: blocker });
    expect(store.recordSuccess({ agent: "codex", model: "m1" })).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("could not be appended");
  });
});

describe("core/health score decay", () => {
  const HALF_LIFE_MS = 1000;
  let home: string;
  let store: ModelHealthStore;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-decay-")));
    store = new ModelHealthStore({ homeDir: home, halfLifeMs: HALF_LIFE_MS });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("weights events by half-life decay", () => {
    expect(healthEventWeight(1000, 1000, HALF_LIFE_MS)).toBe(1);
    expect(healthEventWeight(0, HALF_LIFE_MS, HALF_LIFE_MS)).toBe(0.5);
    expect(healthEventWeight(5000, 1000, HALF_LIFE_MS)).toBe(1); // future-safe: age clamps at 0
  });

  it("scores a success-only model at 1.0 and a fresh failure at 0.5", () => {
    store.recordSuccess({ agent: "a", model: "ok", durationMs: 10, atMs: 1000 });
    store.recordFailure("error", { agent: "a", model: "bad", durationMs: 10, atMs: 1000 });

    const snapshot = store.snapshot(1000);
    expect(snapshot.entries.find((entry) => entry.model === "ok")?.score).toBeCloseTo(1, 10);
    expect(snapshot.entries.find((entry) => entry.model === "bad")?.score).toBeCloseTo(0.5, 10);
  });

  it("mixes successes and failures at equal age to 2/3", () => {
    // score = 1 - 1 / (1 + 1 + 1)
    store.recordSuccess({ agent: "a", model: "mixed", atMs: 1000 });
    store.recordFailure("error", { agent: "a", model: "mixed", atMs: 1000 });
    expect(store.snapshot(1000).entries[0]?.score).toBeCloseTo(2 / 3, 10);
  });

  it("relaxes an idle failure-only model back toward 1.0 as old failures decay", () => {
    store.recordFailure("error", { agent: "a", model: "m", atMs: 1000 });
    const at = (nowMs: number) => store.snapshot(nowMs).entries[0]?.score ?? 0;
    expect(at(1000)).toBeCloseTo(0.5, 10);
    expect(at(2000)).toBeCloseTo(1 - 0.5 / 1.5, 10);
    expect(at(1000 + 10 * HALF_LIFE_MS)).toBeCloseTo(1 - 0.5 ** 10 / (0.5 ** 10 + 1), 10);
    expect(at(1000 + 10 * HALF_LIFE_MS)).toBeGreaterThan(0.99);
  });
});

describe("core/health quarantine", () => {
  const COOLDOWN_MS = 30 * 60_000;
  const T0 = 1_000_000;
  let home: string;
  let store: ModelHealthStore;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-quarantine-")));
    store = new ModelHealthStore({ homeDir: home, cooldownMs: COOLDOWN_MS });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function fail(agent: string, model: string, atMs: number, kind: "error" | "stall" = "error") {
    expect(store.recordFailure(kind, { agent, model, atMs })).toBe(true);
  }

  it("quarantines at the consecutive-failure threshold and reports remaining cooldown", () => {
    fail("a", "m", T0);
    fail("a", "m", T0 + 1);
    let entry = store.snapshot(T0 + 2).entries[0];
    expect(entry?.quarantined).toBe(false);

    fail("a", "m", T0 + 2);
    entry = store.snapshot(T0 + 2).entries[0];
    expect(entry?.quarantined).toBe(true);
    expect(entry?.consecutiveFailures).toBe(3);
    expect(entry?.quarantinedAt).toBe(new Date(T0 + 2).toISOString());
    expect(entry?.cooldownRemainingMs).toBe(COOLDOWN_MS);
  });

  it("lifts the quarantine automatically after the cooldown elapses", () => {
    for (let i = 0; i < 3; i += 1) fail("a", "m", T0 + i);
    // The cooldown is anchored to the last failure (T0 + 2), not the first.
    const lastFailureAt = T0 + 2;
    expect(store.snapshot(lastFailureAt + COOLDOWN_MS - 1).entries[0]?.quarantined).toBe(true);
    expect(store.snapshot(lastFailureAt + COOLDOWN_MS).entries[0]?.quarantined).toBe(false);
    // Still lifted: consecutive failures remain but the cooldown has passed.
    const entry = store.snapshot(lastFailureAt + COOLDOWN_MS + 1).entries[0];
    expect(entry?.quarantined).toBe(false);
    expect(entry?.consecutiveFailures).toBe(3);
  });

  it("re-quarantines when a post-lift probe fails again", () => {
    for (let i = 0; i < 3; i += 1) fail("a", "m", T0 + i);
    fail("a", "m", T0 + COOLDOWN_MS + 1);
    const entry = store.snapshot(T0 + COOLDOWN_MS + 1).entries[0];
    expect(entry?.quarantined).toBe(true);
    expect(entry?.consecutiveFailures).toBe(4);
    expect(entry?.cooldownRemainingMs).toBe(COOLDOWN_MS);
  });

  it("resets the consecutive-failure counter on success", () => {
    for (let i = 0; i < 3; i += 1) fail("a", "m", T0 + i);
    store.recordSuccess({ agent: "a", model: "m", atMs: T0 + COOLDOWN_MS + 1 });
    const entry = store.snapshot(T0 + COOLDOWN_MS + 2).entries[0];
    expect(entry?.consecutiveFailures).toBe(0);
    expect(entry?.quarantined).toBe(false);
    expect(entry?.successCount).toBe(1);
  });

  it("honors a custom failure threshold", () => {
    const strict = new ModelHealthStore({ homeDir: home, failureThreshold: 2 });
    expect(strict.recordFailure("error", { agent: "b", model: "m", atMs: T0 })).toBe(true);
    expect(strict.recordFailure("error", { agent: "b", model: "m", atMs: T0 + 1 })).toBe(true);
    expect(strict.snapshot(T0 + 2).entries[0]?.quarantined).toBe(true);
  });

  it("counts attributed watchdog stall events toward quarantine", () => {
    // Terminal error carrying the background taskId, then the watchdog stall
    // line for the same taskId (order-independent attribution).
    fail("a", "m", T0, "error");
    expect(
      store.recordFailure("stall", { agent: "a", model: "m", atMs: T0 + 5, taskId: "t1" }),
    ).toBe(true);
    expect(appendStallEvent({ taskId: "t1", atMs: T0 }, { homeDir: home })).toBe(true);

    const entry = store.snapshot(T0 + 5).entries[0];
    expect(entry?.stallCount).toBe(1);
    expect(entry?.errorCount).toBe(1);
    expect(entry?.consecutiveFailures).toBe(2);
  });

  it("does not double-count a watchdog stall whose terminal record is a stall", () => {
    expect(
      store.recordFailure("stall", { agent: "a", model: "m", atMs: T0 + 5, taskId: "t1" }),
    ).toBe(true);
    expect(appendStallEvent({ taskId: "t1", atMs: T0 }, { homeDir: home })).toBe(true);

    const entry = store.snapshot(T0 + 5).entries[0];
    expect(entry?.stallCount).toBe(1);
    expect(entry?.consecutiveFailures).toBe(1);
    expect(entry?.lastFailureAt).toBe(new Date(T0).toISOString());

    // Attribution is order-independent: stall line first, terminal record after.
    const reversed = foldModelHealth(readHealthLines({ homeDir: home }).slice().reverse(), {
      nowMs: T0 + 5,
      failureThreshold: 3,
      cooldownMs: COOLDOWN_MS,
      halfLifeMs: 24 * 60 * 60_000,
    });
    expect(reversed[0]).toMatchObject({ stallCount: 1, consecutiveFailures: 1 });
  });

  it("ignores stall events whose taskId matches no dispatch record", () => {
    expect(appendStallEvent({ taskId: "ghost", atMs: T0 }, { homeDir: home })).toBe(true);
    expect(store.snapshot(T0).entries).toEqual([]);
  });

  it("bounds the latency samples while counts keep growing", () => {
    for (let i = 0; i < MAX_DURATION_SAMPLES + 5; i += 1) {
      store.recordSuccess({ agent: "a", model: "m", durationMs: i + 1, atMs: T0 + i });
    }
    const entry = store.snapshot(T0 + MAX_DURATION_SAMPLES + 5).entries[0];
    expect(entry?.successCount).toBe(MAX_DURATION_SAMPLES + 5);
    // Last 100 samples are 6..105: p50 = 55 (nearest rank 50), p95 = 100 (rank 95).
    expect(entry?.p50DurationMs).toBe(MAX_DURATION_SAMPLES / 2 + 5);
    expect(entry?.p95DurationMs).toBe(MAX_DURATION_SAMPLES - 5 + 5);
  });
});

describe("core/health reset", () => {
  const T0 = 1_000_000;
  let home: string;
  let store: ModelHealthStore;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-reset-")));
    store = new ModelHealthStore({ homeDir: home });
    store.recordSuccess({ agent: "a", model: "m1", atMs: T0 });
    store.recordSuccess({ agent: "a", model: "m2", atMs: T0 });
    store.recordSuccess({ agent: "b", model: "m1", atMs: T0 });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resets one agent+model pair via an append-only tombstone", () => {
    const linesBefore = readHealthLines({ homeDir: home }).length;
    expect(store.resetModelHealth({ agent: "a", model: "m1", atMs: T0 + 1 })).toBe(true);
    // The log stays append-only: a reset tombstone, no rewrite.
    expect(readHealthLines({ homeDir: home })).toHaveLength(linesBefore + 1);

    const remaining = store
      .snapshot(T0 + 2)
      .entries.map((entry) => `${entry.agent}/${entry.model}`);
    expect(remaining).toEqual(["a/m2", "b/m1"]);
  });

  it("resets every model of one agent and supports a full reset", () => {
    expect(store.resetModelHealth({ agent: "a", atMs: T0 + 1 })).toBe(true);
    expect(store.snapshot(T0 + 2).entries.map((entry) => entry.agent)).toEqual(["b"]);

    expect(store.resetModelHealth({ atMs: T0 + 3 })).toBe(true);
    expect(store.snapshot(T0 + 4).entries).toEqual([]);
  });

  it("resets one model across agents", () => {
    expect(store.resetModelHealth({ model: "m1", atMs: T0 + 1 })).toBe(true);
    expect(store.snapshot(T0 + 2).entries.map((entry) => entry.model)).toEqual(["m2"]);
  });
});

describe("core/health candidate ordering", () => {
  const healthy = (score: number) => ({ score, quarantined: false });
  const quarantined = { score: 0.1, quarantined: true };

  it("prefers tier-matched candidates, then health score, then costLevel", () => {
    const ordered = orderCandidatesByHealth({
      candidates: [
        { key: "cheap-medium", tier: "medium", costLevel: 1 },
        { key: "weak-strong-cost", tier: "weak", costLevel: 5 },
        { key: "healthy-medium", tier: "medium", costLevel: 2 },
        { key: "opaque" },
      ],
      referenceTier: "weak",
      healthOf: (key) =>
        key === "healthy-medium" ? healthy(0.9) : key === "cheap-medium" ? healthy(0.4) : undefined,
    });
    expect(ordered.candidates.map((entry) => entry.key)).toEqual([
      "weak-strong-cost", // tier match wins even at high costLevel
      "opaque", // unknown health treated as a perfect score (unproven is not unhealthy)
      "healthy-medium", // higher health score
      "cheap-medium",
    ]);
    expect(ordered.warning).toBeUndefined();
  });

  it("keeps declaration order for full ties (stable sort)", () => {
    const candidates: HealthWeightedCandidate[] = [
      { key: "first", costLevel: 2 },
      { key: "second", costLevel: 2 },
    ];
    expect(orderCandidatesByHealth({ candidates }).candidates.map((entry) => entry.key)).toEqual([
      "first",
      "second",
    ]);
  });

  it("excludes quarantined candidates while healthy ones remain", () => {
    const ordered = orderCandidatesByHealth({
      candidates: [
        { key: "q", tier: "weak", costLevel: 1 },
        { key: "h", tier: "medium", costLevel: 1 },
      ],
      referenceTier: "weak",
      healthOf: (key) => (key === "q" ? quarantined : healthy(1)),
    });
    expect(ordered.candidates.map((entry) => entry.key)).toEqual(["h"]);
    expect(ordered.warning).toBeUndefined();
  });

  it("reinstates quarantined candidates with a warning when nothing else remains", () => {
    const ordered = orderCandidatesByHealth({
      candidates: [
        { key: "q2", tier: "medium", costLevel: 2 },
        { key: "q1", tier: "weak", costLevel: 3 },
      ],
      referenceTier: "weak",
      healthOf: () => quarantined,
    });
    expect(ordered.candidates.map((entry) => entry.key)).toEqual(["q1", "q2"]);
    expect(ordered.warning).toContain("quarantined");
    expect(ordered.warning).toContain("last resort");
  });

  it("falls back to costLevel ordering with unmetered entries last when no health exists", () => {
    const ordered = orderCandidatesByHealth({
      candidates: [
        { key: "metered", costLevel: 3 },
        { key: "unmetered" },
        { key: "cheap", costLevel: 1 },
      ],
    });
    expect(ordered.candidates.map((entry) => entry.key)).toEqual(["cheap", "metered", "unmetered"]);
  });

  it("aggregates one agent's models conservatively (worst score, all-quarantined)", () => {
    const entry = (
      agent: string,
      model: string,
      score: number,
      quarantined: boolean,
    ): ModelHealthEntry => ({
      agent,
      model,
      score,
      successCount: 1,
      errorCount: 3,
      stallCount: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      consecutiveFailures: 3,
      lastFailureAt: new Date(0).toISOString(),
      quarantined,
      ...(quarantined ? { quarantinedAt: new Date(0).toISOString(), cooldownRemainingMs: 1 } : {}),
    });
    const entries = [
      entry("a", "m1", 0.4, true),
      entry("a", "m2", 0.9, false),
      entry("b", "m1", 0.2, true),
    ];
    expect(resolveAgentHealthCandidate(entries, "a")).toEqual({ score: 0.4, quarantined: false });
    expect(resolveAgentHealthCandidate(entries, "b")).toEqual({ score: 0.2, quarantined: true });
    expect(resolveAgentHealthCandidate(entries, "ghost")).toBeUndefined();
  });
});

describe("core/health runner seams", () => {
  class MockAdapter extends BaseAdapter {
    readonly name: AgentName = "codex";
    readonly displayName = "Mock Codex";
    readonly supportedModes: readonly TransportMode[] = ["cli"];
    readonly sandboxMechanism: SandboxMechanism = "prompt-only";
    readonly envBinOverride = "MOCK_CODEX_BIN";
    readonly defaultExecutableName = "node";

    constructor(private readonly failureMode: "none" | "model-rejected" = "none") {
      super();
    }

    protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
      if (this.failureMode === "model-rejected") {
        return {
          status: "failed",
          agent: this.name,
          summary: "vendor refused the model",
          output: "refused",
          error: "model rejected by vendor",
          errorCode: "MODEL_REJECTED",
          durationMs: 5,
        };
      }
      return {
        status: "success",
        agent: this.name,
        summary: "Mock task executed successfully",
        output: `Executed: ${options.task}`,
        exitCode: 0,
        durationMs: 15,
      };
    }
  }

  let home: string;
  let registry: AgentRegistry;
  let runner: MultiAgentRunner;
  let health: ModelHealthStore;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-seam-")));
    registry = new AgentRegistry();
    const sessionManager = new SessionManager({ storagePath: path.join(home, "sessions.json") });
    runner = new MultiAgentRunner(registry, sessionManager);
    health = new ModelHealthStore({ homeDir: home });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("records a success and an error from the terminal-turn seam", async () => {
    registry.register(new MockAdapter());
    const ok = await runner.delegateTask({ agent: "codex", task: "build", model: "good-model" });
    expect(ok.status).toBe("success");

    registry.register(new MockAdapter("model-rejected"));
    const failed = await runner.delegateTask({
      agent: "codex",
      task: "build",
      model: "good-model",
    });
    expect(failed.status).toBe("failed");

    const snapshot = health.snapshot();
    const entry = snapshot.entries.find((candidate) => candidate.agent === "codex");
    // Exact durations are not asserted: BaseAdapter.runUnchecked overrides the
    // adapter-reported durationMs with wall time, so percentiles vary by run.
    expect(entry).toMatchObject({
      model: "good-model",
      successCount: 1,
      errorCount: 1,
      consecutiveFailures: 1,
    });
  });

  it("records nothing for dispatches without a model", async () => {
    registry.register(new MockAdapter());
    await runner.delegateTask({ agent: "codex", task: "build" });
    expect(health.snapshot().entries).toEqual([]);
  });

  it("orders hint.nextCandidates by health and quarantines failing models", async () => {
    registry.register(new MockAdapter("model-rejected"));
    const projectRoot = path.join(home, "project");
    fs.mkdirSync(path.join(projectRoot, ".agentmesh"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".agentmesh", "config.json"),
      JSON.stringify({
        version: 1,
        roles: { worker: "codex" },
        agents: {
          codex: { tier: "weak", costLevel: 2, candidates: ["grok", "antigravity", "claude"] },
          grok: { tier: "weak", costLevel: 1 },
          antigravity: { tier: "medium", costLevel: 2 },
          claude: { tier: "medium", costLevel: 3 },
        },
      }),
    );

    // Quarantine grok (weak tier, cheapest) with three consecutive failures.
    for (let i = 0; i < 3; i += 1) {
      health.recordFailure("error", { agent: "grok", model: "m", atMs: Date.now() });
    }

    const res = await runner.delegateTask({
      agent: "codex",
      task: "Upgradeable failure probe",
      cwd: projectRoot,
    });
    expect(res.errorCode).toBe("MODEL_REJECTED");
    // grok is quarantined and excluded even though it is the tier match.
    expect(res.warning).toContain("hint.nextCandidates=[antigravity, claude]");
    expect(res.warning).not.toContain("quarantined by model health");

    // Quarantine every candidate: they are reinstated as a last resort.
    for (const agent of ["antigravity", "claude"]) {
      for (let i = 0; i < 3; i += 1) {
        health.recordFailure("error", { agent, model: "m", atMs: Date.now() });
      }
    }
    const allQuarantined = await runner.delegateTask({
      agent: "codex",
      task: "Upgradeable failure probe",
      cwd: projectRoot,
    });
    expect(allQuarantined.warning).toContain("hint.nextCandidates=[grok, antigravity, claude]");
    expect(allQuarantined.warning).toContain("quarantined by model health");
  });

  it("appends a taskId-keyed stall line from the background watchdog seam", () => {
    const background = new BackgroundTaskRegistry({ homeDir: home });
    // Enable first (no active tasks → no timer), then register.
    background.enableStalledWatchdog({ thresholdMs: 1, terminateThresholdMs: 0 });
    background.registerTask({
      taskId: "bgtask_stall",
      pid: process.pid,
      startedAtMs: Date.now() - 1000,
      outputFile: path.join(home, "tasks", "bgtask_stall.output"),
    });
    const newlyStalled = background.checkStalledTasks(Date.now());
    expect(newlyStalled).toEqual(["bgtask_stall"]);
    background.releaseTask("bgtask_stall");

    const lines = readHealthLines({ homeDir: home });
    const stallLine = lines.find((line) => line.type === "stall" && line.taskId === "bgtask_stall");
    expect(stallLine).toMatchObject({ type: "stall", taskId: "bgtask_stall" });
    expect(typeof stallLine?.atMs).toBe("number");
  });
});
