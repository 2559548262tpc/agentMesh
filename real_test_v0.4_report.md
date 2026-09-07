# AgentMesh v0.4 真实压测报告（real_test_v0.4_report.md）

- 测试基线：v0.4 分支，HEAD `94cd14d`（T0 已校验）
- 执行日期：2026-09-03
- 数据目录（隔离）：`D:\temp_pip\agentmesh_v04_e2e\home\`（`AGENTMESH_SESSIONS_FILE` 重定向）
- 实验工作区：`D:\temp_pip\agentmesh_v04_e2e\lab`（独立 git 仓库，HEAD `e259d8e`）
- 模型：全部 opencode 免费模型（`nemotron-3.5-lightning-free`、`mimo-v2.5-free`），未消耗付费配额

---

## 顶部：跨测试总结论（先读这里）

| #   | 测试                                | 结论                                    | 关键证据                                                                                                                                                                                                                  |
| --- | ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0  | 环境准备                            | **通过**（1 个满载 flake 隔离复跑通过） | 分支 HEAD 校验输出、`npm run check` 日志、stdio daemon 连通（`out/t3_daemon_ping.json`）                                                                                                                                  |
| T1  | 后台基线 + 度量落盘                 | **通过**                                | 基线任务 success（259.9s）；`home/metrics.jsonl` 首行、`home/health.jsonl` 首行均记录该任务                                                                                                                               |
| T2  | 工作流状态机双路径                  | **通过**                                | done：`out/t2_done_snapshot.json`（pending→dispatched→running→acceptance→passed，验收命令 TAP 输出 ok）；escalated：`out/t2_escalated_snapshot.json`（验收 exit 1 → stage escalated → workflow escalated，evidence 完整） |
| T3  | 队列/优先级/DAG                     | **通过**                                | `out/t3_p0_*`（优先级抢占）、`out/t3_depunknown.json`（未知依赖拒绝）、`out/t3_cancel_W2.json`（DAG 级联取消）、`out/t3_queued_obs.json`（queued 状态可见）                                                               |
| T4  | cancel/pause 恢复                   | **通过**                                | `out/t4_*`；恢复后任务正常完成（`home/health.jsonl` L11 nova-micro success）                                                                                                                                              |
| T5  | 健康度路由与止损                    | **通过**                                | `home/health.jsonl` L12-14（grok 3 连败 91/72/75ms）、L17（reset）、L20-24（watchdog stall 事件归因到 model）；T7 期间 CIRCUIT_OPEN 熔断自然触发并按预估 274s 冷却恢复（正向实证）                                        |
| T6  | handoff_diff 交接保真               | **通过（有保留）**                      | 下游 3/3 回答正确；`handoff_diff` grade=minor-truncation，content 侧 task/summary/finalAnswer/evidence 全部逐字保留，降级仅因 STALE → **P-076**                                                                           |
| T7  | quick review 机器化 + findings 闭环 | **部分通过**                            | findings 落盘/标签/注入/verify_contract_map 全通过；rework 自动闭环触发但 worker turn vendor 失败致闭环断裂，`confirmed:true` 断言未达成 → **P-075 / P-077 / P-078**                                                      |
| T8  | 数据层健壮性                        | **通过**                                | 垃圾行注入后 `stats --json`/`stats --findings` exit 0、stderr 明示 corrupt line skipped、统计与基线一致（taskCount 29）；ui 面板与 serve 同数据目录（31 任务/29 会话吻合，wf\_\* 子任务可见）                             |

**真实配额消耗估计**：input ≈ 687K tokens、output ≈ 20K tokens（按模型分解见 `out/t8_stats_after.json`：lightning 539K/13.7K、mimo 51K/4.6K、nova-micro 35K/0.3K、unknown 61.6K/1.1K，另有若干零产出失败任务）。全部为免费模型，现金成本 $0。口径：metrics.jsonl 汇总 + worker rework turn usage（117K total）可能部分重叠，属保守上界估计。

**新增立案**：P-075、P-076、P-077、P-078（四段格式见 `PROBLEMS.md`）。

---

## T0 环境准备

**在做什么**：校验分支 HEAD=94cd14d；`npm run build`；`npm run check`；`doctor`/`list_agents`；创建隔离 git 仓库 `lab` 与隔离数据目录；持久化 stdio MCP 守护客户端（`mcp_daemon.mjs`/`mcp_call.ps1`）连通验证。

| 步骤              | Agent | 传输      | 结果                                                      |
| ----------------- | ----- | --------- | --------------------------------------------------------- |
| HEAD 校验         | -     | git       | 94cd14d ✅                                                |
| npm run check     | -     | local     | 1 用例满载超时 flake，隔离重跑通过 ✅（对应已立案 P-074） |
| build/doctor/list | -     | local     | ✅                                                        |
| stdio 连通        | -     | MCP stdio | `__ping` ok ✅                                            |

**偏差**：无（flake 已有立案）。

## T1 后台基线 + 度量落盘

**在做什么**：派发首个后台基线任务，验证 metrics.jsonl / health.jsonl 随派发结果落盘。

- 基线任务 `bgtask_mtl1psl0c2ce6e99`（lightning）success，duration 259.9s。
- `home/health.jsonl` L1：`{"type":"success",...,"taskId":"bgtask_mtl1psl0c2ce6e99"}`；`home/metrics.jsonl` 同步记录。
- 证据：`out/t1_stats.json`、`out/t1_health.json`、`out/t1_terminal_result.json`。

**偏差**：无。

## T2 工作流状态机（done/escalated 双路径）

**在做什么**：验证 workflow 状态机的确定性转换与两条终止路径。

- **done 路径**（`wf_mtl25r76b3600992` / t2-done-fizz）：implement-fizz stage 五态转换齐全，验收命令 `node --test src/*.test.mjs` TAP 3/3 pass、`acceptance.ok=true`；review stage `initialVerdict=PASS`；workflow 终态 `done`。证据：`out/t2_done_snapshot.json`。
- **escalated 路径**（`wf_mtl2cqre94beadae` / t2-escalated）：验收命令 `node -e "process.exit(1)"` exit 1 → stage `escalated`、review stage 保持 pending、workflow 终态 `escalated`，`evidence.outcome/reason/finalError/repository` 完整落盘。证据：`out/t2_escalated_snapshot.json`。

**偏差**：无。escalated 后 review stage 未派发（不浪费配额），符合"escalated 即终止"预期。

## T3 队列/优先级/DAG

**在做什么**：并发上限下的排队顺序（priority 0 vs 5）、DAG 依赖调度、未知依赖拒绝、队列内取消。

- 优先级：P0 任务先于 P5 执行（`out/t3_p0_dispatch.json`、`out/t3_p5a/b_*`）；排队任务状态 `queued` 可观测（`out/t3_queued_obs.json`）。
- DAG：依赖链按序调度；引用不存在依赖被拒绝（`out/t3_depunknown.json`）；取消 W2 后其下游不执行（`out/t3_cancel_W2.json`）。
- 证据群：`out/t3_*.json`（30+ 文件）。

**偏差**：无。

## T4 cancel/pause 恢复

**在做什么**：运行中任务 cancel 与暂停后恢复的语义与状态一致性。

- cancel 的任务状态与 metrics `outcomes.cancelled` 一致（基线中 lightning cancelled=2）。
- 恢复通道正常：恢复后派发的任务成功完成（`home/health.jsonl` L11，nova-micro，26.8s）。
- 证据：`out/t4_*.json`。

**偏差**：无。

## T5 健康度路由与止损

**在做什么**：连续失败注入 → 隔离（quarantine）→ reset → 恢复；stall 事件归因。

- grok/grok-4.5-low 注入 3 连败（91/72/75ms）→ 第 4 次派发被隔离拒绝；`reset` 事件（L17）后可再派发。
- bogus 模型（claude-bogus-model-xyz、openrouter/openai/gpt-chat-latest）失败被记录并参与健康评分。
- watchdog：T7 评审超时自动产生 `stall` 事件（L20-23），taskId 归因正确，模型侧补记 `failure kind=stall`（lightning durationMs≈600s 上限）。
- **生产形态正向实证**：T7 期间 opencode 连续 5 败后 CIRCUIT_OPEN fail-fast 拒绝派发，返回预估恢复 274s，冷却后重试成功。
- 证据：`home/health.jsonl` 全文；`out/t5_*.json`。

**偏差**：无。

## T6 handoff_diff 交接保真

**在做什么**：上游 worker 会话产出（SPEC 矛盾裁决任务）经 `contextSessionIds` 注入下游轻任务，下游仅凭注入上下文回答 3 个事实问题；`handoff_diff` 机器判级。

| 项           | 结果                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游会话     | bridge-sess_3e3e1ee18856（worker，romanToInt SPEC 裁决）                                                                                                         |
| 下游任务     | bgtask_mtl3vwp56bd36168（lightning，27.9s，exit 0）                                                                                                              |
| 下游 3 问    | 矛盾点 ✅ / IV=4 ✅ / MCMXCIV=1994 验证通过 ✅（3/3）                                                                                                            |
| handoff_diff | grade=**minor-truncation**；basis=**content**（逐字审计注入内容）；preserved=task/summary/finalAnswer/evidence；missing/truncated=none；注入 2996 字符无截断标记 |
| 降级原因     | freshness **STALE**（上游 repositoryAfter fingerprint ≠ 派发时 fingerprint）                                                                                     |

**偏差与立案**：内容侧实际无损，grade 被 STALE 机械化降级。根因：lab 无 .gitignore，`.agentmesh/config.json` 处于 modified 状态且被 fingerprint 采集，AgentMesh 自身运行时写配置即改变 fingerprint → 下游永远 STALE。**立案 P-076**。

## T7 quick review 机器化 + findings 闭环

**在做什么**：worker 实现带 SPEC 矛盾雷的 slugify → reviewer 评审制造 FAIL → findings 落盘 → 自动 rework 注入 → 复审 PASS → `confirmed:true` 断言 → `verify_contract_map` 合法/错行 map。

| 步骤                           | Agent/模型         | 传输           | 耗时   | 结果                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------ | -------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker 实现                    | opencode/lightning | background cli | 488.1s | ✅ success，exit 0（bridge-sess_9cfa624a5f4c）；识别 SPEC 矛盾但未裁决静默选边，CONTRACT-2 声称与实际行为不符                                                                                                                                                                                   |
| review #1/#2                   | opencode/lightning | background cli | 600s×2 | ❌ exit 124（vendor 卡死）→ **P-075**；watchdog 正确记 stall                                                                                                                                                                                                                                    |
| review #3                      | opencode/mimo      | background cli | 300s   | ❌ exit 124（同因）                                                                                                                                                                                                                                                                             |
| review #4（只读简报）          | opencode/mimo      | background cli | ~600s  | ✅ **FAIL** 3 findings，全带 `category:`/`kind:` 标签（critical=虚假 CONTRACT-2 声称；high=contract map 误导；medium=SPEC 矛盾未上报）；exitCode 0，业务 FAIL 与执行成功正确分离                                                                                                                |
| findings 落盘                  | -                  | -              | -      | ✅ findings.jsonl 3 条（findingId/sessionId/taskId/reviewerAgent/category/kind/severity/file/line/reviewedAt）                                                                                                                                                                                  |
| 自动 rework ROUND 1            | opencode/lightning | background cli | 354.1s | ⚠️ findings 完整注入 worker（"REWORK ROUND 1 OF 3"含全部 finding+suggestion+DoD）；worker 修复落盘（slugify.mjs 改码 + 新建 CONTRACT.md）但 vendor turn **exit 1/UnknownError/0 字节输出** → 闭环断裂 → **P-077**                                                                               |
| 熔断                           | -                  | -              | -      | ✅ opencode 连续 5 败 → CIRCUIT_OPEN fail-fast（预估 274s），冷却后重试成功（T5 机制自然生效）                                                                                                                                                                                                  |
| 复审 ROUND 2（手动，裁决注入） | opencode/mimo      | background cli | 243.3s | ✅ **PASS**（1 个 non-blocking finding 也落盘 findings.jsonl 第 4 条）                                                                                                                                                                                                                          |
| confirmed 断言                 | -                  | -              | -      | ❌ `stats --findings`：opencode 4 findings / confirmed 0 / precision 0.0%。机制核实：confirmed 仅在同一 review_changes 调用内 rework 闭环 PASS 时写入（`src/mcp/tools.ts` recordReviewFindings）；本例闭环断于 worker turn vendor 失败，手动复审 PASS 无 rework 上下文无法补记 → 归入 **P-077** |
| verify_contract_map 合法 map   | -                  | local          | <1s    | ✅ pass:true，3 项全 ok                                                                                                                                                                                                                                                                         |
| verify_contract_map 错行 map   | -                  | local          | <1s    | ✅ pass:false，逐项精确：out-of-bounds（999 超 1..7）/ empty（空白行）/ missing（ENOENT）/ unknown-item                                                                                                                                                                                         |

**与预期偏差**：

1. 评审简报含"验收脚本必须通过"即诱导 opencode 命令执行卡死（三连复现）→ P-075。
2. rework 闭环无 worker turn 失败重试，断裂后 confirmed 信号永久丢失 → P-077。
3. opencode 适配器把 vendor 错误压缩为 APIError/UnknownError，无法分类 MODEL_REJECTED → P-078（T0-T5 阶段发现，此处正式立案）。

## T8 数据层健壮性

**在做什么**：向 metrics.jsonl/findings.jsonl 尾部注入垃圾行（非 JSON/截断 JSON），验证 stats 容错；启动 `agentmesh ui` 验证面板与 serve 数据目录一致性。

- 污染：metrics.jsonl +1 行 `{{{not valid json!!`；findings.jsonl +1 行 garbage +1 行截断 JSON。
- `stats --json`：exit 0，stderr 警告 "corrupt line; it was skipped"，taskCount=29、lightning outcomes/tokensIn 与污染前基线完全一致。
- `stats --findings`：exit 0，同样警告，opencode 仍 4 条、precision 表正常。
- `agentmesh ui`（端口 7799）：`/api/tasks` 31 个任务（T7 全链 review 任务与状态逐一吻合）、`/api/sessions` 29 个会话（role/agent 正确）、`wf_*` 工作流子任务可见且状态正确 → 面板与 serve 读同一数据目录（r21 类 bug 未复现）。
- 证据：`out/t8_stats_before.json`、`out/t8_stats_after.json`、本报告记录的面板 API 响应。

**偏差**：CHANGELOG 已知项"排队任务可能显示为已启动"本轮未复现（无并发排队窗口）→ 保持 v0.5 跟进确认，不算新缺陷。观察项：面板 `/api/*` 响应未带 charset 头，非浏览器客户端按 ISO-8859-1 解码时中文乱码（浏览器按 HTML meta 正常，影响待确认）。

---

## v0.5 候选跟进项汇总

1. **P-075**：review prompt 契约固化"评审只读、禁止命令执行"（当前靠简报自觉，三模型复现卡死）。
2. **P-076**：repository fingerprint 排除 `.agentmesh/` 等运行时目录，消除 handoff freshness STALE 误报。
3. **P-077**：rework worker turn 失败自动重试；rework 闭环断裂时提供 confirmed 补记通道（或允许带 rework 上下文的独立复审写 confirmed）。
4. **P-078**：opencode 适配器保留 vendor 错误原文（至少分类到 MODEL_REJECTED/CAPABILITY_MISMATCH），支撑升级链路由。
5. 面板 `/api/*` 补 `charset=utf-8`。
6. CHANGELOG 已知项确认：排队任务在面板的"已启动"显示（本轮未复现，需在并发排队窗口实测）。
7. 满载 flake（P-074）长期观察。
8. **P-079**：workflow 对 isRetryable TRANSIENT dispatch 失败增加有界退避重试 + `workflow run --resume` 断点续跑（第二轮 air 压测立案，见下）。

---

# 第二轮（2026-09-04）：air 粒子复刻页 · 双模型分工 workflow

**在做什么**：复刻 otsuka-air.jp 交互体验（全屏粒子 canvas 随滚动在 4 张风景图之间 morph + 加载百分比遮罩 + 文字 reveal + 章节叙事），素材与文案全部替换（picsum.photos 免版权风景图 ×4、通用治愈系名人名言），作为 v0.4 workflow 第二轮真实压测。目标路由：antigravity（validators + implement-engine + review）+ opencode/`tokenrhythm/glm-5.3-flash`（implement-content）。项目目录 `f:\AgentMesh_8_28\v04_demo\air\`（CONTRACT.md + 官方验收 tests/acceptance.mjs 20 项 + workflow.spec.json 四阶段）。

**双模型路由机制（新验证点）**：workflow spec 的 dispatch 无 per-stage model 字段，model 仅能从 role assignment 注入（runner.ts `params.model ?? roleResolution.assignment?.model`）。本轮以 `roles:["tester"]` 承载 `{agent:"opencode", model:"tokenrhythm/glm-5.3-flash"}` 绑定、worker/reviewer 保持 antigravity，实现阶段级模型隔离互不污染。metrics.jsonl 证实注入：`role=tester, agent=opencode, model=tokenrhythm/glm-5.3-flash`。

**结果链**：

| 阶段                      | workflow                                                          | 结果                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| validators                | wf_mtlr056zb5ab8b69                                               | PASS（契约一致性核对 + shared suite 6/6）                                                                                   |
| implement-engine          | 同上                                                              | PASS（antigravity，engine.js 22KB + engine.css，自检 7/7）                                                                  |
| implement-content         | 同上                                                              | **ESCALATED**：opencode 503「模型服务暂时不可用」isRetryable:true（86s，0 token，vendor 瞬态），exit 2 fail-closed 证据落盘 |
| implement-content（重试） | wf_mtlrioind5ae1847（退避 150s 后裁剪版 spec：仅 content+review） | PASS（glm-5.3-flash，252.8s，37.1K in/3.7K out，自检 7/7，零越界改动）                                                      |
| review                    | 同上                                                              | PASS（antigravity plan 模式只读简报，initial=PASS，reworkRounds=0），**DONE exit 0**                                        |

**终验**：acceptance 全量 **20/20 exit 0**；浏览器冒烟（本地静态服务 :8788）：loader 0→100% 隐藏、canvas 粒子场渲染、滚动 morph（hero 白色星域 → scene-2 蓝色水纹，粒子颜色采样自图片像素）、reveal 动画触发、5/5 语录卡含作者（泰戈尔/罗曼·罗兰等）、控制台无 JS 错误。

**偏差与立案**：

- tokenrhythm 503 一次（vendor 瞬态，退避后恢复）。workflow 对 isRetryable TRANSIENT dispatch 失败无内置退避重试，且 `workflow run` 无断点续跑 → 只能人工裁剪 spec 变体恢复。**立案 P-079**（与 P-077 的 fail-fast 同族，fail-closed 行为本身正确）。
- 测试基建备忘：browser navigate 安全策略禁 `file://` → 以 `server.cjs` 静态服务绕过；`node -e` 内联脚本被 PowerShell 引号转义破坏 → 改 .cjs 文件；首次截图 IDE 超时，重试成功。
- 双模型结论：antigravity 交付 22KB 长文件引擎一次通过；tokenrhythm/glm-5.3-flash 交付 8.8KB 内容层一次通过（重试后）；两个模型产物均零 rework。
