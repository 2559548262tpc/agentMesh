import * as crypto from "node:crypto";
import type { ReviewFinding } from "../agents/types.js";
import type { SessionHistoryEntry } from "./types.js";
import { defaultStorage, homeFindingsFilePath, resolveAgentMeshHome } from "./storage.js";

/**
 * M3 findings-value tracking: an append-only JSONL store of reviewer findings
 * (<agentmeshHome>/findings.jsonl) following the metrics.jsonl convention, so
 * reviewer precision becomes measurable and repeated defect categories can be
 * graduated into machine checks. Records are appended by the review_changes
 * MCP handler from the machine-parsed findings it already surfaces; the
 * bounded rework loop closes the confirmation seam (FAIL → fix → PASS marks
 * the trigger findings confirmed).
 */

export type FindingKind = "defect" | "style" | "risk" | "security" | "semantic";

export const FINDING_KINDS: readonly FindingKind[] = [
  "defect",
  "style",
  "risk",
  "security",
  "semantic",
];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * One append-only findings.jsonl line. `severity` keeps the parsed
 * critical/high/medium/low labels (the P0-P3 rubric mapping). `confirmed` is
 * written when a reliable closure signal exists and stays absent otherwise.
 */
export interface FindingRecord {
  findingId: string;
  sessionId: string;
  taskId?: string;
  reviewerAgent: string;
  category: string;
  kind: FindingKind;
  severity: FindingSeverity;
  file: string;
  line?: number | string;
  reviewedAt: string;
  confirmed?: boolean;
  evidence?: string;
}

/** Per-reviewer precision aggregate (M3 acceptance: reviewer value in numbers). */
export interface ReviewerFindingsPrecision {
  reviewerAgent: string;
  /** Distinct findings attributed to this reviewer. */
  total: number;
  confirmed: number;
  rejected: number;
  /** confirmed / (confirmed + rejected); 0 when no finding was confirmed or rejected yet. */
  precision: number;
}

export type GraduationCheck = "eslint-rule" | "acceptance-script";

/** A repeated defect category proposed for graduation into a machine check. */
export interface GraduationProposal {
  category: string;
  count: number;
  sampleFindingIds: string[];
  suggestedCheck: GraduationCheck;
}

/** Categories a custom ESLint rule can realistically enforce. */
const LINTABLE_CATEGORIES: readonly string[] = ["style", "type-safety", "documentation"];

/** First line of every buildReworkFixPrompt prompt (P5 bounded rework loop). */
export const REWORK_PROMPT_MARKER = "# REWORK ROUND";

/** Resolves the findings JSONL path exactly like the metrics file resolution. */
export function resolveFindingsFilePath(homeDir?: string): string {
  return homeFindingsFilePath(homeDir ?? resolveAgentMeshHome());
}

/**
 * Appends findings records as JSONL lines (one batched append through the
 * shared StorageService). Best-effort by design (same boundary as task
 * metrics): an I/O failure warns on stderr and returns false instead of
 * failing the review that produced the findings.
 */
