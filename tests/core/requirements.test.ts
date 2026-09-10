import { describe, it, expect } from "vitest";
import {
  checkRequirementsConsistency,
  crossCheckRequirementCount,
  detectEarsKind,
  parseRequirementsFile,
  verifyRequirementQuotes,
  type RequirementsFile,
} from "../../src/core/requirements.js";

/**
 * v0.5 Batch 1 #2: requirements.json (EARS + quote + decidable) with the
 * mechanical provenance gate. The substring check is the anti-fabrication
 * boundary for the Batch 2 distillation channel — zero tokens, fail-closed.
 */

const DOC = `# Library Rules

## Borrowing
- Stock shortage blocks loans
- Invalid ISBN returns 422

## Accounts
WHILE a session is active, tokens renew automatically.
`;

const validFile: RequirementsFile = {
  source: "requirements-v3.md",
  items: [
    {
      id: "R1",
      ears: "WHEN loan count > stock THEN the system SHALL return 400 AND keep stock unchanged",
      kind: "event-driven",
      quote: "Stock shortage blocks loans",
      decidable: true,
    },
    {
      id: "R2",
      ears: null,
      kind: null,
      quote: "列表页要美观大方",
      decidable: false,
    },
  ],
};

describe("core/requirements (v0.5 requirements.json)", () => {
  it("parses a valid file and rejects unknown keys", () => {
    expect(parseRequirementsFile(validFile).success).toBe(true);

    const strict = parseRequirementsFile({ ...validFile, surprise: true });
    expect(strict.success).toBe(false);
  });

  it("enforces the R<number> id shape", () => {
    const broken = {
      ...validFile,
      items: [{ ...validFile.items[0]!, id: "REQ-1" }],
    };
    const result = parseRequirementsFile(broken);
    expect(result.success).toBe(false);
    expect(result.issues.join("\n")).toContain("R<number>");
  });

  it("requires ears and kind for decidable items", () => {
    const missingEars = parseRequirementsFile({
      ...validFile,
      items: [{ ...validFile.items[0]!, ears: null }],
    });
    expect(missingEars.success).toBe(false);
    expect(missingEars.issues.join("\n")).toContain("decidable:true requires both");
  });

  it("rejects duplicate ids", () => {
    const duplicated = {
      ...validFile,
      items: [validFile.items[0]!, { ...validFile.items[1]!, id: "R1" }],
    };
    expect(checkRequirementsConsistency(duplicated).join("\n")).toContain("duplicate");
  });

  it("checks kind against the EARS sentence shape", () => {
    const mismatched = {
      ...validFile,
      items: [{ ...validFile.items[0]!, kind: "unconditional" as const }],
    };
    const issues = checkRequirementsConsistency(mismatched);
    expect(issues.join("\n")).toContain("does not match the EARS sentence shape");
  });

  it("detects the five EARS modes", () => {
    expect(detectEarsKind("WHEN x THEN system SHALL y")).toBe("event-driven");
    expect(detectEarsKind("IF bad ISBN THEN system SHALL return 422")).toBe("exception");
    expect(detectEarsKind("WHILE active the system SHALL renew tokens")).toBe("state-driven");
    expect(detectEarsKind("WHERE MFA is on the system SHALL verify TOTP")).toBe("optional-feature");
    expect(detectEarsKind("The system SHALL store passwords with bcrypt")).toBe("unconditional");
    expect(detectEarsKind("美观大方")).toBeUndefined();
  });

  it("verifies quotes as verbatim substrings of the source document", () => {
    const report = verifyRequirementQuotes(DOC, validFile.items);
    expect(report.items[0]).toMatchObject({ id: "R1", ok: true });
    expect(report.items[1]).toMatchObject({ id: "R2", ok: false });
    expect(report.pass).toBe(false);
  });

  it("normalizes CRLF when matching quotes", () => {
    const crlfDoc = DOC.replace(/\n/g, "\r\n");
    const report = verifyRequirementQuotes(crlfDoc, [validFile.items[0]!]);
    expect(report.pass).toBe(true);
  });

  it("cross-checks the item count against document structure (warning level)", () => {
    const plausible = crossCheckRequirementCount(DOC, [validFile.items[0]!]);
    expect(plausible.plausible).toBe(true);

    const absurd = crossCheckRequirementCount(
      DOC,
      Array.from({ length: 40 }, (_, i) => ({
        id: `R${i + 1}`,
        ears: "The system SHALL x",
        kind: "unconditional" as const,
        quote: "x",
        decidable: true,
      })),
    );
    expect(absurd.plausible).toBe(false);
    expect(absurd.sectionCount).toBeGreaterThan(0);
    expect(absurd.listItemCount).toBeGreaterThan(0);
  });
});
