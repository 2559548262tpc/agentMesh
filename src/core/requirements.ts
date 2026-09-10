import { z } from "zod";

/**
 * v0.5 Reconciliation Ledger — requirements.json (design §4.2).
 *
 * The structured requirement set every workflow row is reconciled against.
 * Batch 1: authored by hand (by the orchestrator); Batch 2 adds the aidee
 * distillation channel that produces the same file. `quote` MUST be a real
 * substring of the source document — the engine verifies this mechanically
 * (zero tokens) so a distilled entry can never cite a sentence that does not
 * exist. The substring check proves PROVENANCE ONLY, never EARS-rewrite
 * faithfulness; faithfulness is measured separately (leader sampling +
 * sampled-review escape rate, design §11).
 */

/** Canonical requirement id shape: R1..Rn (design §3 ①). */
export const REQUIREMENT_ID_PATTERN = /^R\d+$/;

/** The five EARS sentence modes (design §4.1). */
export const REQUIREMENT_KINDS = [
  "event-driven",
  "exception",
  "state-driven",
  "optional-feature",
  "unconditional",
] as const;

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

const RequirementItemSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(REQUIREMENT_ID_PATTERN, "requirement id must match R<number> (e.g. R3)"),
    /** EARS sentence; required when decidable, null for items routed to human ruling. */
    ears: z.string().trim().min(1).max(2_000).nullable(),
    kind: z.enum(REQUIREMENT_KINDS).nullable(),
    /** Verbatim source-document substring backing this item (provenance anchor). */
    quote: z.string().trim().min(1).max(2_000),
    /** false → the item cannot be machine-decided and lands in the ruling area. */
    decidable: z.boolean(),
  })
  .strict();

export const RequirementsFileSchema = z
  .object({
    /** Source document the quotes were taken from (path or title, as authored). */
    source: z.string().trim().min(1).max(1_000),
    items: z.array(RequirementItemSchema).min(1).max(500),
  })
  .strict();

export type RequirementItem = z.infer<typeof RequirementItemSchema>;
export type RequirementsFile = z.infer<typeof RequirementsFileSchema>;

export interface RequirementsParseResult {
  success: boolean;
  issues: string[];
  requirements?: RequirementsFile;
}

/** Structural cross-checks beyond the Zod shape (id uniqueness, EARS consistency). */
export function checkRequirementsConsistency(requirements: RequirementsFile): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const item of requirements.items) {
    if (seen.has(item.id)) {
      issues.push(`${item.id}: duplicate requirement id.`);
    }
    seen.add(item.id);
    if (item.decidable && (!item.ears || !item.kind)) {
      issues.push(
        `${item.id}: decidable:true requires both 'ears' and 'kind' (undecidable items must declare decidable:false).`,
      );
    }
    if (!item.decidable && item.kind !== null && item.ears === null) {
      issues.push(`${item.id}: 'kind' without 'ears' is not allowed for decidable:false items.`);
    }
    if (item.ears && item.kind) {
      const detected = detectEarsKind(item.ears);
      if (detected !== item.kind) {
        issues.push(
          `${item.id}: kind '${item.kind}' does not match the EARS sentence shape ` +
            `(detected '${detected ?? "none"}').`,
        );
      }
    }
  }
  return issues;
}

/** Parses and validates a raw requirements document (unknown JSON). */
export function parseRequirementsFile(input: unknown): RequirementsParseResult {
  const parsed = RequirementsFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const issues = checkRequirementsConsistency(parsed.data);
  if (issues.length > 0) return { success: false, issues };
  return { success: true, issues: [], requirements: parsed.data };
}

/**
 * Detects which of the five EARS modes a sentence uses (design §4.1):
 * WHEN → event-driven, IF → exception, WHILE → state-driven,
 * WHERE → optional-feature, plain SHALL → unconditional.
 * Keywords are matched case-sensitively at word boundaries — EARS keywords
 * are canonical English even when the sentence body is Chinese.
 */
export function detectEarsKind(ears: string): RequirementKind | undefined {
  if (/\bWHEN\b/.test(ears) && /\bTHEN\b/.test(ears) && /\bSHALL\b/.test(ears)) {
    return "event-driven";
  }
  if (/\bIF\b/.test(ears) && /\bTHEN\b/.test(ears) && /\bSHALL\b/.test(ears)) {
    return "exception";
  }
  if (/\bWHILE\b/.test(ears) && /\bSHALL\b/.test(ears)) return "state-driven";
  if (/\bWHERE\b/.test(ears) && /\bSHALL\b/.test(ears)) return "optional-feature";
  if (/\bSHALL\b/.test(ears)) return "unconditional";
  return undefined;
}

export interface QuoteVerificationReport {
  pass: boolean;
  items: Array<{
    id: string;
    /** quote is a real substring of the source document. */
    ok: boolean;
    detail: string;
  }>;
}

/**
 * Mechanical provenance check (zero tokens): every `quote` must be a verbatim
 * substring of the source document. This is the anti-fabrication gate for the
 * distillation channel — a distilled entry citing a sentence the document
 * does not contain fails closed here before any LLM sees it.
 */
export function verifyRequirementQuotes(
  sourceDocument: string,
  items: readonly Pick<RequirementItem, "id" | "quote">[],
): QuoteVerificationReport {
  const normalizedDocument = sourceDocument.replace(/\r\n/g, "\n");
  const reportItems = items.map((item) => {
    const normalizedQuote = item.quote.replace(/\r\n/g, "\n");
    const ok = normalizedDocument.includes(normalizedQuote);
    return {
      id: item.id,
      ok,
      detail: ok
        ? "quote found in source document"
        : "quote is NOT a verbatim substring of the source document (fabricated or paraphrased)",
    };
  });
  return { pass: reportItems.every((item) => item.ok), items: reportItems };
}

export interface CountCrossCheckReport {
  /** Requirement items in the file. */
  itemCount: number;
  /** Markdown-style section headers detected in the source document. */
  sectionCount: number;
  /** List entries (bullet or ordered) detected in the source document. */
  listItemCount: number;
  /**
   * Rough plausibility: the item count must not exceed the document's
   * section + list-entry count — a distillation that emits more items than
   * the document has structure points is likely merged or invented. Warning
   * level only (never fails a run by itself).
   */
  plausible: boolean;
}

/**
 * Logarithmic cross-check (design §3 ①对数粗核验): counts requirement items
 * against the source document's structural units (section headers and list
 * entries). Deliberately crude — it catches wholesale fabrication/merging,
 * not subtle paraphrase.
 */
export function crossCheckRequirementCount(
  sourceDocument: string,
  items: readonly RequirementItem[],
): CountCrossCheckReport {
  const lines = sourceDocument.split(/\r?\n/);
  let sectionCount = 0;
  let listItemCount = 0;
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) sectionCount += 1;
    else if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) listItemCount += 1;
  }
  const itemCount = items.length;
  return {
    itemCount,
    sectionCount,
    listItemCount,
    plausible: itemCount <= sectionCount + listItemCount,
  };
}
