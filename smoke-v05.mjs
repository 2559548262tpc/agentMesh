import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * smoke-v05.mjs — v0.5 Batch 1 live smoke driver (reconciliation ledger).
 *
 * Spawns a FRESH bridge from the current dist (the orchestrator's own MCP
 * connection predates the v0.5 build), runs a 3-stage workflow
 * (worker → reviewer → tester, all opencode) against an isolated temp git
 * workspace with requirementsPath reconciliation, observes the compact
 * get_workflow envelope (P-080①), fetches the full snapshot once (Tier 0
 * spill check, P-080②), then collects ledger/metrics/archive evidence.
 * Real vendor quota is consumed: one workflow, ≤1 rework round.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = "D:/temp_pip/opencode/v05-recon-test";
const HOME = "D:/temp_pip/opencode/v05-recon-home";
const EVIDENCE = "D:/temp_pip/opencode/v05-recon-evidence";
const OPENCODE_BIN = "C:\\Users\\25595\\AppData\\Local\\Microsoft\\WindowsApps\\opencode.cmd";

mkdirSync(HOME, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });
if (!existsSync(join(WS, ".git"))) throw new Error("workspace git repo missing: " + WS);

const spec = JSON.parse(readFileSync(join(WS, "spec.json"), "utf-8"));
const meta = { t0: new Date().toISOString(), ws: WS, home: HOME };

async function startServer() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(__dirname, "dist", "cli", "index.js"), "serve"],
    env: {
      ...process.env,
      AGENTMESH_SESSIONS_FILE: join(HOME, "sessions.json"),
      OPENCODE_BIN,
    },
  });
  const client = new Client({ name: "smoke-v05", version: "0.5.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}, timeout = 900000) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  return { ...res, elapsedMs: Date.now() - t0 };
}

function text(res) {
  return (res.content ?? []).map((c) => c.text ?? "").join("\n");
}

function save(tag, content) {
  writeFileSync(
    join(EVIDENCE, tag),
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf-8",
  );
  console.log(`  [evidence] ${tag}`);
}

const client = await startServer();
console.log("MCP connected (fresh dist).");

// Guard: refuse to burn quota against a pre-v0.5 bridge.
const tools = await client.listTools();
const runDesc = tools.tools.find((t) => t.name === "run_workflow")?.description ?? "";
if (!runDesc.includes("needs_ruling")) {
  throw new Error(
    "dist is not the v0.5 build (run_workflow description lacks needs_ruling); aborting before any dispatch.",
  );
}
console.log("v0.5 build confirmed (needs_ruling in tool contract).");

const launch = await callTool(client, "run_workflow", {
  cwd: WS,
  requirementsPath: "requirements.json",
  spec,
});
const launchText = text(launch);
save("01-launch.json", launchText);
console.log(`launch elapsedMs=${launch.elapsedMs} isError=${launch.isError ?? false}`);
if (launch.isError) throw new Error("run_workflow rejected: " + launchText.slice(0, 800));
const workflowId = JSON.parse(launchText).workflowId;
meta.workflowId = workflowId;
meta.tLaunch = new Date().toISOString();
console.log("workflowId:", workflowId);

// Compact polling (P-080①): default envelope only; log size + flags per poll.
const polls = [];
let terminal = null;
for (let attempt = 1; attempt <= 60; attempt++) {
  const res = await callTool(client, "get_workflow", { workflowId, maxWaitMs: 30000 }, 60000);
  const body = text(res);
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    envelope = { parseError: body.slice(0, 300) };
  }
  const poll = {
    attempt,
    at: new Date().toISOString(),
    bytes: body.length,
    isError: res.isError ?? false,
    status: envelope.status,
    flags: envelope.flags,
    stages: envelope.stages,
    ledgerRef: envelope.ledgerRef,
  };
  polls.push(poll);
  console.log(JSON.stringify(poll));
  save("02-polls.jsonl", polls.map((p) => JSON.stringify(p)).join("\n"));
  if (envelope.status && envelope.status !== "running") {
    terminal = envelope;
    break;
  }
}
if (!terminal) throw new Error("workflow did not reach a terminal state within 60 polls");
meta.tTerminal = new Date().toISOString();
meta.terminalStatus = terminal.status;
console.log("TERMINAL:", terminal.status, "| flags:", JSON.stringify(terminal.flags ?? {}));

// Full snapshot once (Tier 0 check, P-080②): a >2KB body must spill to out/.
const full = await callTool(client, "get_workflow", { workflowId, detail: "full" }, 60000);
const fullText = text(full);
const tier0 = fullText.startsWith("[tier0:");
let snapshotText = fullText;
let tier0ArtifactPath;
if (tier0) {
  tier0ArtifactPath = fullText.match(/full output persisted to (.+?); showing/)?.[1] ?? null;
  console.log("TIER 0 fired: full body spilled to", tier0ArtifactPath);
  if (tier0ArtifactPath && existsSync(tier0ArtifactPath)) {
    snapshotText = readFileSync(tier0ArtifactPath, "utf-8");
  }
} else {
  console.log("Tier 0 did not fire (full body <= 2KB).");
}
meta.tier0 = { fired: tier0, artifactPath: tier0ArtifactPath };
save("03-terminal-full.txt", fullText);
let snapshot = null;
try {
  snapshot = JSON.parse(snapshotText);
} catch {
  save("03b-snapshot-unparseable.txt", snapshotText.slice(0, 2000));
}

