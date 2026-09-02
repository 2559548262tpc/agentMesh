import type { SessionHistoryEntry } from "./types.js";

/**
 * M7 handoff-fidelity judge (ROADMAP_v0.4): a machine judge for context
 * handoffs. It compares what an upstream Bridge session actually produced
 * (task text, summary, finalAnswer, reviewer findings, repository evidence)
 * against what a downstream dispatch actually received through
 * `contextSessionIds` injection, and returns a per-section preservation
 * report plus an overall loss grade — replacing the human diff previously
 * done against real_test.md.
 *
 * Pure functions only: no I/O. Callers pass both histories in; the verbatim
 * injected blocks (persisted by SessionManager.persistContextArtifact as
 * shared-context audit sidecars) are passed through `injectedContextByTurn`
 * when the caller can read them. Where the recorded injection content is
 * available, sections are judged by substring/coverage checks against the
 * exact bytes the downstream session received (`basis: "content"`); where
 * only the shared-context audit metadata (per-source chars + truncated flag)
 * is recorded, sections are judged from that metadata and the report says so
 * (`basis: "metadata"`).
 */

/** Sections of the upstream output whose delivery is judged. */
export type HandoffSection = "task" | "summary" | "finalAnswer" | "findings" | "evidence";

/**
 * - preserved: the section arrived intact (content basis) or no loss signal
 *   exists in the recorded injection metadata (metadata basis).
 * - truncated: the section arrived only partially (a recognizable head of a
 *   fragment is present but the full fragment is not), or the recorded
 *   injection metadata carries a truncation marker for the upstream source.
 * - missing: nothing was delivered for a section the upstream produced.
 *   When no shared-context audit metadata exists for the analyzed turn,
 *   delivery is unverifiable and conservatively reported as missing.
 * - not-applicable: the upstream never produced this section.
 */
export type HandoffSectionState = "preserved" | "truncated" | "missing" | "not-applicable";

/** Whether a judgment derives from recorded injection content or from metadata. */
export type HandoffJudgmentBasis = "content" | "metadata";

/** Freshness of the upstream source as recorded in the injected block. */
export type HandoffFreshness = "MATCHED" | "STALE" | "UNKNOWN" | "not-recorded";

/**
 * Overall handoff loss grade. Thresholds (first match wins):
 *
 * 1. `lost`            — the downstream session records no context injection
 *                        referencing the upstream (no `contextSources` at
 *                        all, or none referencing the requested upstream), or
 *                        every applicable section is missing.
 * 2. `severe-loss`     — the task section is missing: the downstream never
 *                        received what the upstream was asked to do, while at
 *                        least one other section survived.
 * 3. `partial-loss`    — at least one applicable section is missing (task
 *                        still delivered).
 * 4. `minor-truncation`— nothing missing but at least one section truncated;
 *                        or a STALE freshness on the analyzed injection
 *                        downgrades an otherwise lossless delivery (the bytes
 *                        arrived but the upstream conclusions are provably
 *                        outdated relative to the current repository state).
 * 5. `lossless`        — every applicable section preserved and freshness is
 *                        not STALE. A downstream record with nothing to
 *                        deliver (empty upstream history) is vacuously
 *                        lossless.
 */
export type HandoffGrade =
  | "lossless"
  | "minor-truncation"
  | "partial-loss"
  | "severe-loss"
  | "lost";

/** Judgment of one upstream section's delivery into the downstream dispatch. */
export interface HandoffSectionJudgment {
  section: HandoffSection;
  state: HandoffSectionState;
  basis: HandoffJudgmentBasis;
  /** Human-readable explanation of the judgment. */
  detail: string;
}

/** One recorded context-injection entry found in the downstream history. */
export interface HandoffContextEntrySummary {
  /** 1-based index of the downstream history entry carrying the injection. */
  turnNumber: number;
  /** ISO timestamp of the downstream turn. */
  timestamp: string;
  /** Upstream session ids the turn declares as context sources. */
  referencedSessionIds: string[];
  /** Freshness recorded for the upstream source (or the combined block). */
  freshness: HandoffFreshness;
  /** Chars recorded for the upstream source's injected block (unrecorded when absent). */
  injectedChars: number | undefined;
  /** True when a truncation marker is recorded for the injected block. */
  truncated: boolean;
  /** Whether the verbatim injected content was available for this entry. */
  basis: HandoffJudgmentBasis;
  /** True for the latest entry referencing the upstream; it drives the judgments. */
  analyzed: boolean;
}

