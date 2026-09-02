import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type {
  AgentRole,
  ReasoningEffort,
  ReviewerSafetyPolicy,
  SandboxMechanism,
  TransportMode,
} from "../agents/types.js";

export type ConfigurableRole = AgentRole | "orchestrator";

export type AgentTier = "strong" | "medium" | "weak";

/**
 * Self-declared protection level for an agent channel. Mirrors the runtime
 * SandboxMechanism vocabulary so metadata stays comparable with diagnostics.
 */
export type AgentSandboxLevel = "native-sandbox" | "tool-filtering" | "prompt-only";

const SANDBOX_LEVEL_VALUES = ["native-sandbox", "tool-filtering", "prompt-only"] as const;

const SandboxLevelSchema = z.enum(SANDBOX_LEVEL_VALUES);

export interface AgentMetadata {
  tier?: AgentTier;
  costLevel?: number;
  speed?: string;
  strengths?: string[];
  notGoodAt?: string[];
  sandboxLevel?: AgentSandboxLevel;
  notes?: string;
  /**
   * Declared upgrade chain. Entries must reference a known agent alias or a
   * sibling key declared in the same agents map (e.g. codex profile variants).
   */
  candidates?: string[];
}

export interface RoleAssignment {
  agent: string;
  mode?: TransportMode;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  safety?: ReviewerSafetyPolicy;
  /**
   * Explicit sandbox selection for this role (M5 safety default flip). When
   * unset, resolution falls to the adapter-capable default — see
   * resolveRoleSandboxLevel for the full precedence order.
   */
  sandboxLevel?: AgentSandboxLevel;
}

export interface BudgetConfig {
  /**
   * Per-bridge-session token hard cap. Totals accumulate from vendor-reported
   * usage recorded on each turn (T2.1); turns without usage data contribute 0.
   */
  perSessionTokenCap?: number;
  /**
   * warn (default): responses attach a warning at/above 80% and at the cap.
   * rejectNew: new delegate_task dispatches on an exhausted session fail fast
   * with BUDGET_EXHAUSTED; in-flight and polling work is never interrupted.
   */
  onExceed?: "warn" | "rejectNew";
}

export interface AgentMeshProjectConfig {
  version: 1;
  roles: Partial<Record<ConfigurableRole, RoleAssignment>>;
  agents?: Record<string, AgentMetadata>;
  budget?: BudgetConfig;
  /**
   * Deliberate acknowledgment of prompt-only sandbox usage (M5). When a
   * dispatch resolves to `prompt-only` — explicitly selected or fallen back to
   * because the adapter declares no runtime sandbox — validation emits a
   * warning unless this flag is true. It never upgrades runtime protection.
   */
  allowPromptOnly?: boolean;
}

export interface LoadedProjectConfig {
  path: string;
  projectRoot: string;
  config: AgentMeshProjectConfig;
  /**
   * Safety warnings detected at parse time (e.g. unacknowledged prompt-only
   * sandbox selections). The config itself is valid; consumers such as doctor
   * and `agentmesh config validate` surface these alongside schema issues.
   */
  warnings: ConfigParseIssue[];
}

export interface ConfigParseIssue {
  field: string;
  message: string;
}

export type ProjectConfigParseResult =
  | { success: true; config: AgentMeshProjectConfig; warnings: ConfigParseIssue[] }
  | { success: false; issues: ConfigParseIssue[] };

const NonBlankString = z.string().trim().min(1);
const AssignmentObjectSchema = z
  .object({
    agent: NonBlankString,
    mode: z.enum(["auto", "mcp", "cli"]).optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    model: NonBlankString.max(200).optional(),
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
    sandboxLevel: SandboxLevelSchema.optional(),
  })
  .strict();
const RoleAssignmentSchema = z.union([NonBlankString, AssignmentObjectSchema]);
const ReviewerRoleAssignmentSchema = z.union([
  NonBlankString,
  AssignmentObjectSchema.extend({
    safety: z.enum(["best-effort", "enforced"]).optional(),
  }).strict(),
]);

const MAX_AGENT_METADATA_ENTRIES = 32;
const MAX_LISTED_TRAITS = 32;
const MAX_CANDIDATES = 16;

export const AgentMetadataSchema = z
  .object({
    tier: z.enum(["strong", "medium", "weak"]).optional(),
    costLevel: z.number().int().min(1).max(5).optional(),
    speed: NonBlankString.max(100).optional(),
    strengths: z.array(NonBlankString.max(200)).max(MAX_LISTED_TRAITS).optional(),
    notGoodAt: z.array(NonBlankString.max(200)).max(MAX_LISTED_TRAITS).optional(),
    sandboxLevel: SandboxLevelSchema.optional(),
    notes: NonBlankString.max(2000).optional(),
    candidates: z.array(NonBlankString.max(200)).max(MAX_CANDIDATES).optional(),
  })
  .strict();

const AgentsMetadataSchema = z
  .record(z.string().trim().min(1), AgentMetadataSchema)
  .refine(
    (entries) => Object.keys(entries).length <= MAX_AGENT_METADATA_ENTRIES,
    `agents section must declare at most ${MAX_AGENT_METADATA_ENTRIES} entries`,
  );

