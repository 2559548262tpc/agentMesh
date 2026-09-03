# AgentMesh v0.4 真实压测指令（新窗口执行）

- 目标：对 `feat/v0.4-transformation` 分支的 v0.4 新能力做一轮真实多智能体压测（真实 vendor CLI、真实配额），验证对象是 **M0-M7b 全部新能力在生产形态下的表现**，不是单测复跑。
- 分支基线：`git log --oneline -3` 的 HEAD 必须是 `94cd14d`（docs: close out v0.4 changelog...）。若不在该分支/提交，先停止并报告。
- 产物：本目录 `real_test_v0.4_report.md`（测试记录）+ `%TEMP%\agentmesh_v04_e2e\out\`（每次调用的原始 MCP 返回、transcript、JSON 快照）。报告只写有原始证据支撑的结论，每条结论注明证据文件路径。
- 纪律（与前几轮 real_test 相同）：不跳过失败、不伪造证据、不重试掩盖失败；失败按 AGENTS.md 四段格式立案为 PROBLEMS.md `P-075+`（问题/根因/解决方法/状态），解决方法只能落在 AgentMesh 代码上，不允许通过改测试任务让失败消失。

## T0 环境准备（不消耗配额）

1. `npm run check` 全绿后再开始（若出现 P-074 类满载 flake：受害者轮换且隔离重跑通过 → 记录后继续；同一用例连续失败 → 立案）。
2. `npm run build`；隔离测试数据目录：`AGENTMESH_SESSIONS_FILE=%TEMP%\agentmesh_v04_e2e\home`（全新目录，metrics/health/findings 全部从零开始，这样 T1 的落盘断言才干净）。
3. `node dist/cli/index.js doctor`：预期 0 FAIL；`node dist/cli/index.js list`：确认 codex / antigravity（或可用 vendor）可用，记录版本号。
4. 新开独立 git 仓库 `%TEMP%\agentmesh_v04_e2e\lab\`：初始提交一个 `SPEC.md`（自定一个有真实矛盾点的小规范，参考 real_test.md 测试一的 SPEC 埋雷手法——埋一个「示例与规范矛盾」的雷，后续 T6/T7 会用到）。
5. Orchestrator 通过 stdio JSON-RPC 直连 `node dist/cli/index.js serve`（环境变量带上第 2 步的 AGENTMESH_SESSIONS_FILE 与 T3 的 cap 变量，见下）。

## T1 后台基线链路 + 度量/健康落盘（M0/M2）

1. `delegate_task`（worker 角色，background）派发「按 SPEC 实现 src/roman.mjs」；用 `poll_task maxWaitMs=30000` 长轮询（**一次调用**阻塞到终态）。
2. `get_session` 拿规范化历史；断言 `finalAnswer`/`summary` 非空且含结题结论（对照 real_test.md 的 P1/P2 教训——若再出现 summary 退化为 "```" 之类，直接立案）。
3. 证据链：`agentmesh stats --json` 出现该次派发记录（role/agent/model/tokens/duration）；`agentmesh health --json` 出现对应 success 事件。metrics.jsonl / health.jsonl 的原始行存档。

## T2 工作流状态机（M4）——done 路径 + escalated 路径

1. **done 路径**：`run_workflow` 提交 spec：stage1 worker 实现 SPEC 中第二个小模块；`acceptance.commands: ["node --test src/*.test.mjs"]`（worker 需自附测试）；stage2 reviewer 复审（`maxReworkRounds: 1`）。`get_workflow maxWaitMs=30000` 长轮询到终态，预期 `done`。
2. **escalated 路径**：同 spec 但 `acceptance.commands: ["node -e \"process.exit(1)\""]`（必失败）→ 预期 `escalated`，且快照证据链完整（验收命令输出、逐轮 findings、仓库 diff 摘要）。
3. 记录两次工作流的 stage 耗时与事件序列；工作流 stage 任务 ID（`<workflowId>_s<stage>_<seq>`）用 `poll_task` 抽查一次增量输出。

## T3 队列 / 优先级 / 依赖 DAG（M7b）

以 `AGENTMESH_MAX_CONCURRENT_BACKGROUND_TASKS=1` 重启 serve（记录该变量生效方式）。

