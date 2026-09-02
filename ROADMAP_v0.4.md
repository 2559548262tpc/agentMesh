# AgentMesh v0.4 改造方案（外视角重构版）

> 本文档源自一次外部视角评审（速度/效率/编码准确率/架构/交互五个维度），
> 核心论断：**过去用"更聪明的提示词纪律"解决本该用"更笨但可靠的代码"解决的问题**。
> 与旧计划 [OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md)（v0.3 五源融合版，P1-P5）的关系见 §14 映射表。
> 旧计划未被否定，本方案是其上的重新排序与补缺。

---

## 0. 设计红线（继承 AGENTS.md，不可违背）

1. MCP 工具名与 schema、runner 参数类型、README 工具文档、协议测试四者同步变更。
2. 默认测试/CI 不消耗真实 vendor 配额、不需要真实凭据。
3. 严格 TypeScript + typed ESLint 通过；NodeNext 相对导入带 `.js` 后缀。
4. vendor CLI/MCP 契约原样保留，改动前对照已安装 CLI 验证。
5. 导出符号、MCP schema、CLI 命令、config schema、持久化 Session shape 是兼容面，按 SemVer 处理。
6. 不弱化编译/lint/覆盖率阈值换取通过。
7. 每个里程碑独立可发布、可回滚；新能力一律以"附加"方式接入，不破坏既有默认路径（M5 安全翻转除外，见其内部说明）。

---

## 1. 核心论断与证据链

| #   | 论断                                       | 证据                                                                                             |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | 外置 Orchestrator 是最大成本与不确定性来源 | r17 组长 6.83M tokens；节流纪律（大文件不进上下文、主动 compact、≤3M 预算）全部是提示词层治疗    |
| 2   | 人工压测不可持续                           | r21/r22 手工重新发现同类故障：0 字节僵死、模型截断、APIError、轮询低效、上下文丢失               |
| 3   | Reviewer 价值从未度量                      | r21 约 1.4M tokens 花在评审；两段式/增量复审是流程补丁，无查准率数据                             |
| 4   | 模型路由依赖组长"伤疤记忆"                 | nemotron 僵死、muse-spark APIError、ling 截断等教训存在 LLM 上下文与 memory，而非数据            |
| 5   | 存储碎片化                                 | sessions JSONL + registry.jsonl + config.json + capabilities.json + env 重定位，r21 面板读错目录 |
| 6   | 优先级倒置                                 | r21 才补 `cancel_task` 原语，同期面板在做图标/token 卡片                                         |
| 7   | 安全边界错位                               | H5/H9 prompt-only 通道被注入攻破，对策是"文本里不写危险命令"（打地鼠）                           |
| 8   | 交接保真度无工具                           | real_test.md 的损失等级靠人肉对比，违反"下游自述视为幻觉"原则                                    |

---

## 2. 里程碑总览与依赖

```
M0 度量先行 ──────────────┬─→ M2 健康度路由 ─┐
                          ├─→ M3 评审度量 ───┤
M1 仿真 harness ──────────┴─→ M5 安全翻转 ────┼─→ M4 工作流状态机（核心）
                                              │
M6 统一数据层 ────────────────────────────────┤（独立，可并行）
M7 生命周期原语 + 交接保真 ───────────────────┘
```

- M0、M1 是地基：先度量、先仿真，之后所有改动都有验收依据。
- M4（确定性编排状态机）是本方案的核心交付，其余里程碑为其供弹药。
- M6、M7 相对独立，可穿插进行。

---

## 3. M0：度量先行（无行为变更）

### 目标

让每一个论断从"印象"变成"数字"。不改变任何现有行为。

### 改动点

- 新增 `src/core/metrics.ts`：
  - 每任务记录：`{taskId, role, agent, model, tokensIn, tokensOut, durationMs, retries, reviewRounds, stallEvents, cancelEvents, outcome}`。
  - 以附加字段形式并入 `registry.jsonl` 任务记录（保持向后可读）。
  - 复用 r21 已有的 token 卡片数据源，避免重复计量。
- Reviewer findings 结构化：`review_changes` 结果中 findings 增加机器可读形态 `{id, category, file, line, severity, kind: defect|style|risk}`（自由文本保留）。
- 交接记录：每次带 `contextSessionIds` 的派发，记录上游 history 摘要指纹与实际注入指纹（M7 的 `handoff_diff` 在此数据上工作）。
- 新增 CLI `agentmesh stats`：按模型/角色/时间窗聚合（消耗、耗时、重试率、stall 率、review 确认率）。
- 指标定义复用旧计划附录 B.5（指标公式已冻结，直接采用）。

### 验收标准

- [ ] 任何通过 MCP 派发的任务（含后台）都产生完整 metrics 记录。
- [ ] `agentmesh stats` 输出各模型 stall 率与各 reviewer 确认率。
- [ ] 既有协议测试全部通过，无行为变更。

