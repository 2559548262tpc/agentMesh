import { describe, it, expect } from "vitest";
import { verifyContractMap } from "../../src/core/contractMap.js";
import type { ContractItem, ContractMapEntry } from "../../src/core/contractMap.js";

describe("core/contractMap verifyContractMap", () => {
  const contractItems: ContractItem[] = [
    { id: "C1", text: "The login form validates empty input" },
    { id: "C2", text: "The session cookie is marked HttpOnly" },
    { id: "C3", text: "Tests cover the locked-account path" },
  ];

  function files(filesByPath: Record<string, string>) {
    return (filePath: string): string => {
      const content = filesByPath[filePath];
      if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
      return content;
    };
  }

  it("passes when every contract item maps to a non-empty line within bounds", () => {
    const map: ContractMapEntry[] = [
      { id: "C1", file: "src/login.ts", line: 3 },
      { id: "C2", file: "src/session.ts", line: 1 },
      { id: "C3", file: "tests/login.test.ts", line: 10 },
    ];
    const report = verifyContractMap(
      contractItems,
      map,
      files({
        "src/login.ts": "import { z } from 'zod';\n\nexport const validateInput = () => true;\n",
        "src/session.ts": "response.cookie('sid', token, { httpOnly: true });",
        "tests/login.test.ts": `${"it('locked', () => {});\n".repeat(9)}it('covers locked account path', () => {});\n`,
      }),
    );
    expect(report.pass).toBe(true);
    expect(report.items).toHaveLength(3);
    expect(report.items.map((item) => item.status)).toEqual(["ok", "ok", "ok"]);
    expect(report.items[0]!.detail).toBe("src/login.ts:3");
  });

  it("reports missing for unreadable files and unmapped items, failing the verdict", () => {
    const map: ContractMapEntry[] = [{ id: "C1", file: "src/absent.ts", line: 1 }];
    const report = verifyContractMap(contractItems, map, files({}));
    expect(report.pass).toBe(false);
    expect(report.items[0]).toMatchObject({ id: "C1", status: "missing" });
    expect(report.items[0]?.detail).toContain("File not readable");
    expect(report.items[1]).toMatchObject({ id: "C2", status: "missing" });
    expect(report.items[2]).toMatchObject({ id: "C3", status: "missing" });
  });

  it("reports out-of-bounds lines including zero, negative, and non-integer input", () => {
    const content = "only line\n";
    const map: ContractMapEntry[] = [
      { id: "C1", file: "src/a.ts", line: 5 },
      { id: "C2", file: "src/a.ts", line: 0 },
      { id: "C3", file: "src/a.ts", line: -2 },
    ];
    const report = verifyContractMap(contractItems, map, files({ "src/a.ts": content }));
    expect(report.pass).toBe(false);
    expect(report.items[0]!.status).toBe("out-of-bounds");
    expect(report.items[1]!.status).toBe("out-of-bounds");
    expect(report.items[2]!.status).toBe("out-of-bounds");
    // Non-integer lines are schema-rejected at the MCP boundary; the pure
    // function still classifies them defensively.
    const fractional = verifyContractMap(
      [contractItems[0]!],
      [{ id: "C1", file: "src/a.ts", line: 1.5 }],
      files({ "src/a.ts": content }),
    );
    expect(fractional.items[0]!.status).toBe("out-of-bounds");
  });

  it("reports empty for blank mapped lines", () => {
    const map: ContractMapEntry[] = [{ id: "C2", file: "src/blank.ts", line: 2 }];
    const report = verifyContractMap(
      [contractItems[1]!],
      map,
      files({ "src/blank.ts": "const a = 1;\n   \nconst b = 2;\n" }),
    );
    expect(report.pass).toBe(false);
    expect(report.items[0]).toMatchObject({
      id: "C2",
      status: "empty",
      detail: "Line 2 in src/blank.ts is blank",
    });
  });

  it("reports unknown-item for entries that are not contract items and fails the verdict", () => {
    const map: ContractMapEntry[] = [
      { id: "C1", file: "src/login.ts", line: 1 },
      { id: "CX", file: "src/extra.ts", line: 1 },
    ];
    const report = verifyContractMap(
      [contractItems[0]!],
      map,
      files({ "src/login.ts": "ok", "src/extra.ts": "ok" }),
    );
    expect(report.pass).toBe(false);
    expect(report.items).toHaveLength(2);
    expect(report.items[1]).toMatchObject({ id: "CX", status: "unknown-item" });
  });

  it("resolves duplicate entries for one item last-wins", () => {
    const map: ContractMapEntry[] = [
      { id: "C1", file: "src/absent.ts", line: 1 },
      { id: "C1", file: "src/login.ts", line: 1 },
    ];
    const report = verifyContractMap([contractItems[0]!], map, files({ "src/login.ts": "ok" }));
    expect(report.pass).toBe(true);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ id: "C1", status: "ok", detail: "src/login.ts:1" });
  });

  it("treats empty contract input as trivially passing", () => {
    const report = verifyContractMap([], [], files({}));
    expect(report).toEqual({ pass: true, items: [] });
  });
});
