# AgentMesh 多 Agent 编排引擎实战：从 LLM 监工（v0.3）到确定性工作流（v0.4）

AgentMesh 是一个多 Agent 编排引擎，它将 codex、claude、opencode 等异构 vendor agent 统一封装为可调度的 worker/reviewer/tester 角色，通过 MCP 协议对外暴露 `delegate_task`、`review_changes`、`continue_task`、`run_workflow` 等工具，实现"你给需求，它组织多个 agent 完成实现-验收-评审-返工全流程"。该系统解决了传统 LLM 编排中监工不可靠、故障无止损、上下文交接失真、结果不可信、质量靠人肉等痛点。v0.3 采用 LLM-in-the-loop 模式，由主模型实时决策每一步派发，实测暴露出 vendor 卡死无止损、worker 虚假声称被放行、交接保真不可验证等致命伤；v0.4 完成了从"LLM 当监工"到"确定性状态机当监工"的架构转变，通过 M0-M7 八个里程碑落地了任务级度量、故障仿真、健康度熔断路由、机器化评审、声明式工作流引擎、安全默认翻转、统一数据层和完整生命周期原语，使编排决策从概率问题变成确定性问题——流转全程零 LLM 参与，主模型只在写 spec 和处理 escalated 两个点介入。真实压测 T0-T8 验证了全部机制：状态机双路径终止、DAG 级联取消、熔断自然触发后 274 秒自愈、交接保真 3/3 答对、数据层损坏容错，全程免费模型现金成本 $0。

## 1. 项目概述

### 1.1 它是什么

AgentMesh 是一个
多 Agent 编排引擎
——你给它一个开发需求，它自主完成从角色解析、任务派发、验收执行、代码评审到返工闭环的全流程：

```
"帮我实现图书管理系统的后端接口"
        → 写合同 → 派发 worker → 跑验收命令 → 派发 reviewer
        → FAIL? → findings 注入原 worker → 返工 → 复审
        → PASS → 交付（diff + 测试输出就是证据）

"评审这次改动有没有虚假声称"
        → contract map 机器核对 → 只读评审 → PASS/FAIL + 结构化 findings

"这个工作流跑到哪了"
        → get_workflow 快照 → 逐 stage 状态 + 逐轮 findings + 终态证据链
```

它不是简单的 "把 prompt 转发给 vendor CLI"，而是一个
有进程管理、有止损机制、有验收闸门、能自我纠错的编排引擎。

### 1.2 解决什么痛点

| 痛点       | 直接调 vendor CLI          | 用 AgentMesh                              |
| ---------- | -------------------------- | ----------------------------------------- |
| 进程管理   | 超时靠运气，断连留孤儿进程 | 进程组级终止 + 看门狗 + 孤儿扫描          |
| 结果可信度 | agent 说"测过了"你只能信   | 验收命令真实执行，exit code 说了算        |
| 上下文交接 | 手工复制粘贴，失真无人知   | 一手注入 + handoff_diff 机器判级          |
| 故障处理   | 每次靠人临场发挥           | 熔断/重试/重派全部确定性执行              |
| 质量闭环   | 评审完就完了，缺陷不沉淀   | findings 分类落盘，重复缺陷毕业为静态检查 |
| 成本可见   | 烧了多少 token 全靠感觉    | metrics.jsonl 逐笔落盘，stats 聚合        |

### 1.3 能力速览

| 工具                            | 作用                                                |
| ------------------------------- | --------------------------------------------------- |
| `delegate_task`                 | 派发任务给指定角色（支持 priority、deps、后台执行） |
| `review_changes`                | 只读代码评审，PASS/FAIL + 结构化 findings           |
| `continue_task`                 | 会话续跑（原生 session 恢复 + checkpoint 注入）     |
| `run_workflow` / `get_workflow` | 声明式工作流执行与观察                              |
| `poll_task`                     | 后台任务长轮询（增量输出、queued/blocked 状态）     |
| `cancel_task` / `pause_task`    | 取消 / 暂停恢复（checkpoint 保全）                  |
| `handoff_diff`                  | 上下文交接保真度机器判定                            |
| `verify_contract_map`           | 零 LLM token 的合同映射机械核对                     |
| `agentmesh stats` / `health`    | 度量聚合 / 模型健康管理                             |