---

## 4. M1：fake-vendor 仿真 harness（最高优先）

### 目标

把每一轮人工压测发现的故障类别变成 CI 里的回归场景。**用确定性的假故障替代真实配额压测。**

### 改动点

- 新增 `scripts/fake-vendors/fake-vendor.mjs`：可脚本化的假 vendor CLI，通过配置文件/环境变量切换模式：
  - `ok`（正常完成）/ `stall`（0 字节输出后挂起）/ `truncate`（长输出中途截断）/ `apierror`（结构化报错）/ `slow`（超阈值延迟）/ `semantic-fail`（exit 0 但语义失败）/ `exit-mismatch`（exit 与语义不一致）。
  - 通过 agents registry 的 binary override 机制接入（复用既有 fake-CLI 集成测试基建，`tests/**/*.integ.ts` 模式）。
- 新增 `tests/simulation/`：场景文件（JSON/TS）描述多 worker 流水线 + 注入故障，断言 AgentMesh 行为：
  - stall 在阈值内被检测并自动止损；
  - 沿升级链自动重派，不需要组长介入；
  - `cancel_task` 杀掉完整进程树、无孤儿进程（Windows 进程树语义纳入）；
  - 交接后 `contextSources` 包含必需键；
  - 后台任务终态与面板语义一致。
- 快速子集并入 `npm test`（进程内，<30s）；全矩阵新增 `npm run test:simulation` 进 CI 质量门。
- r21/r22 已知故障全部建场景：opencode reviewer `--agent plan` 0 字节夭折、muse-spark APIError、ling 截断、nemotron 僵死、reviewer 误报 running 终态。

### 验收标准

- [ ] real_test.md（r21/r22）中每个故障类别至少有一个对应仿真场景且 CI 通过。
- [ ] 仿真全程无真实凭据、无配额消耗。
- [ ] Windows 进程树清理（.cmd、PATH 解析）在场景中覆盖。

---

## 5. M2：模型健康度自动路由与自动止损

### 目标

路由决策从"组长记忆"迁移到数据。模型健康状况是活数据，不是 LLM 上下文里的教训。

### 改动点

- 新增 `src/core/health.ts`：按模型维护滚动窗口 `{stallCount, errorCount, successCount, p50/p95 durationMs, lastFailureAt}`，持久化进 capabilities 存储。
- 健康分 = 衰减后的失败率；熔断：连续 N 次失败 → 隔离（路由排除）→ 定期廉价探针任务尝试恢复。
- `capabilities.ts` / `registry.ts`：候选解析顺序 = tier 匹配 → 健康分 → costLevel；`hint.nextCandidates` 升级链按健康分重排。
- 数据来源：runner.ts / background.ts 已检测 stall/error，增加向 health store 的自动上报（一行接线）。
- 新增 CLI `agentmesh health`；面板增加健康度视图。
- MODEL_ROUTING_GUIDE.md 中"人工经验"段落改写为数据口径说明。

### 验收标准

- [ ] M1 仿真注入"nemotron 式"连续 stall 序列 → 引擎自动换模型重派，全程无组长轮次。
- [ ] 隔离的模型在探针恢复后自动回到候选链。
- [ ] 健康分随时间衰减（无新数据时旧劣迹影响减小）。

---

## 6. M3：评审价值度量与 findings 毕业

### 目标

回答"reviewer 到底值不值"，并把重复出现的缺陷类别下沉为机器检查，使 LLM 评审范围持续收缩。

### 改动点

- **精确率追踪**：rework/tester 完成后回填每个 finding 的 `confirmed: boolean`（是真缺陷还是误报）；`agentmesh stats` 输出各 reviewer 模型精确率。
- **quick review 自动化**：CONTRACT.md 的契约项本身是机器可核对清单 → worker 交付时必须输出"契约项 → file:line 映射"→ 脚本验证映射存在、文件行非空。这一步不再消耗 LLM tokens（替代现有两段式评审的第一段）。
- **deep review 收缩**：LLM 评审只保留测试测不到的维度——`kind: security|semantic|risk` 且仅针对变更文件；`style` 类 findings 一律退回给 lint。
- **findings 毕业**：同一 category 累计出现 ≥ K 次 → 自动生成 PROBLEMS.md 条目 + 提案：转为 ESLint 自定义规则 / codemod / SPEC 验收脚本项。ORCHESTRATION.BASE.md §3 的 SPEC 模板增加"静态检查清单"节，由毕业流水线自动维护。
- 评审派发策略更新到 ORCHESTRATION.md：quick review 机器化后，reviewer 只做深度评审。

### 验收标准

- [ ] 精确率报告可用，r21 式"1.4M 评审浪费"可被数字复盘。
- [ ] 至少 3 个历史重复缺陷类别完成毕业（ESLint 规则或验收脚本）。
- [ ] quick review 的 LLM token 消耗降为 0。

