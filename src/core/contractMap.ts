/**
 * M3 quick-review automation: a worker delivering against a contract checklist
 * must provide a contract map (contract item id -> file:line). This module
 * machine-verifies the map without spending LLM tokens — every mapped file
 * must exist, the line must be within bounds, and the line must be non-empty.
 * It replaces the first (mechanical) pass of the former two-stage review; the
 * LLM reviewer keeps only the deep dimensions.
 */

export interface ContractItem {
  id: string;
  text: string;
}

export interface ContractMapEntry {
  id: string;
  file: string;
  line: number;
}

export type ContractMapItemStatus = "ok" | "missing" | "out-of-bounds" | "empty" | "unknown-item";

export interface ContractMapItemReport {
  id: string;
  status: ContractMapItemStatus;
  detail?: string;
}

export interface ContractMapReport {
  pass: boolean;
  items: ContractMapItemReport[];
}

/**
 * Verifies a worker-delivered contract map against the contract checklist.
 * `readFile` returns the file content and is expected to throw when the file
 * cannot be read (the failure is normalized to the `missing` status, keeping
 * the function pure and I/O-free). Duplicate entries for one item resolve
 * last-wins. Items without any entry report `missing`; entries whose id is
 * not a contract item report `unknown-item` and fail the overall verdict.
 * Pure function: returns per-item statuses plus an overall pass/fail.
 */
export function verifyContractMap(
  contractItems: readonly ContractItem[],
  mapEntries: readonly ContractMapEntry[],
  readFile: (filePath: string) => string,
): ContractMapReport {
  const itemIds = new Set(contractItems.map((item) => item.id));
  const statuses = new Map<string, ContractMapItemReport>();
  for (const entry of mapEntries) {
    if (!itemIds.has(entry.id)) {
      statuses.set(entry.id, {
        id: entry.id,
        status: "unknown-item",
        detail: `Mapped id '${entry.id}' is not a contract item`,
      });
      continue;
    }
    let content: string;
    try {
      content = readFile(entry.file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      statuses.set(entry.id, {
        id: entry.id,
        status: "missing",
        detail: `File not readable: ${entry.file} (${reason})`,
      });
      continue;
    }
    const lines = content.split("\n");
    if (!Number.isInteger(entry.line) || entry.line < 1 || entry.line > lines.length) {
      statuses.set(entry.id, {
        id: entry.id,
        status: "out-of-bounds",
        detail: `Line ${entry.line} is outside 1..${lines.length} of ${entry.file}`,
      });
      continue;
    }
    const lineText = lines[entry.line - 1]?.trim() ?? "";
    if (!lineText) {
      statuses.set(entry.id, {
        id: entry.id,
        status: "empty",
        detail: `Line ${entry.line} in ${entry.file} is blank`,
      });
      continue;
    }
    statuses.set(entry.id, {
      id: entry.id,
      status: "ok",
      detail: `${entry.file}:${entry.line}`,
    });
  }
  const items: ContractMapItemReport[] = contractItems.map(
    (item) =>
      statuses.get(item.id) ?? {
        id: item.id,
        status: "missing",
        detail: "No map entry delivered for this contract item",
      },
  );
  for (const [id, report] of statuses) {
    if (!itemIds.has(id)) items.push(report);
  }
  return { pass: items.every((item) => item.status === "ok"), items };
}