## 2. 快速上手

### 2.1 配置到 MCP 客户端

```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["/path/to/agentmesh/dist/cli/index.js", "serve"]
    }
  }
}
```

### 2.2 最小派发例子

```json
{
  "tool": "delegate_task",
  "args": {
    "task": "实现 src/slugify.mjs，验收标准：node --test 全绿",
    "agent": "opencode",
    "role": "worker",
    "cwd": "D:/workspace/demo",
    "background": true
  }
}
```

后台任务返回 `taskId`，用 `poll_task(taskId, maxWaitMs=30000)` 事件驱动长轮询，终态拿到完整结果与用量。

## 3. 技术架构全景

### 3.1 v0.3 架构全景图（LLM-in-the-loop）

```
                    主模型（LLM Orchestrator）
                    —— 循环控制器，每步都在线决策
                            │
      ┌─────────┬───────────┼───────────┬──────────┐
      ▼         ▼           ▼           ▼          ▼
 delegate_task  读输出   review_changes  读 verdict  continue_task
 (派 worker)   自己判断   (派 reviewer)   自己判断   (搬运 findings)
      │                                                    │
      └────────────────── 循环往复 ─────────────────────────┘
```

每个箭头都是一次 LLM 决策：判断标准自由发挥、上下文持续膨胀、vendor 故障全靠监工临场应变。

### 3.2 v0.4 架构全景图（LLM-on-the-loop）

```
主模型写 WorkflowSpec ──► run_workflow ──► { workflowId }（立即返回）
                                                │
┌───────────────────────────────────────────────▼──────────────┐
│           AgentMesh 进程内确定性状态机（零 LLM 参与）           │
│                                                              │
│   stage: pending → dispatched → running → acceptance → review │
│                                                              │
│   ┌────────────┐   ┌────────────────┐   ┌───────────────┐    │
│   │ 后台任务路径 │   │ 验收即代码      │   │ 评审与返工环    │    │
│   │ registry    │   │ commands exit 0│   │ findings 落盘  │    │
│   │ 看门狗       │   │ files 必须存在  │   │ 注入原 worker  │    │
│   │ 健康度路由   │   │ exit 1 → 终止  │   │ ≤3 轮 fail-   │    │
│   │ checkpoint  │   └────────────────┘   │ closed        │    │
│   └────────────┘                        └───────────────┘    │
│                                                              │
│   终态: done / escalated（证据链回到人）/ failed              │
└──────────────────────────────────────────────────────────────┘
                                                │
主模型 get_workflow 长轮询 ◄────────────────────┘
```

### 3.3 技术栈一览

| 层         | 技术                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| 语言/构建  | TypeScript（strict）+ NodeNext ESM，Prettier/ESLint 全量门禁                   |
| 协议       | MCP（stdio），JSON-RPC，标准 notifications 进度推送                            |
| Agent 适配 | codex / claude / opencode / antigravity CLI 与 MCP 双通道适配器                |
| 存储       | 统一 StorageService：JSONL 追加日志 + 原子写（temp+fsync+rename）+ 损坏行容错  |
| 测试       | vitest 单测 + fake-CLI 进程集成测试 + fake-vendor 仿真 harness（8 类故障场景） |

**设计要点**：环境访问全部收口在进程与适配器边界——`PATH`、`PATHEXT`、`ComSpec` 是合法平台输入，但凭据永不落日志，vendor 配置必须经 `.agentmesh/capabilities.json` 白名单，不向严格 vendor schema 透传泛化参数。

### 3.4 核心设计决策

1. **编排决策从 LLM 挪进确定性代码**——这是整个 v0.4 的第一性原理（见第 5 节）。
2. **验收即代码**："done 的定义"从纪律变成引擎行为，exit code 是唯一放行凭证。
3. **fail-closed 哲学**：无 verdict 不放行、损坏行跳过但不吞错、UNKNOWN 一律按失败处理。
4. **免费模型优先**：全部组件可用 opencode 免费模型跑通，健康度路由天然适配免费档的高故障率。