---

## 7. M4：确定性编排状态机（产品化 Orchestrator，核心）

### 目标

把"拆解→派发→收结果→验收→复审→重派"这个 90% 确定性的循环从外置 LLM 移入进程内状态机。LLM 组长只在两个点被需要：写 spec、处理升级。

### 设计

```
WorkflowSpec（YAML/JSON，进仓库可审计）
  stages[]:
    name, roles: [worker|reviewer|tester]
    parallelGroups[]            # 互斥文件集的并行包
    dispatch: {agent, taskTemplate, contextPolicy: contextSessionIds}
    acceptance: {commands[], files[]}   # 可执行 SPEC 正式化，引擎直接执行
    policy: {maxReworkRounds, stallPolicy, reRoutePolicy, escalation}
状态机: PENDING → DISPATCHED → RUNNING → ACCEPTANCE
        → REVIEW →(PASS→next stage | FAIL→REWORK 环)→ DONE | ESCALATED
等待全部事件驱动（复用 events.ts 事件总线 + poll_task maxWaitMs 基建，零固定间隔轮询）
派发/复审通过进程内函数调用，不走 MCP 自环
```

### 改动点

- 新增 `src/core/workflow.ts`：spec zod schema + 状态机 + 执行器。
- 新增 MCP 工具 `run_workflow(spec)` / `get_workflow(workflowId)`（兼容面为**附加**，minor 版本）。
- 新增 CLI `agentmesh workflow run <spec.yaml>`。
- 失败处理按既有自动化循环接线：`TRANSIENT/SPAWN_FAILED` 桥接层已处理；`MODEL_REJECTED/CAPABILITY_MISMATCH` → 按 health 排序的升级链重派；stall → M2 熔断换模；3 轮 rework 仍 FAIL → `ESCALATED`（唯一回到 LLM 组长/人类的点）。
- 验收命令执行、测试运行、`git diff` 摘要生成全部由引擎完成（"done 的定义"从纪律变成代码）。
- ESCALATED 携带完整证据链：原始错误、历次 findings、diff 摘要、metrics。

### 验收标准

- [ ] 用单一 spec 复现 r22 式 5-worker + 3-reviewer + 2-tester 流水线：派发到总结之间组长零轮次（除非 ESCALATED）。
- [ ] 组长单轮 token 消耗 ≤ 0.5M（r17 基线 6.83M）。
- [ ] 既有全部 MCP 工具行为不变（兼容面零破坏）。
- [ ] M1 仿真覆盖：状态机对 stall/rework/escalation 的处理。

---

## 8. M5：安全默认翻转

### 目标

从"依赖攻击者善意"改为"边界防御"。prompt-only 不再是默认形态。

### 改动点

- 派发默认 `sandboxLevel: enforced`；prompt-only 需在 config 或 spec 中显式声明 `trust: "prompt-only"`，config 校验对未声明使用输出警告。
- ORCHESTRATION.md / README 安全章节同步改写：明确"prompt-only 通道按会照做任何指令对待（H5/H9 实证）"。
- M1 仿真新增注入攻击场景：任务文本含破坏性指令 → enforced 通道不执行。
- Reviewer 只读强制与平台降级如实报告的既有要求保持不变。

### 兼容性说明

这是唯一有意的行为默认变更：按 SemVer 记 BREAKING CHANGE（或经 config 默认值迁移 + 警告期过渡，二选一在实施时定）。

### 验收标准

- [ ] 默认配置下注入场景被沙箱拦截。
- [ ] 显式声明 prompt-only 的既有用法仍可用且有警告。

---

## 9. M6：统一数据层（可选，中期）

### 目标

消灭四套手搓小型数据库之间的手工同步。

### 改动点

- 选型：优先 Node 内建 `node:sqlite`（不新增依赖，符合既有零依赖倾向；若 API 不稳再退 better-sqlite3）。
- 表：sessions、turns、tasks、findings、health、metrics。一次性迁移工具 `agentmesh migrate --from jsonl`。
- `AGENTMESH_SESSIONS_FILE` 作为 legacy 别名继续生效 + 弃用警告（r21 数据根重定位问题的根治）。
- `ui/api.ts` 切换为 SQL 查询；SSE 由数据库事件驱动，删除文件监听残留。
- 面板"只读 `~/.agentmesh`"约束由数据层统一接管。

### 验收标准

- [ ] r21"面板读错目录"类 bug 在结构上不可能复现。
- [ ] 迁移工具往返验证：旧 JSONL 数据迁移后协议测试全绿。
- [ ] 文件监听代码删除。

---

## 10. M7：生命周期原语与交接保真工具

### 目标

原语优先于打磨；交接保真从人肉判定变成机器判定。