export const BudgetConfigSchema = z
  .object({
    perSessionTokenCap: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    onExceed: z.enum(["warn", "rejectNew"]).optional(),
  })
  .strict();

const ProjectConfigSchema = z
  .object({
    version: z.literal(1),
    roles: z
      .object({
        orchestrator: RoleAssignmentSchema.optional(),
        worker: RoleAssignmentSchema.optional(),
        reviewer: ReviewerRoleAssignmentSchema.optional(),
        tester: RoleAssignmentSchema.optional(),
      })
      .strict(),
    agents: AgentsMetadataSchema.optional(),
    budget: BudgetConfigSchema.optional(),
    allowPromptOnly: z.boolean().optional(),
  })
  .strict();

function normalizeAssignment(
  value:
    | z.infer<typeof RoleAssignmentSchema>
    | z.infer<typeof ReviewerRoleAssignmentSchema>
    | undefined,
): RoleAssignment | undefined {
  return typeof value === "string" ? { agent: value } : value;
}

/**
 * Collects M5 safety warnings that are decidable from the config alone:
 * a `prompt-only` sandbox selection (per role or per agent metadata) without
 * the root-level `allowPromptOnly: true` acknowledgment. These are warnings,
 * never errors, so existing setups keep running; the companion
 * resolveRoleSandboxLevel covers the adapter-capability side of the same rule.
 */
export function collectConfigSafetyWarnings(config: AgentMeshProjectConfig): ConfigParseIssue[] {
  if (config.allowPromptOnly === true) return [];
  const warnings: ConfigParseIssue[] = [];
  const message =
    "sandboxLevel 'prompt-only' selects a channel with no runtime isolation: it will follow any " +
    "instruction in the task text, including injected ones (H5/H9 evidence). AgentMesh keeps " +
    'running it, but acknowledge the risk by setting "allowPromptOnly": true at the config root, ' +
    'or switch the channel to a real sandbox ("native-sandbox"/"tool-filtering").';
  for (const role of ["orchestrator", "worker", "reviewer", "tester"] as const) {
    const assignment = config.roles[role];
    if (assignment && typeof assignment !== "string" && assignment.sandboxLevel === "prompt-only") {
      warnings.push({ field: `roles.${role}.sandboxLevel`, message });
    }
  }
  for (const [key, metadata] of Object.entries(config.agents ?? {})) {
    if (metadata.sandboxLevel === "prompt-only") {
      warnings.push({ field: `agents.${key}.sandboxLevel`, message });
    }
  }
  return warnings;
}

/**
 * Parses raw config text into a validated project config. Field-level issues
 * are returned individually so callers (e.g. `agentmesh config validate`) can
 * point at the exact offending path instead of a joined blob. Safety warnings
 * travel separately so an unacknowledged prompt-only selection never blocks
 * loading.
 */
export function parseProjectConfigText(text: string): ProjectConfigParseResult {
  let parsedJson: unknown;
  try {
    // Editors on Windows commonly persist UTF-8 with a BOM; JSON.parse rejects it.
    parsedJson = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, issues: [{ field: "config", message: `Invalid JSON: ${message}` }] };
  }

  const parsed = ProjectConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "config",
        message: issue.message,
      })),
    };
  }

  const config: AgentMeshProjectConfig = {
    version: 1,
    roles: {
      orchestrator: normalizeAssignment(parsed.data.roles.orchestrator),
      worker: normalizeAssignment(parsed.data.roles.worker),
      reviewer: normalizeAssignment(parsed.data.roles.reviewer),
      tester: normalizeAssignment(parsed.data.roles.tester),
    },
  };
  if (parsed.data.agents) config.agents = parsed.data.agents;
  if (parsed.data.budget) config.budget = parsed.data.budget;
  if (parsed.data.allowPromptOnly !== undefined)
    config.allowPromptOnly = parsed.data.allowPromptOnly;
  return { success: true, config, warnings: collectConfigSafetyWarnings(config) };
}