## 4. v0.3：LLM 当监工的编排模式

### 4.1 派发与上下文注入

v0.3 已解决的问题之一是上下文交接：`contextSessionIds`（最多 4 个）把上游会话的规范化历史**一手**注入下游 prompt，每个来源独立标注 `MATCHED`/`STALE`/`UNKNOWN` 新鲜度，按 24k 总预算分段限额，截断显式标注 `[truncated]`。接收方被明确指示"只引用实际注入的内容，禁止声称复用了没给的信息"。

### 4.2 评审与有界返工

`review_changes` 携带 P0-P3 评审 rubric（存在 P0/P1 强制 FAIL），FAIL 时把机器解析的结构化 findings 注入原 worker 会话（`workerSessionId` 或唯一 worker 上下文会话，绝不猜），修完换全新 reviewer 复审，最多 `maxReworkRounds` 轮，逐轮证据链完整返回。

### 4.3 工程保障层

- **checkpoint 溢出**：失败/取消/看门狗终止前，输出尾部（≤32k）存盘为一次性令牌，`continue_task + fromCheckpoint` 续跑
- **预算水位门**：session 用量达 80% 警告、达上限可配置拒绝新派发（BUDGET_EXHAUSTED），在跑任务不受影响
- **端到端取消**：MCP 客户端断连 → AbortSignal 贯穿 runner/adaptor/executor → 进程组级终止 → 记 `client_disconnect` 失败终态

### 4.4 真实压测暴露的问题（v0.4 的动因）

r21/r22 轮实战总结出八类 vendor 故障：0 字节卡死、APIError 突发、输出截断、exit/语义状态不一致、慢 vendor、取消语义偏差……更深的结构性问题是：

```
直接用 LLM 当监工
├── ❌ 无 ground truth：没跑过测试，判断"做没做完"只能读 worker 自述
├── ❌ 自由心证：同一故障每次处理不一样，无止损、无沉淀
├── ❌ 成本失控：循环跑几轮，主模型上下文膨胀几轮
└── ❌ 交接失真：转述上游产出时静默丢失，无人发现
```

worker 虚假声称（说测过其实没测）在 LLM 监工眼皮底下反复被放行——**没有事实依据的智能决策，不叫智能决策，叫自由心证**。

## 5. v0.4 核心转变：确定性工作流引擎（M4）

这是整个系统**最关键的技术选型**。

### 5.1 为什么不用 LLM 当编排器

```
LLM-in-the-loop 编排
├── ❌ 概率执行：LLM 听话是概率，忘步骤、自由发挥无法根除
├── ❌ 验证≠目测：主模型"看输出说行"不是验证
├── ❌ 错误发现晚：目测漏过 → 联调爆发 → 大修
└── ❌ 每次决策都烧贵模型 token

确定性状态机
├── ✅ 代码照 spec 跑：没有能力偏离、偷懒、遗忘
├── ✅ 验收即代码：exit code 是唯一事实
├── ✅ 每 stage 早失败：错误隔离在最小返工范围
└── ✅ 流转零 token：LLM 只出"写 spec 的智力"
```

### 5.2 WorkflowSpec：一份 JSON 定义全流程

```json
{
  "name": "library-backend",
  "stages": [
    {
      "name": "implement",
      "roles": ["worker"],
      "dispatch": {
        "agent": "opencode",
        "taskTemplate": "实现三个接口…合同项逐条给出 file:line 映射，SPEC 矛盾必须上报",
        "timeoutMs": 600000
      },
      "acceptance": {
        "commands": ["node --test src/*.test.mjs"],
        "files": ["src/books.mjs", "src/borrow.mjs"]
      }
    },
    {
      "name": "review",
      "roles": ["reviewer"],
      "dispatch": {
        "agent": "opencode",
        "contextPolicy": { "contextSessionIds": "upstream" }
      }
    }
  ],
  "policy": { "maxReworkRounds": 3, "escalateOn": "any", "reRouteOnStall": true }
}
```