1. **优先级**：连续派发 3 个轻量后台任务（priority 5、0、5；任务用「读 SPEC 并复述一条规范」级别的轻指令省配额），断言完成顺序与 priority 排序一致（priority 0 先完成）；期间 `poll_task` 至少观察到一次 `queued` + `queuePosition`。
2. **DAG**：A(实现) → deps[A] 的 B(自检报告)；再派发 C，deps 指向一个必然失败的任务 D（例如要求 agent 执行一个 vendor 必拒绝的操作，或直接 deps 指向不存在任务 → 断言派发时即报 `DEP_UNKNOWN`）。C 预期收到 `DEP_FAILED` 且从未启动 vendor 进程（poll_task 观察不到 running）。
3. 取消排队任务：在上一步队列非空时对队首 `cancel_task`，断言纯状态转换（无进程回收副作用）。

## T4 cancel / pause → resume（M4 cancel_task + M7b pause_task）

1. 派发一个耗时任务（真实实现任务），运行中 `cancel_task` → 断言终态 failed/cancelled、checkpoint 溢出（checkpoints/ 目录有文件）、`poll_task` 之后幂等返回终态。
2. 派发第二个任务，运行中 `pause_task` → `continue_task`（同 sessionId，指令「继续」）→ 断言恢复会话有历史且能推进到新终态。这是 roadmap 定义的 pause 语义（cancel+checkpoint 恢复），不允许出现 SIGSTOP 类假设。

## T5 健康度路由与自动止损（M2）

1. 注入故障：自选手段制造同一 agent+model 连续 3 次派发失败（报告必须写明注入方式；建议用指向必失败配置的 agent 别名）。断言：health.jsonl 连续 failure、第 3 次后 `agentmesh health` 显示 quarantined + 冷却剩余。
2. 触发一次会产出可升级失败的派发，断言 `hint.nextCandidates` 排序：隔离模型被排除；当全部候选被隔离时恢复原序 + warning 披露（M2 语义）。
3. 结束后 `agentmesh health --reset <model>`，断言墓志铭追加且健康分清零。

## T6 交接保真 + 上下文注入回归（M7a + real_test 教训回归）

1. 上游 worker 会话（T1 的）→ 下游 delegate 带 `contextSessionIds: [上游]`，任务「仅基于上游结论回答，不要重读仓库」。
2. `handoff_diff` 两会话：断言 `lossless` 或 `minor-truncation`（**不得出现 partial-loss/lost**；出现即立案——这正是 M7a 要抓的缺陷类）。
3. 复核下游是否出现「结论级重复推导」（real_test.md 跨测试结论 4 的回归检查）。

## T7 quick review 机器化 + findings 闭环（M3）

1. 让 reviewer 对 worker 产物评审，要求按新 prompt 契约输出 `category:`/`kind:` 标签；制造一次 FAIL（SPEC 雷未被正确处理即可 FAIL）→ rework（continue_task 注入 findings）→ PASS。
2. 断言：findings.jsonl 记录该轮 findings；rework 闭环 PASS 后被修复的 finding `confirmed: true`（`agentmesh stats --findings` 可见 precision 数据）。
3. worker 交付 contract map（contract item → file:line）→ `verify_contract_map` 校验通过；再构造一个错行 map → 断言逐项状态（missing/out-of-bounds/empty）。

## T8 数据层健壮性（M6）

1. 手动向 metrics.jsonl / findings.jsonl 尾部追加垃圾行（非 JSON），再跑 `agentmesh stats --json` 与 `stats --findings`：断言不崩、跳过损坏行、其余统计正确。
2. `agentmesh ui` 启动，确认面板与 serve 读同一数据目录（对照 r21 类 bug：面板目录与服务目录不一致）。抽查队列/工作流任务在面板中的显示（注意 CHANGELOG 已知项：排队任务可能显示为"已启动"，遇到则记录为 v0.5 跟进项确认，不算新缺陷）。

## 报告格式（real_test_v0.4_report.md）

- 顶部：跨测试总结论（先读这里）——每条结论附证据路径；消耗的真实配额估计。
- 每个测试节：任务在做什么 / 结果表（步骤、Agent、传输、耗时、结果）/ 与预期的偏差 / 立案编号。
- 尾部：v0.5 候选跟进项汇总（含 CHANGELOG 已知面板语义项的实测确认）。
