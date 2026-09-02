import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectConfigPath,
  loadProjectConfig,
  parseProjectConfigText,
  resolveRoleAssignment,
  resolveRoleSandboxLevel,
} from "../../src/core/config.js";

const createdDirectories: string[] = [];

function createProject(config: unknown): { root: string; nested: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-config-"));
  createdDirectories.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  const configDirectory = path.join(root, ".agentmesh");
  fs.mkdirSync(configDirectory);
  const configPath = path.join(configDirectory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
  const nested = path.join(root, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  return { root, nested, configPath };
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("core/project config", () => {
  it("loads shorthand and detailed role assignments from nested project paths", () => {
    const project = createProject({
      version: 1,
      roles: {
        orchestrator: "antigravity",
        worker: "antigravity",
        reviewer: {
          agent: "claude",
          mode: "cli",
          timeoutMs: 120000,
          safety: "enforced",
        },
        tester: "claude",
      },
    });

    expect(findProjectConfigPath(project.nested)).toBe(project.configPath);
    const loaded = loadProjectConfig(project.nested)!;
    expect(loaded.projectRoot).toBe(project.root);
    expect(loaded.config.roles.worker).toEqual({ agent: "antigravity" });
    expect(loaded.config.roles.reviewer).toEqual({
      agent: "claude",
      mode: "cli",
      timeoutMs: 120000,
      safety: "enforced",
    });
    expect(resolveRoleAssignment(project.nested, "tester").assignment?.agent).toBe("claude");
  });

  it("fails with a precise error for invalid project config", () => {
    const project = createProject({ version: 1, roles: { reviewer: { agent: "" } } });
    expect(() => loadProjectConfig(project.root)).toThrow("Invalid AgentMesh project config");
  });

  it("rejects reviewer-only safety settings on other roles", () => {
    const project = createProject({
      version: 1,
      roles: { worker: { agent: "codex", safety: "best-effort" } },
    });
    expect(() => loadProjectConfig(project.root)).toThrow("Unrecognized key");
  });

  it("does not inherit configuration beyond the nearest repository boundary", () => {
    const parent = createProject({ version: 1, roles: { worker: "claude" } });
    const nestedRepository = path.join(parent.root, "nested-repo");
    fs.mkdirSync(path.join(nestedRepository, ".git"), { recursive: true });
    expect(findProjectConfigPath(nestedRepository)).toBeUndefined();
  });
});

describe("core/project config agents metadata", () => {
  it("parses a full valid agents metadata section with trimmed values", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: { worker: "codex" },
        agents: {
          codex: {
            tier: "strong",
            costLevel: 5,
            speed: "slow (~3min per task)",
            strengths: ["deep refactoring", "architecture review"],
            notGoodAt: ["quick one-liners"],
            sandboxLevel: "native-sandbox",
            notes: "Preferred for high-stakes changes",
            candidates: ["codex-medium", "zcode"],
          },
          zcode: { tier: "weak", costLevel: 1 },
        },
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.agents).toEqual({
      codex: {
        tier: "strong",
        costLevel: 5,
        speed: "slow (~3min per task)",
        strengths: ["deep refactoring", "architecture review"],
        notGoodAt: ["quick one-liners"],
        sandboxLevel: "native-sandbox",
        notes: "Preferred for high-stakes changes",
        candidates: ["codex-medium", "zcode"],
      },
      zcode: { tier: "weak", costLevel: 1 },
    });
  });

  it("keeps configs without an agents section fully backward compatible", () => {
    const project = createProject({ version: 1, roles: { worker: "antigravity" } });
    const loaded = loadProjectConfig(project.nested)!;
    expect(loaded.config.agents).toBeUndefined();
    expect(loaded.config.roles.worker).toEqual({ agent: "antigravity" });
    expect(resolveRoleAssignment(project.root, "worker").assignment?.agent).toBe("antigravity");
  });

  it("rejects an invalid tier and reports the exact field path", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { codex: { tier: "powerful" } },
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const fields = result.issues.map((issue) => issue.field);
    expect(fields).toContain("agents.codex.tier");
  });

  it.each([0, 6, 2.5, "3"])("rejects costLevel %p outside integer range 1-5", (costLevel) => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { codex: { costLevel } },
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const target = result.issues.find((issue) => issue.field.startsWith("agents.codex.costLevel"));
    expect(target).toBeDefined();
  });

  it("rejects unknown metadata keys so typos fail fast", () => {
    const project = createProject({
      version: 1,
      roles: {},
      agents: { codex: { tuer: "typo of tier" } },
    });
    expect(() => loadProjectConfig(project.root)).toThrow(/Unrecognized key/);
  });

  it("rejects blank agent keys in the agents map", () => {
    const result = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, agents: { "": { tier: "weak" } } }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-array strengths and oversized candidate chains", () => {
    const badStrengths = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, agents: { codex: { strengths: "review" } } }),
    );
    expect(badStrengths.success).toBe(false);

    const tooManyCandidates = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { codex: { candidates: Array.from({ length: 17 }, (_, i) => `a${i}`) } },
      }),
    );
    expect(tooManyCandidates.success).toBe(false);
    if (tooManyCandidates.success) return;
    expect(tooManyCandidates.issues.map((issue) => issue.field)).toContain(
      "agents.codex.candidates",
    );
  });

  it("reports invalid JSON as a single config-level issue", () => {
    const result = parseProjectConfigText("{ not json");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toHaveLength(1);
    const [jsonIssue] = result.issues;
    expect(jsonIssue?.field).toBe("config");
    expect(jsonIssue?.message).toContain("Invalid JSON");
  });

  it("accepts UTF-8 BOM prefixed config text written by Windows editors", () => {
    const result = parseProjectConfigText(
      `\uFEFF${JSON.stringify({ version: 1, roles: { worker: "codex" } })}`,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.roles.worker).toEqual({ agent: "codex" });
  });

  it("accepts a minimal agents entry where every field is optional", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { claude: { notes: "Reviewer of record" } },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.agents).toEqual({ claude: { notes: "Reviewer of record" } });
  });

  it("enforces documented size bounds on free-text and list fields", () => {
    const oversizedSpeed = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, agents: { codex: { speed: "x".repeat(101) } } }),
    );
    expect(oversizedSpeed.success).toBe(false);

    const oversizedNotes = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, agents: { codex: { notes: "x".repeat(2001) } } }),
    );
    expect(oversizedNotes.success).toBe(false);
    if (oversizedNotes.success) return;
    expect(oversizedNotes.issues.map((issue) => issue.field)).toContain("agents.codex.notes");
  });

  it("rejects more than 32 agent entries", () => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) entries[`agent-${i}`] = { tier: "weak" };
    const result = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, agents: entries }),
    );
    expect(result.success).toBe(false);
  });

  it("still fails loadProjectConfig with the aggregated legacy error format", () => {
    const project = createProject({
      version: 1,
      roles: {},
      agents: { codex: { costLevel: 9 } },
    });
    expect(() => loadProjectConfig(project.root)).toThrow(
      /Invalid AgentMesh project config .*agents\.codex\.costLevel/,
    );
  });
});