**设计要点**：spec 与引擎是数据/代码分离——引擎是通用骨架（所有任务共享同一状态转移），spec 声明每需求的具体参数（stage、验收命令、并行组、返工策略），提交前经 schema 校验，非法结构拒绝启动。

### 5.3 状态机与验收即代码

每个 stage 的状态转移完全确定性：`pending → dispatched → running → acceptance → review →（PASS → 下一 stage；FAIL → rework 环）`。验收命令由引擎在 cwd 真实执行，exit 0 放行、exit 1 按 `escalateOn` 分级终止并附命令 stdout/stderr 证据。stage 派发是货真价实的后台任务——registry 持久化、stalled 看门狗、cancel 语义全部继承，任务 ID 形如 `<workflowId>_s<stage>_<seq>`。

### 5.4 rework 环（fail-closed）

reviewer FAIL 的 findings 由引擎通过 `continue_task` 注入原 worker 会话，修复后以严格契约复审；**无 verdict（UNKNOWN）不放行**。轮次耗尽仍 FAIL → `escalated`——这是唯一回到 LLM Orchestrator/人类的点，快照携带逐轮 findings、验收输出、仓库 diff 摘要，人裁决的是一个小而明确的证据包，不是考古整个项目。

## 6. 可靠性工程（M0/M1/M2）

### 6.1 度量先行（M0）

append-only `metrics.jsonl` 记录每次派发的角色/agent/模型/token/耗时/结果；后台看门狗记录 stall 事件并按 `taskId` 归因。`agentmesh stats` 按 all/24h/7d 窗口聚合 p50/p95 时长、重试/卡死/取消率。**没有度量就没有优化，这是 v0.4 的第一块基石。**

### 6.2 故障仿真 harness（M1）

依赖-free 的 `fake-vendor.mjs` 模拟 8 类故障（ok/stall/truncate/apierror/slow/semantic-fail/exit-mismatch），9 个进程级场景钉死 r21/r22 的全部故障类别，经真实 MCP 面板跑 CI 回归。**故障处理不再靠"下次遇到再说"。**

### 6.3 健康度路由与止损（M2）

`health.jsonl` 滚动窗口记录失败评分（24h 半衰期）、p50/p95 时长；**连续 3 败触发熔断隔离，30 分钟冷却自动解除**；候选链排序规则：tier 匹配 → 健康分 → costLevel，被隔离模型剔除并附 last-resort 警告。

```
场景闸门——止损只对"该止损的"生效
连续失败注入 3 次（91/72/75ms）→ 第 4 次派发被隔离拒绝
reset 后恢复派发；CIRCUIT_OPEN 触发时返回预估恢复 274s，冷却后重试成功
```

**设计要点**：同一个不稳定模型不会反复坑任务——第一次断是意外，第二次断是路由问题。看门狗双阶段：输出流 10 分钟无新字节标 `stalled`（每任务至多提示一次），再 30 分钟无输出自动终止进程树，终止前先溢出 checkpoint。

## 7. 质量闭环（M3/M7）

### 7.1 verify_contract_map：零 token 的机械快审

worker 对每条合同项申报 `contract item → file:line` 映射，引擎逐条机器核对代码位置是否真实存在且匹配。虚假声称（"我在 X 处实现了 Y"但 X 处没有）直接 FAIL——**连 LLM 都不用消耗**。真实压测 T7 实证：worker 通过了全部测试，reviewer 仍抓出 critical 级"虚假 CONTRACT-2 声称"，而 contract map 正确拦截了误导性映射。

### 7.2 findings 落盘与毕业机制

每次 FAIL 的 findings 结构化落盘 `findings.jsonl`（findingId/sessionId/category/kind/severity/file/line），rework 闭环以 PASS 收口时补记 `confirmed`。`agentmesh stats --findings` 输出评审精确率与毕业提案：**重复出现的缺陷模式 → 沉淀为 eslint 规则；反复漏测的边界 → 沉淀为新验收命令**。今天人肉抓的坑，明天机器自动拦。

### 7.3 handoff_diff：交接保真机器判定

传入上下游 Bridge Session ID，对比上游实际产出（task/summary/finalAnswer/findings/仓库证据）与下游实际接收的注入内容，返回五档判定 `lossless | minor-truncation | partial-loss | severe-loss | lost`，附逐节 missingKeys/truncatedKeys/preservedSections。**用机器审计替代"上下文已复用"的自述式信任。**

