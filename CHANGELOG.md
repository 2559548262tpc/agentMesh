# Changelog

AgentMesh follows [Semantic Versioning](https://semver.org/).

## Unreleased

### v0.5 Batch 1 — 需求对账单架构（v0.5*设计*需求对账单架构.md #0-#6）

#### Added

- **需求贯穿（Batch 1 #1/#2）：** WorkflowSpec 的 stage 增加可选 `requirements: ["R1",…]` 声明；`acceptance.commands` 同时接受旧字符串与 `{cmd, covers:["R1"]}` 对象（兼容非破坏）。新增 requirements.json 格式（EARS 五模式句式 + `quote` 原文引用 + `decidable` 标记）与引擎边界校验：`quote` 必须为源文档真实子串（机械核验，零 token 防蒸馏编造）、kind 必须与 EARS 句式一致、条数对文档结构单元做对数粗核验（warning 级）。`run_workflow` 增 `requirementsPath` 参数、`agentmesh workflow run` 增 `--requirements`。
- **终态对账单（Batch 1 #4）：** workflow 终态由引擎 join 出 reconciliation ledger 落盘 `<agentmeshHome>/out/ledger_<workflowId>.json`：每条需求一行（PASS/FAIL/ESCALATED/PENDING_RULING + 验收命令证据 + findings），跨 stage 合取语义（任一 declaring stage 未通过则不为 PASS；stage 通过但无 covering 命令证据 → PENDING_RULING，fail-closed）。对数硬不变量 `n(requirements) == Σn(status)` 独立复算；存在 PENDING_RULING 行时终态为 `needs_ruling`（新状态）而非 done——快车道不得携带未裁决条目安静完成。CLI 退出码 0/1/2/3 = done/failed/escalated/needs_ruling。
- **compact 返回 + Tier 0 截断（Batch 1 #5，P-080①②）：** `get_workflow`/`poll_task` 默认返回 compact 封套（状态枚举 + 每阶段状态 + flag 位 unresolvedP0P1/coverage/anomalies + ledger 指针；poll 为状态 + nextOffset + ≤1.5KB 增量尾部 + 输出文件指针），`detail:"full"` 显式取全量。Tier 0 为无条件引擎行为：任一面向组长的返回体超过 2KB 自动落盘 `<agentmeshHome>/out/` 并只回尾部 1.5KB + 路径——大输出从未进入组长上下文。
- **Tier 1 规则化清场（Batch 1 #6）：** workflow 终态时，该 workflow 产出的 Bridge 会话中除"最近一个 stage 保留最新一轮"外，历史条目的 task 回显与 finalAnswer 原文替换为指针占位符 `[archived → <ledgerRef>]`，summary/findings/usage/evidence 保留——下游 `contextSessionIds` 复用只带摘要+指针。零 token、确定性；仅作用于 AgentMesh 侧会话（宿主侧组长历史引擎不可改写，Tier 0 负责防新注入）。
- **leaderShare 度量先行（Batch 1 #0，P-080④）：** `TaskMetrics` 增 `lane` 维度（fast/standard/gated/full，Batch 2 分诊填充），`agentmesh stats` 按 lane 聚合并支持 `--leader-tokens <n>`（宿主侧组长消耗，引擎不 meter 宿主、绝不伪造）计算 leaderShare，超 25% 阈值输出 `LEADER_SHARE_EXCEEDED` 告警。
- **contract map 按 R 申报（Batch 1 #3）：** `verify_contract_map` 增 `requirementIds`：R id 成为必映射项（缺失 = missing，未声明条目 = unknown-item），契约清单可直接引用需求 id。

### v0.5 Batch 2 — 分诊引擎与快车道（v0.5*设计*需求对账单架构.md #7-#9）

#### Added

- **副官工具（Batch 2 #7，P-080③）：** 新增 MCP 工具 `distill_requirements`（把需求文档经免费档副官通道蒸馏成 requirements.json：EARS 条目 + `quote` 原文引用 + `decidable` 标记）与 `summarize_for_leader`（把大段产出——内联文本或文件——消化成组长摘要：第一行结论 + 决策相关事实，硬字符上限默认 2000，超限确定性截断并附 truncated 标记）。两者均带探针预检（副官通道不可用即 fail-closed 返回结构化 error，组长回退手写/人工流程）；`distill_requirements` 允许单次 schema 修复重试，除该重试外绝无第二次真实派发，写盘文件即 `run_workflow` requirementsPath 闸门消费的原件。
- **分诊引擎（Batch 2 #8）：** `run_workflow` 在派发前对 spec 做**静态确定性分诊**（零 token），lane（fast/standard/gated/full）写入每次派发的 metrics 记录与终态快照。`fast`——每 stage 文件集 ≤2、需求集存在且每项被验收命令 `covers` 覆盖、无跨 stage contextPolicy → 验收即评审；`standard`——文件集 3-5 无风险标记 → worker+reviewer+rework；`gated`——文件集 3-5 且任务文本命中风险关键词表（auth/permission/secret/token/credential/并发/锁/迁移/删除等）→ 闸道 fail-closed（`GATE_RULING_REQUIRED`），spec 顶层 `gateRuling: "standard"|"full"` 裁决后按裁决值继续；`full`——其余全流程。
- **快车道安全网（Batch 2 #9）：** 两道确定性机制兜底"验收即评审"的跳审风险——**树守卫（tree guard）**对照 `acceptance.files` 声明集做逐路径指纹比对（非 git 目录如实标注 checked:false 跳过），worker 越界写即**就地升道**为完整评审环（初始评审 + 有界 rework，零组长介入）；**种子抽样器**按 `SHA-256(workflowId:stage)` 确定性抽 10-20% 快车道 stage（默认 15%）强制补审，非 PASS 判 fail-closed（抽检缺陷走人工回流修订分诊判据 #14）。升道/抽检事件记录进快照 `laneEvents` 并汇入 ledger `anomalies`。`run_workflow` MCP 增 `samplingRate` 参数：0 = 显式禁用，非零值夹紧进 0.1-0.2 设计档。

#### Fixed

- **快车道审计派发缺 agent 声明：** sampled review 与 tree guard 升道初评的派发请求未携带 stage 声明的 `agent`——Fake 通道单测掩盖了该缺陷，真实 MCP 路径下角色解析 fail-closed（"role 'reviewer' is not configured"）。现两处均继承 `stage.dispatch.agent`，并加确定性回归断言（核心 fake 测试 + MCP 协议测试）。

### v0.5 Batch 3 — Tier 2 自动压缩（v0.5*设计*需求对账单架构.md #13）

#### Added

- **Tier 2 LLM 压缩兜底（#13）：** AgentMesh 侧会话的估算 token 占用越过阈值时，runner 在该轮记录后自动对该会话执行 `compact_context`（用会话自己的 Agent 一次 LLM 调用压缩历史），披露信息走 result warning 通道，压缩失败降级为 advisory 不影响当轮结果。阈值 = `AGENTMESH_AUTOCOMPACT_PCT`（默认 70，0 = 禁用）× 假定上下文窗口 `AGENTMESH_CONTEXT_WINDOW_TOKENS`（默认 200k）；估算口径：metered 轮次用 vendor 上报 usage 求和，未计量轮次按 chars/4 启发式（诚实估算，不伪造计量）；并发压缩去重（in-flight 提示），压缩后源会话新增轮次即 STALE 回落全文注入；压缩派发自身带递归护栏（不再触发 Tier 2）。

### v0.4 改造方案（ROADMAP_v0.4.md，M0-M7）

#### Added

- **M0 task metrics:** append-only `metrics.jsonl` in the agentmesh home records per-dispatch role/agent/model/tokens/duration/outcome; the background watchdog records stall events attributed by `taskId`. `agentmesh stats` aggregates per model/role over `all|24h|7d` windows (p50/p95 duration, retry/stall/cancel rates, `--json`).
- **M1 simulation harness:** dependency-free `scripts/fake-vendors/fake-vendor.mjs` (ok/stall/truncate/apierror/slow/semantic-fail/exit-mismatch) plus 9 process-level scenarios under `npm run test:simulation` pinning the r21/r22 fault classes (0-byte stall, vendor APIError, truncation, exit/semantic mismatch, cancellation, slow vendor) as CI regressions via the real MCP surface and adapter.
- **M2 model health routing:** `health.jsonl` rolling windows with a 24h half-life failure score, p50/p95 durations, and a consecutive-failure circuit breaker (quarantine after 3, 30min cooldown lift). `hint.nextCandidates` reorder: tier match → health score → costLevel; quarantined models excluded with a last-resort warning. `agentmesh health` CLI with `--json` and `--reset`.
- **M3 review findings metrics:** `findings.jsonl` store with category/kind taxonomy and confirmed-tracking when the rework loop closes (repo-evidence change = confirmed, no-op-rework PASS = rejected); precision aggregation and graduation proposals (eslint-rule vs acceptance-script). New `verify_contract_map` MCP tool: machine-checked quick review over contract item → file:line mappings, zero LLM tokens.
- **M4 deterministic workflow engine:** declarative JSON WorkflowSpec executed by an in-process state machine (`run_workflow`/`get_workflow`, `agentmesh workflow run/status`): stages with role dispatch templates, acceptance commands/file checks, parallelGroups, rework loop with findings re-injection, and fail-closed escalation carrying a full evidence chain. Waiting is event-driven; dispatches inherit the background-task registry, stalled watchdog, and cancel semantics.
- **cancel_task primitive:** cancels a running background task through the watchdog abort path with checkpoint spill; idempotent on terminal tasks, structured `NOT_FOUND`/`NOT_CANCELLABLE` errors.
- **M7 handoff_diff:** machine judge for handoff fidelity — compares upstream normalized history against what the downstream dispatch actually received (verbatim shared-context audit sidecar when readable, audit metadata as fallback) and returns `lossless | minor-truncation | partial-loss | severe-loss | lost` with per-section judgments.

#### Changed

- **BREAKING (M5):** unset role `sandboxLevel` now resolves to the strongest sandbox the target adapter declares (codex native-sandbox, claude tool-filtering) instead of implicit prompt-only. `prompt-only` still works but requires explicit choice or the root-level `allowPromptOnly` acknowledgment flag, otherwise config validation carries an actionable warning. Resolution order: explicit role config > agents metadata > adapter capability default > prompt-only fallback with warning.
- **M6 unified data layer:** a single `StorageService` owns home-directory resolution (including `AGENTMESH_SESSIONS_FILE` relocation), atomic writes (temp+fsync+rename with an fsync opt-out for best-effort evidence), corrupt-line tolerance, and change events; sessions/tasks/metrics/findings/health/workflows/checkpoints/capabilities and the UI's data reads all route through it. Persisted formats and locations are byte-compatible — no migration.
- `agentmesh config validate` and `doctor` surface the new sandbox safety warnings; the checkpoint spill is published before the terminal result so "result visible ⇒ checkpoint visible" holds structurally.

- **M7b lifecycle primitives:** `delegate_task` gains `priority` (queue ordering) and `deps` (up to 8 task IDs that must succeed first); an optional per-bridge `maxConcurrentBackgroundTasks` cap (env `AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS`, absent = start-immediately, zero regression) makes the persisted priority queue effective. `poll_task` reports `queued` (with position) and `blocked` (with unmet dep ids); a failed/cancelled/stalled dep fails the dependent with structured `DEP_FAILED` without starting a vendor process. `pause_task` wraps cancel-with-checkpoint so `continue_task` on the same session resumes deliberately paused work. `agentmesh stats --findings` adds the M3 reviewer precision table and graduation proposals (`--min-count`, default 3, `--json`).

### v0.4 改造方案已定稿于 [ROADMAP_v0.4.md](ROADMAP_v0.4.md)（外视角重构版），里程碑摘要：

- M0 度量先行（任务级 metrics + reviewer 确认率 + 交接指纹）
- M1 fake-vendor 仿真 harness（人工压测故障类别全部进 CI）
- M2 模型健康度自动路由与自动止损（数据驱动，熔断 + 探针恢复）
- M3 评审价值度量与 findings 毕业（quick review 机器化，重复缺陷下沉为静态检查）
- M4 确定性编排状态机（声明式 WorkflowSpec + `run_workflow`/`get_workflow`，组长只在写 spec 与 ESCALATED 时介入）
- M5 安全默认翻转（默认最强可用沙箱，prompt-only 需显式信任声明，BREAKING）
- M6 统一数据层（单一 StorageService 所有者，零迁移）
- M7 生命周期原语与交接保真（全部落地：`handoff_diff`、优先级队列、依赖 DAG、`pause_task`；遗留面板语义跟进项见下文）

**已知跟进项（v0.5 候选）**：排队派发在注册时即发出 `task.started`（"已受理"公告），面板消费方可能把排队任务显示为"已启动"——面板侧需要区分 queued/started 两种事件语义。

### 问题清单收口（2026-09-08，PROBLEMS.md P-079/P-080⑤/P-081 + ISS 系列）

#### Fixed

- **P-081 opencode 零 text 事件 summary 污染：** `parseOpenCodeJsonLines` 增 `normalizedEmpty` 信号（解析到事件流但零 text 回答），summary 用角色化占位符替代原始 JSONL 事件碎片并附 warning——vendor 事件行不再冒充人类可读摘要。
- **P-079② workflow 断点续跑：** `run_workflow` MCP 增 `resumeFromWorkflowId`、CLI `workflow run --resume <workflowId>`，从持久化 snapshot 继承 passed 阶段（同 spec 名硬校验），仅重跑 pending 阶段，不重复消耗真实配额；引擎正反回归用例覆盖。
- **P-079① 瞬态重试闭环：** `classifyErrorCode` 直接消费 `httpStatus`（408/429/5xx → TRANSIENT_5XX，message 无特征词也可靠分类），opencode 解析出的 HTTP 状态码喂入分类器——裸 "APIError" 503 现在能进入既有 `executeWithResilientRetries` 退避重试层（此前因 P-078 错误压缩无法分类而漏判）。
- **ISS-7 TLS 错误分类：** `TRANSIENT_TLS_PATTERN` 把证书/TLS 握手类错误归为 TRANSIENT_5XX（可重试）而非裸 UnknownError。
- **ISS-1 误判缓解：** model rejection 诊断引入 30 分钟多观测确认窗口，单样本不再直接定罪。
- **ISS-5 poll_task 长轮询封顶：** `maxWaitMs` 被引擎封顶 `min(maxWaitMs, 25s)`（`POLL_MAX_WAIT_CAP_MS`），避免宿主 30s 请求超时被引擎的长轮询触发。
- **ISS-6 注册表终态孤儿：** 被 reap/expired 的注册表条目不再让持久化终态结果失联——poll_task 在记录缺失时回读持久化 result 文件返回终态，而非裸 NOT_FOUND。
- **P-080⑤ workflow 终态推送：** 引擎终态经 event bus 发 `workflow.terminal`，MCP server 转发 logging notification，宿主无需轮询即可知晓 workflow 结束（poll_task/get_workflow 仍是可靠兜底）。

#### Changed

- **#9.5 延迟感知路由：** `orderCandidatesByHealth` 在健康分并列时按 p50 时延升序排列，候选升级链优先选择实测更快的模型。
- 测试加固：全量 `npm run check` 高负载下三处环境性 flaky（waitFor 等待预算、git 子进程 EBUSY 清理重试、慢测试超时预算）修复。

## 0.3.0 - 2026-09-02

v0.3 世代（五源融合优化计划 P1-P5）的完整实现。

### Added

- **P5 unattended closed loop (T5.1-T5.5):**
  - Bounded rework loop on `review_changes` (`maxReworkRounds`, 0-3, default 0 = v0.1 behavior): a FAIL verdict injects the machine-parsed structured findings into the original worker session via `continue_task` (explicit `workerSessionId`, or the single worker-role context session; never guessed when ambiguous), then a fresh reviewer re-reviews, with the full per-round evidence chain returned as `result.rework`. The review prompt now carries a P0-P3 rubric (mapped onto the existing severity parsing: P0→critical, P1→high, P2→medium, P3→low; any P0/P1 forces FAIL) whenever the strict review contract is declared.
  - Checkpoint artifacts (T5.2): failed, cancelled, and watchdog-terminated background dispatches spill the captured output tail (≤32k chars) to `<agentmeshHome>/checkpoints/` with reason and usage. `continue_task` accepts `fromCheckpoint` to inject the salvaged partial output at the head of the continuation; checkpoints are one-shot recovery batons (consumed tombstone written fail-closed before success; a second consumption or an unknown id is rejected structurally).
  - Stalled watchdog second stage (T5.3): a background task silent for 30 minutes past its `stalled` notification is auto-terminated through its abort controller after the checkpoint is spilled, with the termination reason recorded in the terminal result. The startup orphan sweep now classifies before acting: dead-owner records are reaped, finished tasks are released, and unfinished registrations owned by a foreign live bridge are left untouched inside a 24h GC grace period (evictAfter-style) and reaped once the grace expires.
  - Budget water-level gate (T5.4): optional `budget: { perSessionTokenCap, onExceed: "warn" | "rejectNew" }` in `.agentmesh/config.json`. Session usage accumulates from vendor-reported usage now persisted on every history entry (completing T2.1 metering storage). At/above 80% responses carry a warning; at the cap under `rejectNew` new dispatches fail fast with `BUDGET_EXHAUSTED` plus an actionable hint, while in-flight work and polling are untouched. Rejected dispatches never register an idempotency key.
  - T5.5 design-only document: `docs/design/completion-notify-hook.md` (codex `notify` completion-aware channel reserved for the future long-lived mode; intentionally not implemented).
- Typed ESLint, deterministic formatting, coverage thresholds, process integration tests, and published-package smoke tests.
- Node.js 22 and 24 CI coverage, dependency update automation, and npm provenance metadata.
- Content-sensitive repository evidence and MCP progress notifications for reliable cross-role handoffs.
- Configurable Reviewer safety policy, protection reporting, and working-tree mutation detection.
- Default run timeout (`DEFAULT_RUN_TIMEOUT_MS`, 10 minutes) wired through `RunnerOptions.defaultTimeoutMs` and `sessionStoragePath`, so unconfigured CLI executions can no longer hang forever.
- Quarantining of corrupt session storage: an invalid `sessions.json` is renamed to `*.corrupt-<timestamp>` and replaced with an empty state instead of failing every command.
- End-to-end cancellation: MCP client timeouts, cancellations, and disconnects now abort the underlying agent process tree (`AbortSignal` threaded from tool handlers through the runner, adapters, executor, and MCP client), record the turn as failed history with full evidence, and never trigger the auto CLI fallback. `ExecutionResult` gains an optional `aborted` flag.
- MCP tool responses include a bounded `Raw Output` section (8000 chars) with vendor CLI stdout/stderr so remote failures remain diagnosable.
- Multi-source context injection: `contextSessionIds` (up to 4) on `delegate_task`, `review_changes`, and `continue_task` injects several sessions' normalized history first-hand with per-source `MATCHED`/`STALE`/`UNKNOWN` freshness, a global 24k character budget with explicit `[truncated]` markers, and a `contextSources` record on each history entry. `continue_task` now accepts context sources alongside the session's own native resume, and an explicit context source no longer suppresses the target session's own bridge history when it has no native session to resume.
- Session storage retention caps: at most 50 history turns per session and 200 sessions (LRU eviction), configurable via `SessionManagerOptions` (`0` disables a cap), so every history append no longer rewrites an unboundedly growing JSON file.
- POSIX process-group termination: agents spawn detached into their own process group so timeout/cancel signals reach vendor-forked background children; group SIGTERM escalates to SIGKILL with a root-process fallback.
- Shared-context attribution guidance: receivers are instructed to cite source session IDs they actually relied on and never claim reuse of information absent from the injected context.
- Graceful server-shutdown cancellation audit: stdio close, SIGINT, and SIGTERM abort in-flight executions through a runner-level controller registry (`abortAllInFlight`), wait (event-driven with a 10s cap) for each aborted run to record its terminal failed turn via the existing turn-recording pipeline, and only then close. A new `client_disconnect` cancel reason distinguishes disconnects from request-level cancels; SIGKILL-style termination remains a documented residual boundary.
- Pre-flight capability diagnostics: `delegateTask`/`continueTask` evaluate requested model/reasoning options against the predicted transport before dispatching (never blocking), merged with post-execution diagnostics under de-duplication; a conservative vendor-refusal classifier emits a structured diagnostic when an error text pairs the requested model id with 4xx/unsupported-model signals.
- codex MCP sandbox mitigation surfaced structurally: the built-in capability matrix carries operational notes for the codex MCP transport (transport-level `notes` field), and results whose MCP output matches the `spawn EPERM` signature automatically receive a warning pointing at the documented mitigation.
- Antigravity artifact-path detection: outputs matching the vendor's "not a valid artifact path" restriction attach a warning that claimed artifacts may be missing from the workspace, on both success and fatal-failure paths.

### Changed

- Raised the supported Node.js baseline to 22.13 and aligned build output with Node.js 22.
- Made `package.json` the single source for CLI, library, and MCP server versions.
- Consolidated overlapping implementation-detail tests while retaining role security, session consistency, process, MCP, and package boundaries.
- Made explicit transport modes strict and normalized Codex summaries from the final agent message.
- Runs OpenCode reviews with its plan Agent and blocks Reviewer-specific extra CLI arguments.
- Preserves multibyte UTF-8 output across process chunks to keep diagnostics and repository fingerprints deterministic.
- **BREAKING:** The Claude adapter is CLI-only because `claude mcp serve` now exposes Claude Code's raw toolset instead of a one-shot task tool; explicit `mode=mcp` returns a structured error.
- Codex MCP calls now match the vendor tool schemas exactly (`codex` with `prompt`/`cwd`/`sandbox`, `codex-reply` with `threadId`/`prompt`) instead of forwarding unrecognized keys, and the MCP client refuses to guess a tool when no recognizable task tool exists.
- Repository evidence caps per-path content fingerprints at 100 changed paths and full-content hashing at 500 untracked files, degrading to coarse evidence so captures stay bounded on large change sets.
- Review verdict parsing trusts bare PASS/FAIL prefixes only near the top of reviewer output; deeper lines must be standalone words or carry a labeled form (`Verdict:`, `Status:`, ...) so quoted diff/test text cannot flip the outcome.
- Consolidated context-source validation, turn recording, and reviewer safety resolution shared by `delegateTask`/`continueTask`; reviewer continuations now fall back to the project config `roles.reviewer.safety` when the session metadata does not pin one.
- Reviewer-role replies outside the strict review contract are no longer fail-closed: an internal `reviewVerdictRequired` flag (set only by `review_changes`) keeps unparseable-verdict reviews failing closed, while general `delegate_task` reviewer-role conversations with a substantive answer now succeed with `reviewOutcome=UNKNOWN` and an explanatory warning; empty or garbage output still fails and explicit FAIL verdicts fail on every entry point.
- Auto-mode transport fallbacks are no longer silent: results carry structured `transportFallback` evidence (`from`/`to`/original error) plus a warning, persisted in session history.
- Validation errors aggregate instead of masking: when both a context-source problem and a role-resolution problem exist, `delegate_task` returns a single combined message; single-cause failures keep the precise reporting.

### Fixed

- Shell-injected `PWD`/`OLDPWD` are no longer inherited by spawned agents; vendor CLIs that trust `PWD` over the spawned cwd (observed with OpenCode) previously operated on the wrong repository.
- MCP `delegate_task` / `continue_task` mark inherited reviewer `FAIL` verdicts as tool errors.
- Explicit `shell: false` resolves Windows npm shims exactly like the default path, and signal-terminated processes report `128 + signum` exit codes.
- A child process exiting before draining stdin no longer crashes the AgentMesh server with an unhandled EPIPE error event on its stdin stream.
- The executor hard-settle fallback no longer fabricates exit code `124` for non-timeout terminations; unobservable exit codes are reported as absent.
- Codex CLI runs keep a substantive final answer when a trailing structured vendor error (e.g. teardown-time `context canceled`) arrives alongside a clean exit code, surfacing the error as a `warning` instead of failing the turn.

### Security

- Pinned the transitive `esbuild` resolution to a non-vulnerable release and normalized the lockfile to the official npm registry.
- Removed `cmd.exe` interpolation from supported Windows npm CLI shims and rejected unrecognized batch launchers.

## 0.1.0 - 2026-08-20

- Published the first usable AgentMesh release with MCP orchestration, role configuration, adapter execution, and Bridge Session context transfer.