describe("core/project config sandbox safety (M5 default flip)", () => {
  it("parses a per-role sandboxLevel selection into the role assignment", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: { worker: { agent: "claude", sandboxLevel: "tool-filtering" } },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.roles.worker).toEqual({
      agent: "claude",
      sandboxLevel: "tool-filtering",
    });
  });

  it("rejects an invalid per-role sandboxLevel value", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: { worker: { agent: "codex", sandboxLevel: "enforced" } },
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    // Role assignments parse through a string|object union, so object-branch
    // errors surface at the union path (same as every other role field).
    expect(result.issues.map((issue) => issue.field)).toContain("roles.worker");
  });

  it("rejects a non-boolean allowPromptOnly at the config root", () => {
    const result = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, allowPromptOnly: "yes" }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((issue) => issue.field)).toContain("allowPromptOnly");
  });

  it("warns when a role selects prompt-only without the acknowledgment flag", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: { reviewer: { agent: "opencode", sandboxLevel: "prompt-only" } },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.roles.reviewer).toEqual({
      agent: "opencode",
      sandboxLevel: "prompt-only",
    });
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0];
    expect(warning?.field).toBe("roles.reviewer.sandboxLevel");
    expect(warning?.message).toContain("allowPromptOnly");
    expect(warning?.message).toContain("no runtime isolation");
  });

  it("parses cleanly when allowPromptOnly acknowledges the prompt-only selection", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: { reviewer: { agent: "opencode", sandboxLevel: "prompt-only" } },
        allowPromptOnly: true,
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings).toEqual([]);
  });

  it("warns for prompt-only agent metadata without the flag and stays clean with it", () => {
    const unacknowledged = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { grok: { sandboxLevel: "prompt-only" } },
      }),
    );
    expect(unacknowledged.success).toBe(true);
    if (!unacknowledged.success) return;
    expect(unacknowledged.warnings.map((warning) => warning.field)).toEqual([
      "agents.grok.sandboxLevel",
    ]);

    const acknowledged = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { grok: { sandboxLevel: "prompt-only" } },
        allowPromptOnly: true,
      }),
    );
    expect(acknowledged.success).toBe(true);
    if (!acknowledged.success) return;
    expect(acknowledged.warnings).toEqual([]);
  });

  it("keeps sandboxed sandboxLevel selections warning-free", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: { worker: { agent: "codex", sandboxLevel: "native-sandbox" } },
        agents: { claude: { sandboxLevel: "tool-filtering" } },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings).toEqual([]);
  });

  it("surfaces safety warnings on loadProjectConfig without blocking the load", () => {
    const project = createProject({
      version: 1,
      roles: { reviewer: { agent: "opencode", sandboxLevel: "prompt-only" } },
    });
    const loaded = loadProjectConfig(project.root)!;
    expect(loaded.config.roles.reviewer).toEqual({
      agent: "opencode",
      sandboxLevel: "prompt-only",
    });
    expect(loaded.warnings.map((warning) => warning.field)).toEqual([
      "roles.reviewer.sandboxLevel",
    ]);

    const acknowledged = createProject({
      version: 1,
      roles: { reviewer: { agent: "opencode", sandboxLevel: "prompt-only" } },
      allowPromptOnly: true,
    });
    expect(loadProjectConfig(acknowledged.root)!.warnings).toEqual([]);
  });
});