/** Machine-readable handoff fidelity report. */
export interface HandoffReport {
  grade: HandoffGrade;
  /** Per-section judgments across all upstream-produced sections. */
  sections: HandoffSectionJudgment[];
  /** Sections the upstream produced but the downstream never received. */
  missingKeys: HandoffSection[];
  /** Sections delivered only partially / with a recorded truncation marker. */
  truncatedKeys: HandoffSection[];
  /** Sections delivered intact. */
  preservedSections: HandoffSection[];
  /** Every context-injection record found in the downstream history, chronological. */
  contextEntries: HandoffContextEntrySummary[];
  /** The entry whose injection drove the section judgments (absent when none). */
  analyzedEntry: HandoffContextEntrySummary | undefined;
}

export interface AnalyzeHandoffOptions {
  /** Normalized history of the upstream (source) session. */
  upstreamHistory: SessionHistoryEntry[];
  /** History of the downstream (consumer) session. */
  downstreamHistory: SessionHistoryEntry[];
  /**
   * Upstream Bridge session id. Disambiguates downstream context entries when
   * the downstream session consumed multiple upstream sessions, and enables
   * per-source chars/freshness attribution from the shared-context audit.
   */
  upstreamSessionId?: string;
  /**
   * Verbatim injected shared-context blocks keyed by the 1-based downstream
   * turn number they were injected into (sidecar audit artifacts). When
   * provided for the analyzed turn, section judgments use substring/coverage
   * checks against the exact delivered bytes; otherwise they fall back to the
   * recorded shared-context audit metadata.
   */
  injectedContextByTurn?: ReadonlyMap<number, string>;
}

/**
 * Head length probed to distinguish "truncated mid-fragment" from "absent":
 * a fragment whose full text is not present but whose head is counts as
 * truncated rather than missing.
 */
const PREFIX_PROBE_CHARS = 80;

/** Matches one per-source block header of the rendered shared context. */
const SOURCE_HEADER_PATTERN = /###\s+Source\s+\d+\s+of\s+\d+\s+\[Session:\s*([^\]|]+?)\s*\|/g;

/** Matches the freshness line rendered inside each source block. */
const FRESHNESS_PATTERN = /Context freshness:\s*(MATCHED|STALE|UNKNOWN)/;

/** Matches the truncation markers the shared-context renderer emits. */
const TRUNCATION_MARKER_PATTERN = /\.\.\. \[truncated\]|\[\d+ older turn\(s\) omitted/;

interface UpstreamSection {
  section: HandoffSection;
  /** Distinct text fragments the renderer must have delivered. */
  fragments: string[];
}

/**
 * JSON-escape variant of a fragment: findings are rendered as JSON, so a
 * fragment containing quotes/newlines only appears in its escaped form.
 */
function fragmentVariants(text: string): string[] {
  const escaped = JSON.stringify(text).slice(1, -1);
  return escaped === text ? [text] : [text, escaped];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Collects the sections the upstream session actually produced. Applicability
 * is presence-based: findings appear on reviewer turns, repository evidence
 * on turns that captured repositoryBefore/repositoryAfter fingerprints.
 */
function collectUpstreamSections(history: SessionHistoryEntry[]): UpstreamSection[] {
  const task = history.map((entry) => nonEmpty(entry.task)).filter(isDefined);
  const summary = history.map((entry) => nonEmpty(entry.summary)).filter(isDefined);
  const finalAnswer = history.map((entry) => nonEmpty(entry.finalAnswer)).filter(isDefined);
  const findings = history
    .flatMap((entry) => entry.findings ?? [])
    .map((finding) => nonEmpty(finding.issue))
    .filter(isDefined);
  const evidence = history
    .flatMap((entry) => [
      entry.evidence?.repositoryAfter?.fingerprint,
      entry.evidence?.repositoryBefore?.fingerprint,
    ])
    .filter(isDefined);
  return [
    { section: "task", fragments: dedupe(task) },
    { section: "summary", fragments: dedupe(summary) },
    { section: "finalAnswer", fragments: dedupe(finalAnswer) },
    { section: "findings", fragments: dedupe(findings) },
    { section: "evidence", fragments: dedupe(evidence) },
  ];
}

function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Splits a rendered shared-context block into its per-source sub-blocks. */
function splitSourceBlocks(
  content: string,
): Array<{ sessionId: string | undefined; text: string }> {
  const headers = [...content.matchAll(SOURCE_HEADER_PATTERN)];
  if (headers.length === 0) return [{ sessionId: undefined, text: content }];
  const blocks: Array<{ sessionId: string | undefined; text: string }> = [];
  // The preamble before the first source header (header, reuse rules,
  // environment snapshot) belongs to no source; keep it as an unattributed
  // leading block so offsets stay aligned.
  const preambleEnd = headers[0]!.index ?? 0;
  if (preambleEnd > 0) blocks.push({ sessionId: undefined, text: content.slice(0, preambleEnd) });
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]!;
    const start = (header.index ?? 0) + header[0].length;
    const next = index + 1 < headers.length ? headers[index + 1]! : undefined;
    const nextStart = next ? (next.index ?? content.length) : content.length;
    blocks.push({ sessionId: header[1], text: content.slice(start, nextStart) });
  }
  return blocks;
}

