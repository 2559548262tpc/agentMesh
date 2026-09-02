import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageService,
  defaultStorage,
  homeCheckpointsDirectory,
  homeContextsDirectory,
  homeFindingsFilePath,
  homeHealthFilePath,
  homeMetricsFilePath,
  homeSessionsFilePath,
  homeTasksDirectory,
  homeWorkflowsFilePath,
  resolveAgentMeshHome,
  resolveSessionStoragePath,
  taskOutputFilePath,
  taskRegistryFilePath,
  taskResultFilePath,
} from "../../src/core/storage.js";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-storage-"));
}

const envBackup = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
});

describe("home resolution (single source of truth)", () => {
  it("defaults to ~/.agentmesh/sessions.json", () => {
    setEnv("AGENTMESH_SESSIONS_FILE", undefined);
    expect(resolveSessionStoragePath()).toBe(
      path.join(os.homedir(), ".agentmesh", "sessions.json"),
    );
    expect(resolveAgentMeshHome()).toBe(path.join(os.homedir(), ".agentmesh"));
  });

  it("AGENTMESH_SESSIONS_FILE relocates the whole home", () => {
    setEnv("AGENTMESH_SESSIONS_FILE", path.join(os.tmpdir(), "relocated", "sessions.json"));
    expect(resolveAgentMeshHome()).toBe(path.join(os.tmpdir(), "relocated"));
    expect(homeSessionsFilePath(resolveAgentMeshHome())).toContain("relocated");
  });

  it("an explicit service binding wins over the environment", () => {
    setEnv("AGENTMESH_SESSIONS_FILE", path.join(os.tmpdir(), "from-env", "sessions.json"));
    const explicitHome = makeTempHome();
    const bound = new StorageService({
      homeDir: explicitHome,
      sessionsFile: path.join(explicitHome, "sessions.json"),
    });
    expect(bound.resolveSessionsFile()).toBe(path.join(explicitHome, "sessions.json"));
    expect(bound.resolveHome()).toBe(explicitHome);

    const envOnly = new StorageService();
    expect(envOnly.resolveSessionsFile()).toBe(path.join(os.tmpdir(), "from-env", "sessions.json"));
  });

  it("declares the canonical file layout", () => {
    const home = path.join("some", "home");
    expect(homeSessionsFilePath(home)).toBe(path.join(home, "sessions.json"));
    expect(homeMetricsFilePath(home)).toBe(path.join(home, "metrics.jsonl"));
    expect(homeFindingsFilePath(home)).toBe(path.join(home, "findings.jsonl"));
    expect(homeHealthFilePath(home)).toBe(path.join(home, "health.jsonl"));
    expect(homeWorkflowsFilePath(home)).toBe(path.join(home, "workflows.jsonl"));
    expect(homeTasksDirectory(home)).toBe(path.join(home, "tasks"));
    expect(taskRegistryFilePath(home)).toBe(path.join(home, "tasks", "registry.jsonl"));
    expect(taskOutputFilePath(home, "t1")).toBe(path.join(home, "tasks", "t1.output"));
    expect(taskResultFilePath(home, "t1")).toBe(path.join(home, "tasks", "t1.result.json"));
    expect(homeCheckpointsDirectory(home)).toBe(path.join(home, "checkpoints"));
    expect(homeContextsDirectory(home)).toBe(path.join(home, "contexts"));
  });
});

describe("read primitives", () => {
  it("readTextFile/readTextFileAsync: ENOENT → undefined, other content returned", async () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const filePath = path.join(home, "file.txt");
    expect(service.readTextFile(filePath)).toBeUndefined();
    expect(await service.readTextFileAsync(filePath)).toBeUndefined();
    fs.writeFileSync(filePath, "hello", "utf-8");
    expect(service.readTextFile(filePath)).toBe("hello");
    expect(await service.readTextFileAsync(filePath)).toBe("hello");
  });

  it("readJson: missing or unparsable → undefined, valid → parsed value", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    expect(service.readJson(path.join(home, "missing.json"))).toBeUndefined();
    const broken = path.join(home, "broken.json");
    fs.writeFileSync(broken, "{not json", "utf-8");
    expect(service.readJson(broken)).toBeUndefined();
    const ok = path.join(home, "ok.json");
    fs.writeFileSync(ok, '{"a":1}', "utf-8");
    expect(service.readJson(ok)).toEqual({ a: 1 });
  });

  it("readLines: missing → [], blank lines dropped", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const filePath = path.join(home, "lines.txt");
    expect(service.readLines(filePath)).toEqual([]);
    fs.writeFileSync(filePath, "a\n\n  \nb", "utf-8");
    expect(service.readLines(filePath)).toEqual(["a", "b"]);
  });

  it("readJsonLines: parses, skips corrupt lines fail-closed, reports them", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const filePath = path.join(home, "log.jsonl");
    expect(service.readJsonLines(filePath, (line) => line)).toEqual([]);

    fs.writeFileSync(filePath, '{"v":1}\nnot-json\n{"v":2}\n\n', "utf-8");
    const parseLine = (line: string): { v: number } | undefined => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && "v" in parsed) {
          return parsed as { v: number };
        }
        return undefined;
      } catch {
        return undefined;
      }
    };
    const corrupt: Array<{ filePath: string; line: string }> = [];
    const records = service.readJsonLines(filePath, parseLine, (corruptPath, badLine) => {
      corrupt.push({ filePath: corruptPath, line: badLine });
    });
    expect(records).toEqual([{ v: 1 }, { v: 2 }]);
    expect(corrupt).toEqual([{ filePath, line: "not-json" }]);
  });

  it("listDirectory: missing → [], names sorted; exists reports presence", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    expect(service.listDirectory(home)).toEqual([]);
    fs.mkdirSync(path.join(home, "b"));
    fs.writeFileSync(path.join(home, "a.txt"), "", "utf-8");
    expect(service.listDirectory(home)).toEqual(["a.txt", "b"]);
    expect(service.exists(path.join(home, "a.txt"))).toBe(true);
    expect(service.exists(path.join(home, "nope"))).toBe(false);
  });
});