## 8. 安全与数据（M5/M6）

### 8.1 安全默认翻转（BREAKING）

未配置 sandboxLevel 的角色现在解析到目标 adapter 声明的**最强沙箱**（codex 原生沙箱、claude 工具过滤），prompt-only 需要显式 `allowPromptOnly` 信任声明。解析顺序：显式角色配置 > agents 元数据 > adapter 能力默认 > 带警告的 prompt-only 兜底。`config validate` 和 `doctor` 主动提示降级风险。

### 8.2 统一数据层

单一 StorageService 拥有 home 目录解析（含 `AGENTMESH_SESSIONS_FILE` 重定向）、原子写（temp+fsync+rename，best-effort 证据可退出 fsync）、损坏行容错（跳过并在 stderr 明示）与变更事件；sessions/tasks/metrics/findings/health/workflows/checkpoints 全部走同一条路。**持久化格式字节级兼容，零迁移。**

## 9. 真实压测验证（T0-T8）

| #   | 测试                       | 结论           | 关键证据                                                                  |
| --- | -------------------------- | -------------- | ------------------------------------------------------------------------- |
| T0  | 环境准备                   | 通过           | `npm run check`、stdio 守护连通                                           |
| T1  | 后台基线 + 度量落盘        | 通过           | 首个任务 success（259.9s），metrics/health 双落盘                         |
| T2  | 状态机双路径               | 通过           | done：五态转换 + 验收 TAP 3/3；escalated：exit 1 → 证据链完整             |
| T3  | 队列/优先级/DAG            | 通过           | P0 抢占、未知依赖拒绝、级联取消、queued 可见                              |
| T4  | cancel/pause 恢复          | 通过           | 状态一致，恢复后任务正常完成                                              |
| T5  | 健康度路由与止损           | 通过           | 3 连败隔离、reset 恢复、stall 归因；CIRCUIT_OPEN 自然触发 274s 自愈       |
| T6  | handoff_diff 保真          | 通过（有保留） | 下游 3/3 答对；STALE 误降级立案 P-076                                     |
| T7  | 评审机器化 + findings 闭环 | 部分通过       | contract map/落盘/注入全通过；rework turn vendor 失败断链 → P-075/077/078 |
| T8  | 数据层健壮性               | 通过           | 垃圾行注入后统计照常、exit 0、stderr 明示                                 |

**成本**：全部 opencode 免费模型，input ≈ 687K / output ≈ 20K tokens，现金成本 $0。

## 10. 已知边界与演进方向

诚实清单（编号即 PROBLEMS.md 立案）：

- **P-075**：评审简报含命令指涉 → opencode 卡死 exit 124；缓解 = 简报显式写明"只读、禁止运行命令"
- **P-076**：fingerprint 未排除 `.agentmesh/` 运行时文件 → STALE 误报降级交接等级
- **P-077**：rework worker turn 失败无重试 → 闭环断裂 + confirmed 永久丢失；手动续跑 = 查 git diff 分流（已落盘→重派复审，未落盘→checkpoint 续跑）
- **P-078**：opencode 错误压缩为 APIError/UnknownError → 破坏分类与升级路由
- **P-079**：workflow 对 isRetryable TRANSIENT dispatch 失败增加有界退避重试 + `workflow run --resume` 断点续跑（v0.5 候选）

**原理性边界**：状态机保证流程确定，不保证内容正确——"恰好骗过验收和评审"的错误实现无法根除，最终兜底始终是 escalated 人工裁决。适用边界同样明确：done 可预先定义的实现类任务进工作流，探索型任务保留 `delegate_task` 手动通道——**适合人盯的活就该人盯**。

## 一句话总结

> v0.3 是"人当编排器、MCP 当手脚"——监工的勤奋不可靠；v0.4 是"状态机当编排器、MCP 当入口"——验证强度来自可执行闸门，监工从"过程巡逻"变成"结构化关卡"，主模型出的不再是监工的体力，而是出卷的智力。