function readFreshness(text: string): HandoffFreshness | undefined {
  return FRESHNESS_PATTERN.exec(text)?.[1] as HandoffFreshness | undefined;
}

/**
 * Selects the injected sub-block that carried the upstream source, and the
 * freshness recorded for it. Falls back to the whole combined block when the
 * per-source headers cannot be attributed (older rendering or no id given).
 */
function selectAnalyzedBlock(
  content: string,
  upstreamSessionId: string | undefined,
): { text: string; freshness: HandoffFreshness } {
  const attributed = splitSourceBlocks(content).filter((block) => block.sessionId !== undefined);
  const block = (upstreamSessionId
    ? attributed.find((candidate) => candidate.sessionId === upstreamSessionId)
    : attributed.length === 1
      ? attributed[0]
      : undefined) ?? { sessionId: undefined, text: content };
  return { text: block.text, freshness: readFreshness(block.text) ?? "not-recorded" };
}

interface SectionState {
  state: HandoffSectionState;
  detail: string;
}

/**
 * Content-basis judgment: every fragment the upstream produced is checked
 * against the exact bytes recorded as injected. Full presence → preserved;
 * head-only presence → truncated; absent → missing.
 */
function judgeSectionFromContent(section: UpstreamSection, content: string): SectionState {
  const label = `${section.section}: `;
  if (section.fragments.length === 0) {
    return {
      state: "not-applicable",
      detail: `${label}the upstream produced no ${section.section}.`,
    };
  }
  let fullHits = 0;
  let partialHits = 0;
  for (const fragment of section.fragments) {
    const variants = fragmentVariants(fragment);
    if (variants.some((variant) => content.includes(variant))) {
      fullHits += 1;
      continue;
    }
    if (
      fragment.length > PREFIX_PROBE_CHARS &&
      variants.some((variant) => content.includes(variant.slice(0, PREFIX_PROBE_CHARS)))
    ) {
      partialHits += 1;
    }
  }
  const total = section.fragments.length;
  if (fullHits === total) {
    return {
      state: "preserved",
      detail: `${label}all ${total} fragment(s) found verbatim in the recorded injection.`,
    };
  }
  if (partialHits > 0) {
    return {
      state: "truncated",
      detail: `${label}${partialHits} of ${total} fragment(s) only partially present in the recorded injection (truncation cut).`,
    };
  }
  return {
    state: "missing",
    detail: `${label}none of ${total} fragment(s) found in the recorded injection.`,
  };
}