// Stage wall durations from transitions; task records for roles/sessions.
if (snapshot) {
  meta.stages = snapshot.stages.map((stage) => {
    const at = (status) => stage.transitions.find((t) => t.status === status)?.at;
    const dispatchAt = at("dispatched") ?? at("running");
    const endAt = at("passed") ?? at("failed") ?? at("escalated");
    return {
      name: stage.name,
      index: stage.index,
      status: stage.status,
      dispatchedAt: dispatchAt,
      endedAt: endAt,
      wallMs: dispatchAt && endAt ? Date.parse(endAt) - Date.parse(dispatchAt) : null,
      tasks: stage.tasks.map((task) => ({
        role: task.role,
        agent: task.agent,
        status: task.status,
        summary: task.summary?.slice(0, 200),
        error: task.error?.slice(0, 200),
        sessionId: task.sessionId,
        reroutedFrom: task.reroutedFrom,
      })),
      review: stage.review
        ? { verdict: stage.review.verdict, rounds: stage.review.rounds.length }
        : undefined,
      sessionIds: stage.sessionIds,
    };
  });
}

// Ledger evidence.
let ledger = null; // eslint-disable-line no-useless-assignment -- reassigned below when the ledger file exists
const ledgerRef = terminal.ledgerRef ?? snapshot?.ledgerRef;
if (ledgerRef && existsSync(ledgerRef)) {
  ledger = JSON.parse(readFileSync(ledgerRef, "utf-8"));
  save("04-ledger.json", ledger);
  console.log(
    "ledger rows:",
    ledger.rows.map((row) => `${row.id}=${row.status}`).join(" "),
    "| invariant:",
    JSON.stringify(ledger.invariant),
  );
} else {
  console.log("ledger file missing:", ledgerRef);
}

// Metrics evidence: per-dispatch vendor-reported usage from metrics.jsonl.
const metricsPath = join(HOME, "metrics.jsonl");
const metrics = [];
if (existsSync(metricsPath)) {
  for (const line of readFileSync(metricsPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      metrics.push(JSON.parse(line));
    } catch {
      /* skip corrupt */
    }
  }
}
const perRole = {};
for (const record of metrics) {
  if (record.outcome === "stalled") continue;
  const key = record.role ?? "unknown";
  perRole[key] ??= { dispatches: 0, tokensIn: 0, tokensOut: 0, durationMs: 0, models: new Set() };
  perRole[key].dispatches += 1;
  perRole[key].tokensIn += record.tokensIn ?? 0;
  perRole[key].tokensOut += record.tokensOut ?? 0;
  perRole[key].durationMs += record.durationMs ?? 0;
  perRole[key].models.add(record.model ?? "unknown");
}
const metricsSummary = {
  perRole: Object.fromEntries(
    Object.entries(perRole).map(([role, value]) => [role, { ...value, models: [...value.models] }]),
  ),
  totalDispatchedTokens: Object.values(perRole).reduce(
    (sum, value) => sum + value.tokensIn + value.tokensOut,
    0,
  ),
  rawRecords: metrics,
};
save("05-metrics.json", metricsSummary);
console.log(
  "metrics per role:",
  Object.entries(metricsSummary.perRole)
    .map(
      ([role, value]) =>
        `${role}: ${value.dispatches} dispatch(es), ${value.tokensIn}+${value.tokensOut} tok, ${value.durationMs}ms`,
    )
    .join(" | ") || "(no records)",
);

// Tier 1 archive evidence: archived sessions must carry the placeholder,
// the last stage's sessions keep their newest turn verbatim.
const sessionsFile = join(HOME, "sessions.json");
const archiveCheck = { checked: [], note: "sessions.json unreadable or absent" };
if (existsSync(sessionsFile)) {
  try {
    const parsed = JSON.parse(readFileSync(sessionsFile, "utf-8"));
    const sessions = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const allSessionIds = (snapshot?.stages ?? []).flatMap((stage) => stage.sessionIds);
    const lastStageWithSessions = [...(snapshot?.stages ?? [])]
      .reverse()
      .find((stage) => stage.sessionIds.length > 0);
    const keep = new Set(lastStageWithSessions?.sessionIds ?? []);
    archiveCheck.checked = allSessionIds.map((sessionId) => {
      const session = byId.get(sessionId);
      if (!session) return { sessionId, found: false };
      const lastTurn = session.history.at(-1);
      const archivedTurns = session.history.filter(
        (entry) =>
          (entry.finalAnswer ?? "").includes("[archived →") ||
          (entry.task ?? "").includes("[archived →"),
      ).length;
      return {
        sessionId,
        role: session.role,
        turns: session.history.length,
        archivedTurns,
        kept: keep.has(sessionId),
        lastTurnIntact: keep.has(sessionId)
          ? !(lastTurn?.finalAnswer ?? "").includes("[archived →")
          : undefined,
      };
    });
    archiveCheck.note = "ok";
  } catch (err) {
    archiveCheck.note = `parse failed: ${err.message}`;
  }
}
save("06-archive-check.json", archiveCheck);
console.log("archive check:", JSON.stringify(archiveCheck.checked, null, 2));

meta.tReport = new Date().toISOString();
save("00-meta.json", meta);
console.log("SUMMARY:", JSON.stringify(meta, null, 2));
await client.close();
console.log("done.");