export function appendFindings(
  records: readonly FindingRecord[],
  options: { homeDir?: string } = {},
): boolean {
  if (records.length === 0) return true;
  const filePath = resolveFindingsFilePath(options.homeDir);
  try {
    defaultStorage.appendLines(
      filePath,
      records.map((record) => JSON.stringify(record)),
      { store: "findings" },
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`AgentMesh findings could not be appended to '${filePath}': ${message}\n`);
    return false;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

function optionalLine(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return optionalString(value);
}

/**
 * Narrows one raw JSONL line into a FindingRecord. Returns undefined for
 * malformed lines: a required field missing/invalid, an out-of-union
 * kind/severity, or a non-boolean confirmed value. Corrupt lines are skipped
 * by the caller, never fatal.
 */
function parseFindingRecordLine(lineText: string): FindingRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(lineText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const findingId = optionalString(candidate.findingId);
    const sessionId = optionalString(candidate.sessionId);
    const reviewerAgent = optionalString(candidate.reviewerAgent);
    const category = optionalString(candidate.category);
    const severity = FINDING_SEVERITIES.find(
      (candidateSeverity) => candidateSeverity === candidate.severity,
    );
    const kind = FINDING_KINDS.find((candidateKind) => candidateKind === candidate.kind);
    const file = optionalString(candidate.file);
    const reviewedAt = optionalIsoTimestamp(candidate.reviewedAt);
    if (
      !findingId ||
      !sessionId ||
      !reviewerAgent ||
      !category ||
      !severity ||
      !kind ||
      !file ||
      !reviewedAt
    ) {
      return undefined;
    }
    if (candidate.confirmed !== undefined && typeof candidate.confirmed !== "boolean") {
      return undefined;
    }
    const confirmed: boolean | undefined = candidate.confirmed;
    const taskId = optionalString(candidate.taskId);
    const evidence = optionalString(candidate.evidence);
    const line = optionalLine(candidate.line);
    return {
      findingId,
      sessionId,
      ...(taskId !== undefined ? { taskId } : {}),
      reviewerAgent,
      category,
      kind,
      severity,
      file,
      ...(line !== undefined ? { line } : {}),
      reviewedAt,
      confirmed,
      ...(evidence !== undefined ? { evidence } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads all persisted findings records (through the shared StorageService).
 * Missing file → empty (cold start); any read failure → empty; corrupt lines
 * are skipped fail-closed with a stderr warning, mirroring the metrics store
 * convention.
 */
export function readFindings(
  options: { homeDir?: string; filePath?: string } = {},
): FindingRecord[] {
  const filePath = options.filePath ?? resolveFindingsFilePath(options.homeDir);
  try {
    return defaultStorage.readJsonLines(filePath, parseFindingRecordLine, (corruptPath) => {
      process.stderr.write(
        `AgentMesh findings '${corruptPath}' contains a corrupt line; it was skipped.\n`,
      );
    });
  } catch {
    return [];
  }
}

/**
 * Marks findings confirmed (true = real defect, false = false positive) by
 * appending a confirmation record per matching findingId; readers reconcile
 * by latest-record-wins. Findings without a matching findingId are skipped.
 * Returns the number of confirmation records appended (0 on store failure).
 */
export function confirmFindings(
  findingIds: readonly string[],
  confirmed: boolean,
  options: { homeDir?: string; evidence?: string } = {},
): number {
  const latestById = new Map<string, FindingRecord>();
  for (const record of readFindings(options)) {
    latestById.set(record.findingId, record);
  }
  const updates: FindingRecord[] = [];
  for (const findingId of findingIds) {
    const existing = latestById.get(findingId);
    if (!existing) continue;
    updates.push({
      ...existing,
      confirmed,
      ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
    });
  }
  if (updates.length === 0) return 0;
  return appendFindings(updates, options) ? updates.length : 0;
}

/**
 * Aggregates reviewer precision from findings records. The latest record per
 * findingId decides its confirmation state and reviewer attribution, so
 * appended confirmation records supersede the original lines. Pure function;
 * callers read the store first (mirrors aggregateTaskMetrics).
 */
export function aggregateFindingsPrecision(
  records: readonly FindingRecord[],
): ReviewerFindingsPrecision[] {
  const latestById = new Map<string, FindingRecord>();
  for (const record of records) {
    latestById.set(record.findingId, record);
  }
  interface PrecisionAccumulator {
    total: number;
    confirmed: number;
    rejected: number;
  }
  const groups = new Map<string, PrecisionAccumulator>();
  for (const record of latestById.values()) {
    const group = groups.get(record.reviewerAgent) ?? { total: 0, confirmed: 0, rejected: 0 };
    group.total += 1;
    if (record.confirmed === true) group.confirmed += 1;
    else if (record.confirmed === false) group.rejected += 1;
    groups.set(record.reviewerAgent, group);
  }
  return [...groups.entries()]
    .map(([reviewerAgent, group]) => ({
      reviewerAgent,
      total: group.total,
      confirmed: group.confirmed,
      rejected: group.rejected,
      precision:
        group.confirmed + group.rejected === 0
          ? 0
          : group.confirmed / (group.confirmed + group.rejected),
    }))
    .sort((a, b) => b.total - a.total || a.reviewerAgent.localeCompare(b.reviewerAgent));
}

/**
 * Groups distinct findings by category and proposes graduation for every
 * category reaching minCount occurrences. Pure function, no file writes; a
 * lintable category suggests an ESLint rule, everything else an acceptance
 * script (ROADMAP_v0.4 M3 findings graduation).
 */
export function proposeGraduations(
  records: readonly FindingRecord[],
  minCount: number,
): GraduationProposal[] {
  const categoriesById = new Map<string, string>();
  const countByCategory = new Map<string, number>();
  for (const record of records) {
    if (!categoriesById.has(record.findingId)) {
      categoriesById.set(record.findingId, record.category);
      countByCategory.set(record.category, (countByCategory.get(record.category) ?? 0) + 1);
    }
  }
  const proposals: GraduationProposal[] = [];
  for (const [category, count] of countByCategory) {
    if (count < Math.max(minCount, 1)) continue;
    const sampleFindingIds = [...categoriesById.entries()]
      .filter(([, findingCategory]) => findingCategory === category)
      .slice(0, 5)
      .map(([findingId]) => findingId);
    proposals.push({
      category,
      count,
      sampleFindingIds,
      suggestedCheck: LINTABLE_CATEGORIES.includes(category) ? "eslint-rule" : "acceptance-script",
    });
  }
  return proposals.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Classifies the finding kind. Priority: category keywords first (the
 * reviewer's domain tag is the most specific signal and resolves a kind tag
 * that contradicts the category), then an explicit reviewer tag that is a
 * valid taxonomy value, then issue text keywords, defaulting to `defect` when
 * nothing is inferable.
 */
export function classifyFindingKind(input: {
  category?: string;
  issue?: string;
  suggestion?: string;
  kind?: string;
}): FindingKind {
  const category = (input.category ?? "").toLowerCase();
  if (/style|format|naming|lint/.test(category)) return "style";
  if (/security|credential/.test(category)) return "security";
  if (/semantic|architecture|design|contract/.test(category)) return "semantic";
  if (/risk|compat|regression/.test(category)) return "risk";
  const explicitKind = optionalString(input.kind)?.trim().toLowerCase();
  if (explicitKind && FINDING_KINDS.includes(explicitKind as FindingKind)) {
    return explicitKind as FindingKind;
  }
  const text = `${input.issue ?? ""}\n${input.suggestion ?? ""}`.toLowerCase();
  if (/security|credential|injection|xss|csrf|vulnerab|secret|sanitiz/.test(text)) {
    return "security";
  }
  if (/style|formatting|naming|lint|indentation|whitespace|typo/.test(text)) return "style";
  if (/architecture|semantic|abstraction|design|contract/.test(text)) return "semantic";
  if (/risk|fragile|deprecated|compatib|might break|could break/.test(text)) return "risk";
  return "defect";
}

/** Keyword buckets for category derivation; first match wins. */
const CATEGORY_KEYWORDS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  {
    category: "security",
    pattern: /security|credential|injection|xss|csrf|vulnerab|secret|sanitiz|token leak/,
  },
  { category: "testing", pattern: /test|coverage|assert|flaky|suite/ },
  {
    category: "error-handling",
    pattern: /unhandled|error handling|try\/catch|exception|error path|error message|throw/,
  },
  { category: "performance", pattern: /performance|memory leak|slow|hot path|n\+1|cache/ },
  {
    category: "type-safety",
    pattern: /type-safety|type safety|typescript|type error|unsafe cast|: any|type violation/,
  },
  { category: "documentation", pattern: /documentation|readme|docstring|jsdoc|comment/ },
  {
    category: "style",
    pattern: /style|formatting|naming|lint|indentation|whitespace|typo|trailing/,
  },
];

/**
 * Derives the finding category. An explicit reviewer tag wins (normalized to
 * a lowercase tag); otherwise the issue/suggestion/file text is matched
 * against fixed keyword buckets, defaulting to `general`.
 */
export function deriveFindingCategory(input: {
  category?: string;
  issue?: string;
  suggestion?: string;
  file?: string;
}): string {
  const explicit = optionalString(input.category)?.toLowerCase();
  if (explicit) return explicit;
  const text = `${input.issue ?? ""}\n${input.suggestion ?? ""}\n${input.file ?? ""}`.toLowerCase();
  for (const bucket of CATEGORY_KEYWORDS) {
    if (bucket.pattern.test(text)) return bucket.category;
  }
  return "general";
}

/** Deterministic content hash identifying a finding across reviews. */
export function buildFindingId(parts: {
  category: string;
  kind: FindingKind;
  severity: string;
  file: string;
  line?: number | string;
  issue: string;
}): string {
  const canonical = JSON.stringify([
    parts.category,
    parts.kind,
    parts.severity,
    parts.file,
    parts.line ?? null,
    parts.issue,
  ]);
  return `fnd_${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

export interface EnrichedReviewFinding extends ReviewFinding {
  id: string;
  category: string;
  kind: FindingKind;
}

/**
 * Recovers the reviewer's `category:` / `kind:` tags from the issue/suggestion
 * text (the structured-finding parser folds those lines into the nearest
 * labeled field) and strips them so the free-text fields stay clean. Returns
 * undefined-valued tags when the reviewer omitted them.
 */
function extractFindingTags(finding: ReviewFinding): {
  issue: string;
  suggestion?: string;
  category?: string;
  kind?: string;
} {
  let category: string | undefined;
  let kind: string | undefined;
  const strip = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    const kept: string[] = [];
    for (const rawLine of text.split("\n")) {
      const categoryMatch = rawLine.match(/^\s*category\s*:\s*(.+)$/i);
      const kindMatch = rawLine.match(/^\s*kind\s*:\s*(.+)$/i);
      if (categoryMatch && category === undefined) {
        category = categoryMatch[1]!.trim();
        continue;
      }
      if (kindMatch && kind === undefined) {
        kind = kindMatch[1]!.trim();
        continue;
      }
      kept.push(rawLine);
    }
    const cleaned = kept.join("\n").trim();
    return cleaned.length > 0 ? cleaned : undefined;
  };
  const issue = strip(finding.issue) ?? finding.issue;
  const suggestion = strip(finding.suggestion);
  return {
    issue,
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
}

/**
 * Normalizes one machine-parsed review finding to the M3 enriched shape:
 * adds a deterministic id, a category and a taxonomy kind while keeping every
 * existing field (severity/file/line/issue/suggestion) unchanged. Pure and
 * exported for direct testing.
 */
export function enrichReviewFinding(finding: ReviewFinding): EnrichedReviewFinding {
  const {
    issue,
    suggestion,
    category: taggedCategory,
    kind: taggedKind,
  } = extractFindingTags(finding);
  const category = deriveFindingCategory({
    category: taggedCategory,
    issue,
    suggestion,
    file: finding.file,
  });
  const kind = classifyFindingKind({ category, issue, suggestion, kind: taggedKind });
  return {
    ...finding,
    issue,
    ...(suggestion !== undefined ? { suggestion } : {}),
    id: buildFindingId({
      category,
      kind,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      issue,
    }),
    category,
    kind,
  };
}

/** Splits a `file:line` location rendered by buildReworkFixPrompt. */
function splitFileAndLine(location: string): { file: string; line?: number | string } {
  const withLine = location.match(/^(.*):(\d+(?:\s*[-–]\s*\d+)?)$/);
  if (withLine) {
    return { file: withLine[1]!.trim(), line: withLine[2]!.trim() };
  }
  return { file: location };
}

/**
 * Re-parses the findings embedded in one buildReworkFixPrompt prompt (the only
 * place the FAIL-round findings survive the in-runner rework loop). Pure and
 * format-synced through tests that generate prompts with the real builder;
 * returns [] for prompts without the findings section or with format drift,
 * which leaves confirmations honestly undefined.
 */
export function parseReworkFindingsFromPrompt(promptText: string): ReviewFinding[] {
  const headerIndex = promptText.indexOf(REWORK_PROMPT_MARKER);
  if (headerIndex < 0) return [];
  const sectionHeader = "## Reviewer Findings (must all be resolved)";
  const sectionStart = promptText.indexOf(sectionHeader, headerIndex);
  if (sectionStart < 0) return [];
  const bodyStart = sectionStart + sectionHeader.length;
  const nextSection = promptText.indexOf("\n## ", bodyStart);
  const section = promptText.slice(bodyStart, nextSection < 0 ? undefined : nextSection);
  const findings: ReviewFinding[] = [];
  let current: ReviewFinding | undefined;
  for (const line of section.split("\n")) {
    const entryMatch = line.match(
      /^\s*\d+\.\s*\[(critical|high|medium|low)\]\s*(.+?)\s+[—–-]\s+(.+)$/,
    );
    if (entryMatch) {
      const severity = entryMatch[1] as FindingSeverity;
      const location = splitFileAndLine(entryMatch[2]!.trim());
      current = {
        severity,
        file: location.file,
        ...(location.line !== undefined ? { line: location.line } : {}),
        issue: entryMatch[3]!.trim(),
      };
      findings.push(current);
      continue;
    }
    const suggestionMatch = line.match(/^\s+Fix suggestion:\s*(.+)$/i);
    if (suggestionMatch && current) {
      current.suggestion = suggestionMatch[1]!.trim();
    }
  }
  return findings;
}

export interface ReworkClosureFinding {
  finding: ReviewFinding;
  /** Rework round parsed from the prompt header (0 when unparsable). */
  round: number;
  /**
   * Whether the fix turn changed the repository (fingerprint comparison).
   * undefined = no reliable signal (missing/root-mismatching evidence).
   */
  changedRepository: boolean | undefined;
  /** Timestamp of the rework fix turn; closest available reviewedAt bound. */
  reviewedAt?: string;
}

function repositoryChangedDuringTurn(
  evidence: SessionHistoryEntry["evidence"],
): boolean | undefined {
  const before = evidence?.repositoryBefore;
  const after = evidence?.repositoryAfter;
  if (!before || !after || before.repositoryRoot !== after.repositoryRoot) return undefined;
  return before.fingerprint !== after.fingerprint;
}

/**
 * Extracts the findings that triggered the last `rounds` rework fix turns from
 * a worker session history, together with the repository-change signal needed
 * to close their confirmation when the rework ends in PASS: a fix that changed
 * the repository confirms the findings (true), a no-op fix that still led to a
 * PASS marks them false positives (false), a missing signal stays undefined.
 * Pure function over the history entries.
 */
export function collectReworkClosureFindings(
  history: ReadonlyArray<SessionHistoryEntry>,
  rounds: number,
): ReworkClosureFinding[] {
  if (rounds <= 0) return [];
  const reworkTurns = history
    .filter((turn) => turn.task.startsWith(REWORK_PROMPT_MARKER))
    .slice(-rounds);
  const closures: ReworkClosureFinding[] = [];
  for (const turn of reworkTurns) {
    const parsed = parseReworkFindingsFromPrompt(turn.task);
    if (parsed.length === 0) continue;
    const round = Number(turn.task.match(/^# REWORK ROUND (\d+)/)?.[1] ?? 0);
    const changedRepository = repositoryChangedDuringTurn(turn.evidence);
    for (const finding of parsed) {
      closures.push({
        finding,
        round,
        changedRepository,
        ...(turn.timestamp !== undefined ? { reviewedAt: turn.timestamp } : {}),
      });
    }
  }
  return closures;
}