/** Metadata-basis judgment from the recorded shared-context audit, when any. */
function judgeSectionFromMetadata(
  section: UpstreamSection,
  auditSource: { chars: number; truncated: boolean } | undefined,
): SectionState {
  const label = `${section.section}: `;
  if (section.fragments.length === 0) {
    return {
      state: "not-applicable",
      detail: `${label}the upstream produced no ${section.section}.`,
    };
  }
  if (!auditSource) {
    return {
      state: "missing",
      detail: `${label}no shared-context audit metadata for this turn; delivery unverifiable, conservatively reported as missing.`,
    };
  }
  if (auditSource.truncated) {
    return {
      state: "truncated",
      detail: `${label}recorded injection block (${auditSource.chars} chars) carries a truncation marker; judged from metadata.`,
    };
  }
  return {
    state: "preserved",
    detail: `${label}recorded injection block (${auditSource.chars} chars) reports no truncation; judged from metadata.`,
  };
}

/**
 * Pure threshold logic (exported for tests). See {@link HandoffGrade} for the
 * documented thresholds.
 */
export function computeHandoffGrade(inputs: {
  hasContextRecord: boolean;
  sections: ReadonlyArray<Pick<HandoffSectionJudgment, "section" | "state">>;
  staleFreshness: boolean;
}): HandoffGrade {
  if (!inputs.hasContextRecord) return "lost";
  const applicable = inputs.sections.filter((section) => section.state !== "not-applicable");
  if (applicable.length === 0) return "lossless";
  const missing = applicable.filter((section) => section.state === "missing");
  if (missing.length === applicable.length) return "lost";
  if (missing.some((section) => section.section === "task")) return "severe-loss";
  if (missing.length > 0) return "partial-loss";
  const truncated = applicable.some((section) => section.state === "truncated");
  if (truncated || inputs.staleFreshness) return "minor-truncation";
  return "lossless";
}

/**
 * Judges handoff fidelity between one upstream session's normalized history
 * and one downstream session's recorded context injections. See the module
 * JSDoc and {@link HandoffGrade} for the judgment bases and thresholds.
 */
export function analyzeHandoff(options: AnalyzeHandoffOptions): HandoffReport {
  const upstreamSections = collectUpstreamSections(options.upstreamHistory);
  const { contextEntries, analyzedEntry } = summarizeContextEntries(
    options.downstreamHistory,
    options.upstreamSessionId,
    options.injectedContextByTurn,
  );

  if (!analyzedEntry) {
    const sections = upstreamSections.map((section) => ({
      section: section.section,
      state: "missing" as const,
      basis: "metadata" as const,
      detail:
        section.fragments.length === 0
          ? `${section.section}: the upstream produced no ${section.section}.`
          : `${section.section}: no context injection referencing the upstream is recorded in the downstream session.`,
    }));
    const grade = computeHandoffGrade({
      hasContextRecord: false,
      sections,
      staleFreshness: false,
    });
    return buildReport(grade, sections, contextEntries, undefined);
  }

  const content = options.injectedContextByTurn?.get(analyzedEntry.turnNumber);
  const staleFreshness = analyzedEntry.freshness === "STALE";
  const sections = upstreamSections.map((section) => {
    if (content) {
      const block = selectAnalyzedBlock(content, options.upstreamSessionId);
      const judgment = judgeSectionFromContent(section, block.text);
      return { section: section.section, basis: "content" as const, ...judgment };
    }
    const auditSource = findAuditSource(
      options.downstreamHistory,
      analyzedEntry.turnNumber,
      options.upstreamSessionId,
    );
    const judgment = judgeSectionFromMetadata(section, auditSource);
    return { section: section.section, basis: "metadata" as const, ...judgment };
  });
  const grade = computeHandoffGrade({ hasContextRecord: true, sections, staleFreshness });
  return buildReport(grade, sections, contextEntries, analyzedEntry);
}

/** Finds the recorded audit stats of one context entry's upstream source. */
function findAuditSource(
  downstreamHistory: SessionHistoryEntry[],
  turnNumber: number,
  upstreamSessionId: string | undefined,
): { chars: number; truncated: boolean } | undefined {
  const entry = downstreamHistory[turnNumber - 1];
  const audit = entry?.sharedContextAudit;
  if (!audit) return undefined;
  const source = upstreamSessionId
    ? audit.sources.find((candidate) => candidate.sessionId === upstreamSessionId)
    : audit.sources.at(0);
  return source ? { chars: source.chars, truncated: source.truncated } : undefined;
}

