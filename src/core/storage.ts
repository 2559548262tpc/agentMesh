import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

/**
 * M6 unified data layer: ONE owner for agentmesh-home resolution and the
 * typed file primitives every store (sessions, registry, metrics, findings,
 * health, workflows, checkpoints, capabilities) builds on.
 *
 * Storage decision (ROADMAP_v0.4 M6): persistence stays on the existing
 * byte-compatible file formats (sessions.json, *.jsonl, checkpoints/) —
 * node:sqlite is flagless only from Node 22.13 and still experimental
 * (stability 1.1), and a storage engine would force a data migration the
 * compatibility contract forbids. The structural value lives here: every
 * module resolves paths and writes files through this service, so a store can
 * never disagree with the panel about WHERE the data lives, and every
 * successful write emits a change record ({store, path}) that in-process
 * consumers (UI/SSE) can subscribe to instead of watching files.
 */

/** Logical store a file belongs to; carried on every change event. */
export type StorageStoreName =
  | "sessions"
  | "tasks"
  | "metrics"
  | "findings"
  | "health"
  | "workflows"
  | "checkpoints"
  | "contexts"
  | "capabilities";

/** Emitted after every successful write through a StorageService. */
export interface StorageChangeRecord {
  store: StorageStoreName;
  /** Absolute path of the file that was written. */
  path: string;
}

export type StorageChangeListener = (record: StorageChangeRecord) => void;

interface StorageWriteMeta {
  store: StorageStoreName;
}

export type StorageAppendOptions = StorageWriteMeta;

export interface StoragePlainWriteOptions extends StorageWriteMeta {
  /** File mode applied at creation (POSIX; ignored on Windows). */
  mode?: number;
  /** Open flag; defaults to "w" (truncate/create). */
  flag?: "a" | "w";
}

export interface StorageAtomicWriteOptions extends StorageWriteMeta {
  /** File mode applied at temp-file creation (POSIX; ignored on Windows). */
  mode?: number;
  /** Temp-file open flag; "wx" fails when the unique temp path exists. */
  tempFlag?: "w" | "wx";
  /**
   * Data fsync of the temp file before the rename publish (default true).
   * Opt out only for best-effort artifacts whose contract is rename
   * atomicity rather than power-loss durability — the fsync sits inside the
   * publish window and measurably delays visibility for readers that race
   * the write.
   */
  fsync?: boolean;
}

export interface StorageJsonWriteOptions extends StorageWriteMeta {
  /** JSON indent spaces; defaults to 2 (the persisted-store convention). */
  indent?: number;
  /** Appends a trailing newline after the JSON document (capabilities.json). */
  trailingNewline?: boolean;
  /** File mode applied at temp-file creation (POSIX; ignored on Windows). */
  mode?: number;
}

// ---------------------------------------------------------------------------
// Canonical file layout of the agentmesh home (single source of truth).
// ---------------------------------------------------------------------------

export function homeSessionsFilePath(homeDir: string): string {
  return path.join(homeDir, "sessions.json");
}

export function homeMetricsFilePath(homeDir: string): string {
  return path.join(homeDir, "metrics.jsonl");
}

export function homeFindingsFilePath(homeDir: string): string {
  return path.join(homeDir, "findings.jsonl");
}

export function homeHealthFilePath(homeDir: string): string {
  return path.join(homeDir, "health.jsonl");
}

export function homeWorkflowsFilePath(homeDir: string): string {
  return path.join(homeDir, "workflows.jsonl");
}

export function homeTasksDirectory(homeDir: string): string {
  return path.join(homeDir, "tasks");
}

export function taskRegistryFilePath(homeDir: string): string {
  return path.join(homeDir, "tasks", "registry.jsonl");
}

export function taskOutputFilePath(homeDir: string, taskId: string): string {
  return path.join(homeDir, "tasks", `${taskId}.output`);
}

export function taskResultFilePath(homeDir: string, taskId: string): string {
  return path.join(homeDir, "tasks", `${taskId}.result.json`);
}