describe("core/resolveRoleSandboxLevel (M5 default flip)", () => {
  it("resolves an unset sandboxLevel to the adapter-capable default without warnings", () => {
    expect(
      resolveRoleSandboxLevel({
        role: "worker",
        agent: "codex",
        adapterSandboxMechanism: "native-sandbox",
      }),
    ).toEqual({ level: "native-sandbox", source: "adapter-capable-default" });

    expect(
      resolveRoleSandboxLevel({
        role: "reviewer",
        agent: "claude",
        adapterSandboxMechanism: "tool-filtering",
      }),
    ).toEqual({ level: "tool-filtering", source: "adapter-capable-default" });
  });

  it("falls back to prompt-only with a warning for adapters that declare no sandbox", () => {
    const resolution = resolveRoleSandboxLevel({
      role: "reviewer",
      agent: "opencode",
      adapterSandboxMechanism: "prompt-only",
    });
    expect(resolution.level).toBe("prompt-only");
    expect(resolution.source).toBe("fallback");
    expect(resolution.warning).toContain("role 'reviewer' (agent 'opencode')");
    expect(resolution.warning).toContain("sandboxMechanism 'prompt-only'");
    expect(resolution.warning).toContain("allowPromptOnly");
  });

  it("falls back to prompt-only with a warning when the adapter capability is unknown", () => {
    const resolution = resolveRoleSandboxLevel({ role: "tester", agent: "codex-strong" });
    expect(resolution.level).toBe("prompt-only");
    expect(resolution.source).toBe("fallback");
    expect(resolution.warning).toContain("declares no sandbox capability");
  });

  it("treats an explicit prompt-only role selection as deliberate but unacknowledged", () => {
    const resolution = resolveRoleSandboxLevel({
      role: "reviewer",
      agent: "codex",
      roleAssignment: { sandboxLevel: "prompt-only" },
      adapterSandboxMechanism: "native-sandbox",
    });
    expect(resolution.level).toBe("prompt-only");
    expect(resolution.source).toBe("explicit-role-config");
    expect(resolution.explicitField).toBe("roles.reviewer.sandboxLevel");
    expect(resolution.warning).toContain("allowPromptOnly");
  });

  it("suppresses the prompt-only warning when allowPromptOnly acknowledges it", () => {
    const explicit = resolveRoleSandboxLevel({
      role: "reviewer",
      agent: "opencode",
      roleAssignment: { sandboxLevel: "prompt-only" },
      adapterSandboxMechanism: "prompt-only",
      allowPromptOnly: true,
    });
    expect(explicit).toEqual({
      level: "prompt-only",
      source: "explicit-role-config",
      explicitField: "roles.reviewer.sandboxLevel",
    });

    const fallback = resolveRoleSandboxLevel({
      role: "tester",
      agent: "grok",
      adapterSandboxMechanism: "prompt-only",
      allowPromptOnly: true,
    });
    expect(fallback).toEqual({ level: "prompt-only", source: "fallback" });
  });

  it("prefers the explicit role selection over agent metadata and the adapter default", () => {
    const resolution = resolveRoleSandboxLevel({
      role: "worker",
      agent: "codex",
      roleAssignment: { sandboxLevel: "tool-filtering" },
      agentMetadata: { sandboxLevel: "prompt-only" },
      adapterSandboxMechanism: "native-sandbox",
    });
    expect(resolution.level).toBe("tool-filtering");
    expect(resolution.source).toBe("explicit-role-config");
    expect(resolution.warning).toBeUndefined();
  });

  it("uses explicit agent metadata before the adapter-capable default", () => {
    const metadataSelection = resolveRoleSandboxLevel({
      role: "worker",
      agent: "codex",
      agentMetadata: { sandboxLevel: "prompt-only" },
      adapterSandboxMechanism: "native-sandbox",
    });
    expect(metadataSelection.level).toBe("prompt-only");
    expect(metadataSelection.source).toBe("explicit-agent-metadata");
    expect(metadataSelection.explicitField).toBe("agents.codex.sandboxLevel");
    expect(metadataSelection.warning).toContain("allowPromptOnly");

    const sandboxedMetadata = resolveRoleSandboxLevel({
      role: "worker",
      agent: "opencode",
      agentMetadata: { sandboxLevel: "native-sandbox" },
      adapterSandboxMechanism: "prompt-only",
    });
    expect(sandboxedMetadata.level).toBe("native-sandbox");
    expect(sandboxedMetadata.source).toBe("explicit-agent-metadata");
    expect(sandboxedMetadata.warning).toBeUndefined();
  });
});