/** Scans the downstream history for context-injection records. */
function summarizeContextEntries(
  downstreamHistory: SessionHistoryEntry[],
  upstreamSessionId: string | undefined,
  injectedContextByTurn: ReadonlyMap<number, string> | undefined,
): {
  contextEntries: HandoffContextEntrySummary[];
  analyzedEntry: HandoffContextEntrySummary | undefined;
} {
  const contextEntries: HandoffContextEntrySummary[] = [];
  downstreamHistory.forEach((entry, index) => {
    const referenced = entry.contextSources ?? [];
    if (referenced.length === 0) return;
    const turnNumber = index + 1;
    const content = injectedContextByTurn?.get(turnNumber);
    const audit = entry.sharedContextAudit;
    const auditSource = upstreamSessionId
      ? audit?.sources.find((candidate) => candidate.sessionId === upstreamSessionId)
      : audit?.sources.at(0);
    const injectedChars = auditSource?.chars ?? (upstreamSessionId ? undefined : audit?.totalChars);
    const metadataTruncated = upstreamSessionId
      ? Boolean(auditSource?.truncated)
      : Boolean(audit?.sources.some((source) => source.truncated));
    const contentTruncated = content ? TRUNCATION_MARKER_PATTERN.test(content) : false;
    const freshness = content
      ? selectAnalyzedBlock(content, upstreamSessionId).freshness
      : "not-recorded";
    contextEntries.push({
      turnNumber,
      timestamp: entry.timestamp,
      referencedSessionIds: [...referenced],
      freshness,
      injectedChars,
      truncated: contentTruncated || metadataTruncated,
      basis: content ? "content" : "metadata",
      analyzed: false,
    });
  });
  // The latest entry referencing the upstream drives the judgments.
  const analyzedEntry = [...contextEntries]
    .reverse()
    .find((candidate) => referencedUpstream(candidate, upstreamSessionId));
  if (analyzedEntry) analyzedEntry.analyzed = true;
  return { contextEntries, analyzedEntry };
}

function referencedUpstream(
  entry: HandoffContextEntrySummary,
  upstreamSessionId: string | undefined,
): boolean {
  return upstreamSessionId ? entry.referencedSessionIds.includes(upstreamSessionId) : true;
}

function buildReport(
  grade: HandoffGrade,
  sections: HandoffSectionJudgment[],
  contextEntries: HandoffContextEntrySummary[],
  analyzedEntry: HandoffContextEntrySummary | undefined,
): HandoffReport {
  return {
    grade,
    sections,
    missingKeys: sections.filter((s) => s.state === "missing").map((s) => s.section),
    truncatedKeys: sections.filter((s) => s.state === "truncated").map((s) => s.section),
    preservedSections: sections.filter((s) => s.state === "preserved").map((s) => s.section),
    contextEntries,
    analyzedEntry,
  };
}

/** Compact human-readable summary of a {@link HandoffReport}. */
export function formatHandoffSummary(report: HandoffReport): string {
  const keysOf = (state: HandoffSectionState) =>
    report.sections.filter((section) => section.state === state).map((section) => section.section);
  const listOrNone = (keys: HandoffSection[]) => (keys.length ? keys.join(", ") : "none");
  const lines = [
    `Handoff fidelity grade: ${report.grade}`,
    `Preserved: ${listOrNone(keysOf("preserved"))} | Truncated: ${listOrNone(keysOf("truncated"))} | ` +
      `Missing: ${listOrNone(keysOf("missing"))}` +
      (keysOf("not-applicable").length
        ? ` | Not applicable: ${keysOf("not-applicable").join(", ")}`
        : ""),
  ];
  const analyzed = report.analyzedEntry;
  if (analyzed) {
    lines.push(
      `Analyzed context entry: downstream turn ${analyzed.turnNumber} | freshness ${analyzed.freshness} | ` +
        `basis ${analyzed.basis} | injected chars: ${analyzed.injectedChars ?? "unrecorded"} | ` +
        `truncation marker: ${analyzed.truncated ? "yes" : "no"} | ` +
        `context records in downstream session: ${report.contextEntries.length}`,
    );
  } else {
    lines.push(
      "Analyzed context entry: none — the downstream session records no context injection (grade lost).",
    );
  }
  return lines.join("\n");
}
