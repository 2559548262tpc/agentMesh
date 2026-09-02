#!/usr/bin/env node
/**
 * AgentMesh M1 fake-vendor simulation CLI.
 *
 * A dependency-free, deterministic fake vendor coding agent used by the
 * simulation suite (tests/simulation/, `npm run test:simulation`) to replay
 * every fault class manually discovered in real-test rounds r21/r22 without
 * real vendor credentials, network access or quota consumption:
 *
 *   - ok             normal completion with configurable output (control case)
 *   - stall          0-byte stall: prints NOTHING, then hangs until killed
 *                    (P-R21-2 nemotron freeze / P-R22-2 opencode review stall)
 *   - truncate       long output that stops mid-stream, then exits 0
 *                    (P-R21-1 opencode plan-mode abort / P-R22-3 ling truncation)
 *   - apierror       structured vendor error on stderr, non-zero exit (P-R22-1 muse-spark)
 *   - slow           delays longer than a configurable timeout before any output
 *   - semantic-fail  exit 0 but the output clearly signals failure (missing markers)
 *   - exit-mismatch  clean text output combined with a non-zero exit code
 *
 * Usage:
 *   node fake-vendor.mjs --mode <mode> [--out-chars N] [--delay-ms N]
 *                       [--exit-code N] [--stderr TEXT] [--text TEXT]
 *                       [--interval-ms N] [--heartbeats N] [--json]
 *                       [--output-last-message PATH]
 *
 * Embedded injection form (used when the CLI argv is fixed by the adapter, as
 * with the real Codex adapter): any argv element may carry a directive block
 * whose keys mirror the options above, e.g. a task prompt ending with:
 *
 *   fake-vendor-sim: mode=stall
 *   fake-vendor-sim: mode=ok, delay-ms=200, interval-ms=120, heartbeats=6
 *
 * Direct `--flag value` arguments take precedence over embedded keys; spaces
 * inside embedded `stderr=`/`text=` values are written as `+`.
 *
 * When the AgentMesh Codex adapter invokes this CLI it passes `--json` and
 * `--output-last-message <path>`; the script then emits Codex-protocol JSONL
 * events on stdout and writes the official last-message artifact, so the whole
 * production parsing/settle pipeline is exercised end to end.
 */

import fs from "node:fs";

const SIM_MARKER = "fake-vendor-sim:";
const MODES = ["ok", "stall", "truncate", "apierror", "slow", "semantic-fail", "exit-mismatch"];

/** Real muse-spark APIErrors were model-side unavailability (P-R22-1). The
 * wording avoids the resilience layer's transient-5xx patterns so the failure
 * is surfaced once instead of being auto-retried. */
const DEFAULT_API_ERROR =
  "ERROR: APIError 400: upstream model request refused (vendor-sim simulation)";

const FILLER =
  "Vendor simulation progress evidence: deterministic padding from the fake-vendor harness. ";

function fail(message) {
  fs.writeSync(2, `fake-vendor: ${message}\n`);
  process.exit(64);
}

function parseNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Direct CLI flags; unknown argv elements (vendor args, the prompt) are ignored. */
function parseDirectOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = i + 1 < argv.length ? argv[i + 1] : undefined;
    if (arg === "--mode") {
      options.mode = value;
      i += 1;
    } else if (arg === "--out-chars") {
      options.outChars = parseNonNegativeNumber(value, options.outChars);
      i += 1;
    } else if (arg === "--delay-ms") {
      options.delayMs = parseNonNegativeNumber(value, options.delayMs);
      i += 1;
    } else if (arg === "--exit-code") {
      options.exitCode = parseNonNegativeNumber(value, options.exitCode);
      i += 1;
    } else if (arg === "--stderr") {
      options.stderr = value;
      i += 1;
    } else if (arg === "--text") {
      options.text = value;
      i += 1;
    } else if (arg === "--interval-ms") {
      options.intervalMs = parseNonNegativeNumber(value, options.intervalMs);
      i += 1;
    } else if (arg === "--heartbeats") {
      options.heartbeats = parseNonNegativeNumber(value, options.heartbeats);
      i += 1;
    } else if (arg === "--output-last-message") {
      options.lastMessageFile = value;
      i += 1;
    }
  }
  return options;
}

