import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRepositoryState } from "../../src/core/repository.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd });
}

describe("core/repository evidence", () => {
  let repositoryRoot: string;

  beforeEach(() => {
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-repo-test-"));
    git(repositoryRoot, "init", "--quiet");
    git(repositoryRoot, "config", "user.email", "test@example.com");
    git(repositoryRoot, "config", "user.name", "AgentMesh Test");
    fs.writeFileSync(path.join(repositoryRoot, "base.txt"), "base\n");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "--quiet", "-m", "init");
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it("fingerprints individual changed paths and stays deterministic", async () => {
    fs.writeFileSync(path.join(repositoryRoot, "base.txt"), "changed\n");

    const first = await captureRepositoryState(repositoryRoot);
    const second = await captureRepositoryState(repositoryRoot);

    expect(first?.dirty).toBe(true);
    expect(Object.keys(first?.pathFingerprints ?? {})).toContain("base.txt");
    expect(second?.fingerprint).toBe(first?.fingerprint);
  });

  it("degrades to coarse evidence beyond the changed-path cap", async () => {
    for (let index = 0; index < 101; index += 1) {
      fs.writeFileSync(path.join(repositoryRoot, `f${index}.txt`), `content ${index}\n`);
    }

    const state = await captureRepositoryState(repositoryRoot);

    expect(state?.changedPaths).toHaveLength(100);
    expect(state?.pathFingerprints).toBeUndefined();
  });

  // 505 file writes + two state captures are inherently slow; under the full
  // `npm run check` suite (coverage + parallel workers) the 20s default is
  // not enough, so give this one an explicit budget.
  it(
    "keeps untracked fingerprints deterministic beyond the content-hash cap",
    { timeout: 60_000 },
    async () => {
      for (let index = 0; index < 505; index += 1) {
        fs.writeFileSync(path.join(repositoryRoot, `u${index}.txt`), "x");
      }

      const first = await captureRepositoryState(repositoryRoot);
      const second = await captureRepositoryState(repositoryRoot);
      expect(second?.fingerprint).toBe(first?.fingerprint);

      fs.writeFileSync(path.join(repositoryRoot, "u0.txt"), "changed");
      const third = await captureRepositoryState(repositoryRoot);
      expect(third?.fingerprint).not.toBe(first?.fingerprint);
    },
  );

  it("returns undefined outside a git repository", async () => {
    const plainDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-plain-"));
    try {
      expect(await captureRepositoryState(plainDirectory)).toBeUndefined();
    } finally {
      fs.rmSync(plainDirectory, { recursive: true, force: true });
    }
  });

  // P-076: `.agentmesh/` is bridge-owned runtime metadata, not repository
  // content — rewriting it (config updates, capability probes) must not flip
  // handoff freshness to STALE, surface in changedPaths, or set dirty.
  it("excludes .agentmesh runtime metadata from fingerprints and dirty state", async () => {
    const before = await captureRepositoryState(repositoryRoot);

    fs.mkdirSync(path.join(repositoryRoot, ".agentmesh"), { recursive: true });
    fs.writeFileSync(
      path.join(repositoryRoot, ".agentmesh", "config.json"),
      JSON.stringify({ version: 1, touched: Date.now() }),
    );
    fs.writeFileSync(path.join(repositoryRoot, ".agentmesh", "capabilities.json"), "{}");

    const after = await captureRepositoryState(repositoryRoot);

    expect(after?.fingerprint).toBe(before?.fingerprint);
    expect(after?.dirty).toBe(before?.dirty);
    expect(after?.changedPaths).not.toContain(".agentmesh/config.json");
    expect(after?.pathFingerprints?.[".agentmesh/config.json"]).toBeUndefined();
  });

  it("still reports business changes alongside .agentmesh metadata", async () => {
    fs.mkdirSync(path.join(repositoryRoot, ".agentmesh"), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, ".agentmesh", "config.json"), "{}");
    fs.writeFileSync(path.join(repositoryRoot, "feature.txt"), "business change\n");

    const state = await captureRepositoryState(repositoryRoot);

    expect(state?.dirty).toBe(true);
    expect(state?.changedPaths).toContain("feature.txt");
    expect(state?.changedPaths).not.toContain(".agentmesh/config.json");
  });
});