describe("write primitives + change events", () => {
  it("appendLine creates parent directories, newline-terminates and emits change", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const filePath = path.join(home, "nested", "dir", "log.jsonl");
    const changes: Array<{ store: string; path: string }> = [];
    service.onChange((record) => changes.push(record));

    service.appendLine(filePath, '{"n":1}', { store: "metrics" });
    service.appendLine(filePath, '{"n":2}', { store: "metrics" });

    expect(fs.readFileSync(filePath, "utf-8")).toBe('{"n":1}\n{"n":2}\n');
    expect(changes).toEqual([
      { store: "metrics", path: filePath },
      { store: "metrics", path: filePath },
    ]);
  });

  it("appendLines batches one event-free write for an empty batch and one event otherwise", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const filePath = path.join(home, "batch.jsonl");
    const listener = vi.fn();
    service.onChange(listener);

    service.appendLines(filePath, [], { store: "findings" });
    expect(listener).not.toHaveBeenCalled();
    expect(service.exists(filePath)).toBe(false);

    service.appendLines(filePath, ["a", "b"], { store: "findings" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("a\nb\n");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("writeJsonAtomic: 2-space indent, no trailing newline unless requested", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const plain = path.join(home, "plain.json");
    const trailing = path.join(home, "trailing.json");

    service.writeJsonAtomic(plain, { a: 1 }, { store: "sessions" });
    service.writeJsonAtomic(trailing, { a: 1 }, { store: "capabilities", trailingNewline: true });

    expect(fs.readFileSync(plain, "utf-8")).toBe('{\n  "a": 1\n}');
    expect(fs.readFileSync(trailing, "utf-8")).toBe('{\n  "a": 1\n}\n');
  });

  it("atomic sync + async writes publish content and leave no temp files behind", async () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const syncPath = path.join(home, "sync.json");
    const asyncPath = path.join(home, "async.json");
    const noFsyncPath = path.join(home, "no-fsync.json");

    service.writeFileAtomicSync(syncPath, "one", { store: "tasks" });
    service.writeFileAtomicSync(syncPath, "two", { store: "tasks" });
    await service.writeFileAtomicAsync(asyncPath, "done", { store: "tasks" });
    // fsync opt-out only skips the durability barrier; the rename publish and
    // its visibility guarantees are unchanged.
    await service.writeFileAtomicAsync(noFsyncPath, "fast", { store: "checkpoints", fsync: false });

    expect(fs.readFileSync(syncPath, "utf-8")).toBe("two");
    expect(fs.readFileSync(asyncPath, "utf-8")).toBe("done");
    expect(fs.readFileSync(noFsyncPath, "utf-8")).toBe("fast");
    const leftovers = fs.readdirSync(home).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("a faulty change subscriber never breaks the write", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const filePath = path.join(home, "guarded.jsonl");
    service.onChange(() => {
      throw new Error("boom");
    });

    expect(() => service.appendLine(filePath, "x", { store: "metrics" })).not.toThrow();
    expect(fs.readFileSync(filePath, "utf-8")).toBe("x\n");
  });

  it("onChange unsubscribe stops delivery; defaultStorage is the shared instance", () => {
    const home = makeTempHome();
    const service = new StorageService({ homeDir: home });
    const listener = vi.fn();
    const off = service.onChange(listener);
    off();
    service.writeFile(path.join(home, "x.txt"), "x", { store: "sessions" });
    expect(listener).not.toHaveBeenCalled();

    expect(defaultStorage).toBeInstanceOf(StorageService);
  });
});