### 改动点

- `cancel_task`：~~已有（r21）~~ **M1 仿真 S3 证实尚未实现**（当前唯一取消原语是 transport close / graceful shutdown 的 abortAll），提前到 Wave 3 作为独立小任务落地（MCP 工具 + 进程树终止 + README/协议测试）。
- 补齐：
  - **任务优先级**：队列排序 + 抢占策略。
  - **依赖 DAG**：task 增加 `deps: []` 字段，调度器并行运行就绪集（与 M4 的 parallelGroups 互补）。
  - **暂停/恢复**：以"取消 + continue_task 带规范化上下文恢复"实现（不假设 vendor 支持 SIGSTOP）。
- 新增 MCP 工具 `handoff_diff({upstreamSessionId, downstreamSessionId})`：
  - 对比上游规范化 history 与下游实际注入 `contextSources`；
  - 输出 `{grade: lossless|minor|partial|severe|lost, missingKeys[], preservedSections[]}`；
  - M0 的交接指纹数据是其输入。
- M4 工作流引擎在每次交接后自动调用并写入 metrics。
- 面板：工作流 DAG 进度视图（替代逐任务树的手工追踪）、健康度仪表盘（M2 数据）。

### 验收标准

- [ ] real_test.md 的交接损失分析由 `handoff_diff` 生成，不再人肉对比。
- [ ] 关键交接 100% lossless 可断言；出现 partial 以上自动升级警告。
- [ ] DAG 依赖的任务在仿真中按依赖序执行且就绪集并行。

---

## 11. 实施顺序建议

1. **M0 + M1**（地基，先行合入）：度量与仿真不改变行为，风险最低，立即让后续一切有依据。
2. **M2 + M3**（数据驱动化）：在仿真保护下改路由与评审。
3. **M4**（核心交付）：状态机 + `run_workflow`。
4. **M5**（安全翻转）：跟随 M4 的 spec 机制一起发布。
5. **M6 / M7**：穿插或紧后。

每步遵守：实现 → M1 场景回归 → `npm run check` 全绿 → README/PROBLEMS.md 同步。

---

## 12. 成功指标（总验收口径）

| 指标                 | 基线                    | 目标                             | 归属  |
| -------------------- | ----------------------- | -------------------------------- | ----- |
| 组长 token/轮        | 6.83M (r17)             | ≤ 0.5M                           | M4    |
| 同规模任务端到端时长 | 46min (r21 分析)        | ≤ 20min                          | M2+M4 |
| Stall 检测+止损      | 人工盯守、分钟级        | 自动 ≤ 30s                       | M2    |
| Reviewer 确认率      | 未度量（1.4M 浪费案例） | 度量并 ≥ 70%                     | M3    |
| 人工压测依赖         | 每轮真实配额            | 故障类别 100% 仿真覆盖           | M1    |
| 交接损失判定         | 人肉对比                | 机器判定，关键交接 100% lossless | M7    |
| 注入攻击             | H5/H9 被攻破            | 默认配置拦截                     | M5    |

---

## 13. 风险与回滚

| 风险                               | 缓解                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| 状态机表达力不够，复杂决策硬编码化 | spec 保留 `escalation` 逃生门；LLM 组长永远可接管；spec 是声明式可审计文本          |
| `node:sqlite` 实验性 API 不稳      | M6 本身可选；退 better-sqlite3 或推迟                                               |
| sandbox 默认翻转破坏既有用法       | 警告期过渡或 BREAKING CHANGE 显式发布（M5 内定夺）                                  |
| 健康分误杀慢但好的模型             | 隔离必须走探针恢复；健康分只影响排序不永久禁用                                      |
| 仿真场景与真实 vendor 行为漂移     | 每轮真实测试（按需 opt-in）的新故障持续回流为场景；场景文件与 real_test.md 双向索引 |

---

## 14. 与旧计划 OPTIMIZATION_PLAN.md（v0.3 五源版）的映射

| 旧计划                            | 本方案                           | 关系                                             |
| --------------------------------- | -------------------------------- | ------------------------------------------------ |
| P1 可靠派发协议层                 | 已落地（事件总线/SSE/maxWaitMs） | 完成项，M4 直接复用其基建                        |
| P2 Token 计量与压缩               | M0                               | M0 聚焦"度量先行"定位，附录 B.5 指标公式直接沿用 |
| P3 分 vendor 安全基线             | M5                               | 从"基线"升级为"默认翻转"，立场更强               |
| P4 强弱模型调度（手动元数据路由） | M2                               | 从手动元数据升级为数据驱动健康分 + 熔断          |
| P5 无人值守闭环                   | M4                               | 从"闭环"升级为声明式状态机 + 可审计 spec         |
| 附录 B 评测口径                   | M0/M1                            | 冻结的基准场景卡直接成为仿真场景的验收依据       |