export function homeCheckpointsDirectory(homeDir: string): string {
  return path.join(homeDir, "checkpoints");
}

export function homeContextsDirectory(homeDir: string): string {
  return path.join(homeDir, "contexts");
}

// ---------------------------------------------------------------------------
// Home resolution (absorbed from session.ts; re-exported there for compat).
// ---------------------------------------------------------------------------

/**
 * Resolves the effective sessions storage path. `AGENTMESH_SESSIONS_FILE`
 * relocates the whole agentmesh home (every store and the panel derive their
 * root from this single environment input — the r21 "panel read the wrong
 * directory" bug class is structurally impossible when everyone resolves
 * through here).
 */
export function resolveSessionStoragePath(): string {
  return (
    process.env.AGENTMESH_SESSIONS_FILE || path.join(os.homedir(), ".agentmesh", "sessions.json")
  );
}

/** Resolves the AgentMesh home directory (parent of sessions.json). */
export function resolveAgentMeshHome(): string {
  return path.dirname(resolveSessionStoragePath());
}

function isMissingPathError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * StorageService: resolution binding plus the typed read/write primitives all
 * stores use. Extends EventEmitter and emits `"change"` with a
 * StorageChangeRecord after every successful write; a faulty subscriber never
 * breaks the write (same isolation rule as the AgentMesh event bus).
 */
export class StorageService extends EventEmitter {
  private readonly explicitHomeDir?: string;
  private readonly explicitSessionsFile?: string;

  constructor(options: { homeDir?: string; sessionsFile?: string } = {}) {
    super();
    this.explicitHomeDir = options.homeDir;
    this.explicitSessionsFile = options.sessionsFile;
  }

  /** Sessions file path; explicit binding wins, otherwise the env/home resolver. */
  public resolveSessionsFile(): string {
    return this.explicitSessionsFile ?? resolveSessionStoragePath();
  }

  /** AgentMesh home directory; explicit binding wins, otherwise derived above. */
  public resolveHome(): string {
    return this.explicitHomeDir ?? path.dirname(this.resolveSessionsFile());
  }

  /** Subscribes to change events; returns the unsubscribe function. */
  public onChange(listener: StorageChangeListener): () => void {
    this.on("change", listener);
    return () => {
      this.off("change", listener);
    };
  }

  private emitChange(record: StorageChangeRecord): void {
    try {
      this.emit("change", record);
    } catch {
      // A faulty subscriber must never break the write (events.ts precedent).
    }
  }

  // -- directory + existence primitives -----------------------------------

  public ensureDirectory(directoryPath: string): void {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  public exists(targetPath: string): boolean {
    return fs.existsSync(targetPath);
  }

  /** Entry names of a directory (sorted); missing directory → []. */
  public listDirectory(directoryPath: string): string[] {
    try {
      return fs
        .readdirSync(directoryPath, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      if (isMissingPathError(err)) return [];
      throw err;
    }
  }

  // -- read primitives -----------------------------------------------------

  /** File text; ENOENT → undefined, other I/O errors propagate. */
  public readTextFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      if (isMissingPathError(err)) return undefined;
      throw err;
    }
  }

  /** Async twin of readTextFile. */
  public async readTextFileAsync(filePath: string): Promise<string | undefined> {
    try {
      return await fsp.readFile(filePath, "utf-8");
    } catch (err) {
      if (isMissingPathError(err)) return undefined;
      throw err;
    }
  }