export function findProjectConfigPath(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(current, ".agentmesh", "config.json");
    if (fs.existsSync(candidate)) return candidate;

    // A repository boundary prevents an unrelated parent configuration from
    // silently changing this project's agent assignments.
    if (fs.existsSync(path.join(current, ".git"))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function loadProjectConfig(startDirectory: string): LoadedProjectConfig | undefined {
  const configPath = findProjectConfigPath(startDirectory);
  if (!configPath) return undefined;

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read AgentMesh project config '${configPath}': ${message}`, {
      cause: error,
    });
  }

  const parsed = parseProjectConfigText(text);
  if (!parsed.success) {
    const details = parsed.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
    throw new Error(`Invalid AgentMesh project config '${configPath}': ${details}`);
  }

  return {
    path: configPath,
    projectRoot: path.dirname(path.dirname(configPath)),
    config: parsed.config,
    warnings: parsed.warnings,
  };
}

export function resolveRoleAssignment(
  startDirectory: string,
  role: ConfigurableRole,
): { assignment?: RoleAssignment; loaded?: LoadedProjectConfig } {
  const loaded = loadProjectConfig(startDirectory);
  return { assignment: loaded?.config.roles[role], loaded };
}

/** Where a resolved sandbox level came from (M5 precedence, most to least authoritative). */
export type SandboxResolutionSource =
  | "explicit-role-config"
  | "explicit-agent-metadata"
  | "adapter-capable-default"
  | "fallback";

export interface SandboxResolution {
  /** Effective sandbox level the dispatch should be treated as running under. */
  level: AgentSandboxLevel;
  source: SandboxResolutionSource;
  /** Config path of the explicit selection, e.g. `roles.reviewer.sandboxLevel`. */
  explicitField?: string;
  /**
   * Actionable warning when the dispatch runs prompt-only without the
   * `allowPromptOnly: true` acknowledgment. Absent for sandboxed levels and
   * for acknowledged prompt-only dispatches.
   */
  warning?: string;
}

export interface ResolveRoleSandboxOptions {
  /** Role name, used only to make explicitField and warnings actionable. */
  role?: ConfigurableRole;
  /** Assigned agent name/alias or agents-map key, used only in warnings. */
  agent?: string;
  /** Explicit per-role sandbox selection from the role assignment. */
  roleAssignment?: Pick<RoleAssignment, "sandboxLevel">;
  /** Explicit per-agent sandbox metadata from the `agents` config map. */
  agentMetadata?: Pick<AgentMetadata, "sandboxLevel">;
  /**
   * The target adapter's declared runtime sandbox capability
   * (`sandboxMechanism` on the adapter). Omit for unknown/profile-variant
   * channels with no declared capability.
   */
  adapterSandboxMechanism?: SandboxMechanism;
  /** Root-level `allowPromptOnly` acknowledgment from the project config. */
  allowPromptOnly?: boolean;
}

function describeSandboxTarget(options: ResolveRoleSandboxOptions): string {
  const role = options.role ? `role '${options.role}'` : "role";
  return options.agent ? `${role} (agent '${options.agent}')` : role;
}

function promptOnlyAcknowledgmentWarning(target: string, selection: string): string {
  return (
    `${target} resolves to sandbox 'prompt-only' (${selection}): prompt-only channels have no ` +
    "runtime isolation and will follow any instruction in the task text, including injected " +
    "ones (H5/H9 evidence). Prefer a sandboxed channel (codex native-sandbox, claude " +
    'tool-filtering) or set "allowPromptOnly": true at the config root to acknowledge the risk.'
  );
}

/**
 * M5 safety default flip. Resolves the effective sandbox level for a role
 * dispatch with the precedence order:
 *
 * 1. explicit config — `sandboxLevel` on the role assignment, else on the
 *    assigned agent's `agents` metadata (deliberate selection, honored as-is);
 * 2. adapter-capable default — when unset, the strongest sandbox the target
 *    adapter declares via its `sandboxMechanism` capability;
 * 3. fallback + warning — adapters whose declared capability is `prompt-only`
 *    (or unknown channels with no declared capability) keep their current
 *    prompt-level behavior but surface a warning.
 *
 * A `prompt-only` outcome is always deliberate-or-warned: without the root
 * `allowPromptOnly: true` acknowledgment, every prompt-only resolution carries
 * an actionable warning. The flag never upgrades runtime protection.
 */
export function resolveRoleSandboxLevel(options: ResolveRoleSandboxOptions): SandboxResolution {
  const explicitRole = options.roleAssignment?.sandboxLevel;
  if (explicitRole) {
    return {
      level: explicitRole,
      source: "explicit-role-config",
      explicitField: options.role ? `roles.${options.role}.sandboxLevel` : "sandboxLevel",
      warning:
        explicitRole === "prompt-only" && options.allowPromptOnly !== true
          ? promptOnlyAcknowledgmentWarning(
              describeSandboxTarget(options),
              `explicitly selected via ${options.role ? `roles.${options.role}.sandboxLevel` : "the role assignment"}`,
            )
          : undefined,
    };
  }

  const explicitMetadata = options.agentMetadata?.sandboxLevel;
  if (explicitMetadata) {
    const explicitField = options.agent ? `agents.${options.agent}.sandboxLevel` : undefined;
    return {
      level: explicitMetadata,
      source: "explicit-agent-metadata",
      ...(explicitField ? { explicitField } : {}),
      warning:
        explicitMetadata === "prompt-only" && options.allowPromptOnly !== true
          ? promptOnlyAcknowledgmentWarning(
              describeSandboxTarget(options),
              `explicitly selected via ${explicitField ?? "agents metadata"}`,
            )
          : undefined,
    };
  }

  const mechanism = options.adapterSandboxMechanism;
  if (mechanism && mechanism !== "prompt-only") {
    return { level: mechanism, source: "adapter-capable-default" };
  }

  return {
    level: "prompt-only",
    source: "fallback",
    warning:
      options.allowPromptOnly !== true
        ? promptOnlyAcknowledgmentWarning(
            describeSandboxTarget(options),
            mechanism
              ? "the target adapter declares no runtime sandbox (sandboxMechanism 'prompt-only')"
              : "the target adapter declares no sandbox capability",
          )
        : undefined,
  };
}