/** Embedded `fake-vendor-sim:` directive block inside any argv element. */
function parseEmbeddedOptions(argv) {
  const carrier = argv.find((arg) => typeof arg === "string" && arg.includes(SIM_MARKER));
  if (carrier === undefined) return {};
  const options = {};
  const markerStart = carrier.indexOf(SIM_MARKER) + SIM_MARKER.length;
  // The directive ends with the carrier line; the rest of the prompt stays inert.
  const tail = carrier.slice(markerStart).split(/\r?\n/)[0] ?? "";
  const pairPattern = /([a-z][a-z-]*)\s*=\s*([^\s,]+)/g;
  for (const match of tail.matchAll(pairPattern)) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    if (key === "mode") options.mode = value;
    else if (key === "out-chars") options.outChars = parseNonNegativeNumber(value, undefined);
    else if (key === "delay-ms") options.delayMs = parseNonNegativeNumber(value, undefined);
    else if (key === "exit-code") options.exitCode = parseNonNegativeNumber(value, undefined);
    else if (key === "stderr") options.stderr = value.replaceAll("+", " ");
    else if (key === "text") options.text = value.replaceAll("+", " ");
    else if (key === "interval-ms") options.intervalMs = parseNonNegativeNumber(value, undefined);
    else if (key === "heartbeats") options.heartbeats = parseNonNegativeNumber(value, undefined);
  }
  return options;
}

/**
 * Deterministic narrative of roughly outChars characters, terminated by a
 * mode-specific closing marker. The truncate marker ends mid-sentence — the
 * exact "Now creating..." faTail signature recorded for ling in P-R22-3.
 */
function narrative(outChars, closingMarker) {
  let body = "";
  for (let i = 1; body.length < outChars; i += 1) {
    body += `step ${i}: ${FILLER}`;
  }
  return body.slice(0, Math.max(0, outChars)) + closingMarker;
}

const CLOSING_MARKERS = {
  ok: " DONE: all simulated acceptance criteria are satisfied.",
  truncate: " Now creating page 3 of 5...",
  "semantic-fail": " TASK INCOMPLETE: only pages 1-2 of 5 were written; pages 3-5 were skipped.",
  "exit-mismatch": " All checks passed; the task finished successfully.",
};

/** fs.writeSync may perform a partial write on pipes; loop until complete. */
function writeAll(fd, data) {
  const buffer = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // Direct flags win over the embedded directive block.
  const options = { ...parseEmbeddedOptions(argv), ...parseDirectOptions(argv) };

  const mode = options.mode ?? "ok";
  if (!MODES.includes(mode)) {
    fail(`unknown mode '${mode}' (expected one of: ${MODES.join(", ")})`);
  }

  const useJson = argv.includes("--json");
  const outChars = options.outChars ?? 200;
  const exitCode = options.exitCode ?? (mode === "apierror" ? 1 : mode === "exit-mismatch" ? 7 : 0);
  const stderrText = options.stderr ?? (mode === "apierror" ? DEFAULT_API_ERROR : undefined);
  // slow defaults to a delay that outlives typical test timeouts unless overridden.
  const delayMs = options.delayMs ?? (mode === "slow" ? 30_000 : 0);
  const intervalMs = options.intervalMs ?? 0;
  const heartbeats = options.heartbeats ?? 0;
  const lastMessageFile = options.lastMessageFile;

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (mode === "stall") {
    // The 0-byte stall contract: no stdout, no stderr, no artifacts, no exit.
    // The referenced interval keeps the event loop alive until the caller
    // kills the process tree (watchdog auto-terminate, cancel, or timeout).
    setInterval(() => {}, 3_600_000);
    return;
  }

  if (useJson) {
    const threadId = `sim-${mode}-${process.pid}-${Date.now().toString(36)}`;
    // The id deliberately violates the codex rollout UUID shape so the
    // adapter's crash-salvage path stays out of the simulation.
    writeAll(1, `${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n`);
  }

  const mainText = options.text ?? narrative(outChars, CLOSING_MARKERS[mode] ?? CLOSING_MARKERS.ok);

  if (mode === "apierror") {
    if (useJson) {
      writeAll(1, `${JSON.stringify({ type: "error", error: stderrText })}\n`);
    }
  } else {
    if (useJson) {
      writeAll(
        1,
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: mainText },
        })}\n`,
      );
    } else {
      writeAll(1, `${mainText}\n`);
    }
    if (lastMessageFile !== undefined) {
      fs.writeFileSync(lastMessageFile, mainText, "utf8");
    }
  }

  if (mode === "truncate" && useJson) {
    // Mid-stream cut: a partial JSONL event with no closing brace and no
    // newline, so the capture file holds verbatim evidence of the truncation.
    writeAll(1, '{"type":"item.completed","item":{"type":"agent_m');
  }

  if (stderrText !== undefined) {
    writeAll(2, `${stderrText}\n`);
  }

  if (intervalMs > 0 && heartbeats > 0) {
    for (let i = 1; i <= heartbeats; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      writeAll(
        1,
        useJson ? `${JSON.stringify({ type: "heartbeat", n: i })}\n` : `heartbeat ${i}\n`,
      );
    }
  }

  process.exit(exitCode);
}

await main();