  /** Parsed JSON; missing file or unparsable content → undefined. */
  public readJson(filePath: string): unknown {
    const raw = this.readTextFile(filePath);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  /** Non-blank lines of a text file; missing file → []. */
  public readLines(filePath: string): string[] {
    const raw = this.readTextFile(filePath);
    if (raw === undefined) return [];
    return raw.split("\n").filter((line) => line.trim().length > 0);
  }

  /**
   * JSONL reader with corrupt-line tolerance: `parseLine` narrows each line
   * and returns undefined for malformed input; corrupt lines are skipped and
   * reported through `onCorruptLine` (omit for the silent-skip convention used
   * by the task registry). Missing file → [].
   */
  public readJsonLines<T>(
    filePath: string,
    parseLine: (line: string) => T | undefined,
    onCorruptLine?: (filePath: string, line: string) => void,
  ): T[] {
    const records: T[] = [];
    for (const line of this.readLines(filePath)) {
      const parsed = parseLine(line);
      if (parsed !== undefined) {
        records.push(parsed);
      } else {
        onCorruptLine?.(filePath, line);
      }
    }
    return records;
  }

  // -- write primitives ----------------------------------------------------

  /** Appends one JSONL line (newline-terminated, fsynced) after ensuring the parent directory. */
  public appendLine(filePath: string, line: string, options: StorageAppendOptions): void {
    this.appendLines(filePath, [line], options);
  }

  /** Multi-line variant of appendLine: one open/append/fsync for the batch. */
  public appendLines(
    filePath: string,
    lines: readonly string[],
    options: StorageAppendOptions,
  ): void {
    if (lines.length === 0) return;
    this.ensureDirectory(path.dirname(filePath));
    const payload = lines.map((line) => `${line}\n`).join("");
    const fd = fs.openSync(filePath, "a");
    try {
      fs.writeFileSync(fd, payload, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.emitChange({ store: options.store, path: filePath });
  }

  /** Plain (non-atomic) text write for append-style artifacts and captures. */
  public writeFile(filePath: string, data: string, options: StoragePlainWriteOptions): void {
    this.ensureDirectory(path.dirname(filePath));
    fs.writeFileSync(filePath, data, {
      encoding: "utf-8",
      mode: options.mode,
      flag: options.flag ?? "w",
    });
    this.emitChange({ store: options.store, path: filePath });
  }

  /**
   * Atomic JSON document write (temp file + fsync + rename, with a copy
   * fallback for Windows rename locks). Byte shape: 2-space indent by
   * default, no trailing newline unless requested — the persisted-store
   * convention (sessions.json, checkpoint records, capabilities.json).
   */
  public writeJsonAtomic(filePath: string, value: unknown, options: StorageJsonWriteOptions): void {
    const indent = options.indent ?? 2;
    const text = JSON.stringify(value, null, indent) + (options.trailingNewline ? "\n" : "");
    this.writeFileAtomicSync(filePath, text, options);
  }

  /** Sync atomic text write (temp + fsync + rename with copy fallback). */
  public writeFileAtomicSync(
    filePath: string,
    data: string,
    options: StorageAtomicWriteOptions,
  ): void {
    this.ensureDirectory(path.dirname(filePath));
    const tempFile = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = fs.openSync(tempFile, options.tempFlag ?? "w", options.mode);
    try {
      fs.writeFileSync(fd, data, "utf-8");
      if (options.fsync !== false) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tempFile, filePath);
    } catch {
      // Windows rename can fail under concurrent readers; fall back to copy.
      fs.copyFileSync(tempFile, filePath);
      fs.unlinkSync(tempFile);
    }
    this.emitChange({ store: options.store, path: filePath });
  }

  /** Async atomic text write (temp + fsync + rename with copy fallback). */
  public async writeFileAtomicAsync(
    filePath: string,
    data: string,
    options: StorageAtomicWriteOptions,
  ): Promise<void> {
    this.ensureDirectory(path.dirname(filePath));
    const tempFile = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const handle = await fsp.open(tempFile, options.tempFlag ?? "w", options.mode);
    try {
      await handle.writeFile(data, "utf-8");
      if (options.fsync !== false) await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(tempFile, filePath);
    } catch {
      // Windows rename can fail under concurrent readers; fall back to copy.
      await fsp.copyFile(tempFile, filePath);
      await fsp.unlink(tempFile);
    }
    this.emitChange({ store: options.store, path: filePath });
  }
}

/**
 * Shared storage service: every core store resolves paths and writes through
 * this instance, so its change stream is the single in-process feed for UI
 * consumption.
 */
export const defaultStorage = new StorageService();
