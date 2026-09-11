# AgentMesh (Multi-Agent Bridge & Network)

**一句话明白 AgentMesh 是干什么的：**  
> AgentMesh 把不同的 AI 编程助手（Codex、Claude Code、Antigravity、OpenCode 等）组建为一个“AI 软件开发团队” —— 让主控 AI 像项目经理一样，调度其他 AI 分别担任程序员（写代码）、代码审查员（只读审查）和测试员（跑测试），自动协同完成复杂的编程任务。

AgentMesh 是一个本地 **MCP 桥接网格**。主控 Agent（如 Antigravity / Codex）可通过标准 MCP 工具统一调度异构 Agent，按 **Worker（实现）**、**Reviewer（只读审查）**、**Tester（验证）** 角色分工协同，保留各厂商原生的 Harness、工具链与订阅配额，完成复杂需求的开发与验证闭环。

---


## 💡 解决的核心痛点

| 常见痛点                       | AgentMesh 解决方案                                                                                                      |
| :----------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| **API 与 CLI 割裂**            | 统一暴露为标准 MCP Tools (`delegate_task`, `review_changes` 等)，优先连接 Agent 原生 MCP，必要时自动回退 Headless CLI。 |
| **上下文交接丢失/重复工作**    | 支持 `contextSessionIds` 多源无损注入，附带 `MATCHED/STALE` 状态判定与 `handoff_diff` 保真度机器审计。                  |
| **Reviewer 误写代码/反馈模糊** | 强制只读沙箱与只读树守卫（Tree Guard），声明严格的 PASS/FAIL/findings 契约与有界自动返工循环。                          |
| **长任务挂死与故障无感知**     | 内置后台任务队列、DAG 依赖管理、事件驱动长轮询（`poll_task`）、看门狗超时中断与熔断隔离。                               |

---

## 🤖 支持的 Agent 矩阵

| Agent 名称        | 别名 (Aliases)                    | 默认可执行文件   | 首选传输模式                | 备用传输模式                  | 环境变量覆盖             |
| :---------------- | :-------------------------------- | :--------------- | :-------------------------- | :---------------------------- | :----------------------- |
| **`codex`**       | `openai-codex`, `codex-cli`       | `codex`          | MCP (`codex mcp-server`)    | CLI (`codex exec` / `review`) | `CODEX_BIN`              |
| **`claude`**      | `claude-code`, `anthropic-claude` | `claude`         | CLI (`claude -p`)           | —                             | `CLAUDE_BIN`             |
| **`antigravity`** | `gemini`, `agy`, `google-gemini`  | `agy` / `gemini` | CLI (`agy -p`)              | —                             | `AGY_BIN` / `GEMINI_BIN` |
| **`grok`**        | `xai-grok`, `grok-cli`            | `grok`           | CLI (`grok -p`)             | —                             | `GROK_BIN`               |
| **`opencode`**    | `opencode-ai`, `opencode-cli`     | `opencode`       | CLI (`opencode run --auto`) | —                             | `OPENCODE_BIN`           |
| **`zcode`**       | `z-code`, `zcode-cli`             | `zcode`          | CLI (`zcode <prompt>`)      | —                             | `ZCODE_BIN`              |

---

## 🚀 快速开始

### 1. 安装与编译

要求 Node.js `>=22.13.0`，使用 npm 安装与编译：

```bash
npm ci
npm run build
```

### 2. 检查本地 Agent 可用性

```bash
node dist/cli/index.js list
# 或全局链接后执行: agentmesh list
```

### 3. 在 MCP 客户端中配置 (`mcp.json`)

将 AgentMesh 配置为 MCP Server，供主控 Agent 直接调用：

```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["/path/to/agentMesh/dist/cli/index.js", "serve"],
      "env": {
        "CODEX_BIN": "codex",
        "CLAUDE_BIN": "claude"
      }
    }
  }
}
```

---

## ⚙️ 项目角色配置 (`.agentmesh/config.json`)

在项目根目录下配置角色映射，主控 Agent 调用 MCP 时只需指定角色（`worker` / `reviewer` / `tester`）：

```json
{
  "version": 1,
  "roles": {
    "orchestrator": "antigravity",
    "worker": "codex",
    "reviewer": {
      "agent": "claude",
      "mode": "cli",
      "timeoutMs": 300000,
      "safety": "best-effort"
    },
    "tester": "claude"
  },
  "budget": {
    "perSessionTokenCap": 2000000,
    "onExceed": "rejectNew"
  }
}
```

- **`reviewer.safety`**: 默认为 `best-effort`（使用最强可用防护并校验仓库指纹），设置 `enforced` 时拒绝无硬件/工具沙箱保障的 Agent。
- **`budget`**: 会话 Token 硬限额保护，达到 80% 触发预警，超过后阻止新派发。

---

## 🛠️ 核心 MCP Tools 说明

主控 Agent 可通过以下统一 MCP Tools 进行任务编排与治理：

| MCP Tool                                | 功能描述                                    | 核心参数说明                                                                                                                                           |
| :-------------------------------------- | :------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`delegate_task`**                     | 委派任务给指定 Agent 或角色。               | `task` (必填), `role` (`worker`/`reviewer`/`tester`), `agent`, `sessionId`, `contextSessionIds`, `background` (`true` 时后台异步), `deps` (DAG 依赖)。 |
| **`review_changes`**                    | 执行只读代码审查，输出 PASS/FAIL 结果。     | `agent`, `task`, `reviewPaths` (树守卫路径限制), `maxReworkRounds` (0-3 自动重修轮次)。                                                                |
| **`continue_task`**                     | 续接已有会话并注入其他会话上下文。          | `sessionId` (必填), `task` (必填), `contextSessionIds` (多源历史), `fromCheckpoint` (异常中断救回)。                                                   |
| **`poll_task`**                         | 观察后台任务进度与结果（支持长轮询）。      | `taskId` (必填), `sinceOffset`, `maxWaitMs` (0-60000 事件驱动阻塞), `detail` (`compact`/`full`)。                                                      |
| **`cancel_task`** / **`pause_task`**    | 主动取消或暂停运行中的后台任务。            | `taskId` (必填), `reason` (记录终态与 checkpoint)。                                                                                                    |
| **`compact_context`**                   | 压缩 Session 历史为语义摘要，省 Token。     | `sourceSessionIds` (1-4 个会话 ID)。                                                                                                                   |
| **`run_workflow`** / **`get_workflow`** | 执行本地确定性多阶段编排工作流状态机。      | `spec` (声明式 JSON), `requirementsPath` (EARS 需求对账单路径)。                                                                                       |
| **`handoff_diff`**                      | 机器评估上游到下游的上下文交接保真度。      | `upstreamSessionId`, `downstreamSessionId` ➔ 返回 `lossless`/`partial-loss` 等等级。                                                                   |
| **`list_agents`**                       | 实时输出各 Agent 的状态、传输、路由与能力。 | `cwd` (项目路径)。                                                                                                                                     |

---

## 📊 管理与诊断 CLI (`agentmesh`)

AgentMesh CLI 提供运维、诊断与只读监控能力：

```bash
agentmesh serve                 # 启动 stdio MCP Server（通常由 Orchestrator 自动调用）
agentmesh ui                    # 启动本地只读可视化面板 (默认 http://127.0.0.1:7788)
agentmesh list                  # 检查本机 Agent CLI 可用性与状态
agentmesh doctor [cwd]          # 一键聚合诊断（Node/适配器/配置/沙箱/存储/仓库指纹）
agentmesh stats                 # 度量统计（Token 消耗、耗时分布、Stall/Cancel 率、Reviewer 发现精度）
agentmesh health                # 模型健康度与熔断隔离快照
agentmesh workflow run <spec>   # 命令行直接运行确定性工作流
agentmesh debug run <agent>     # 仅用于诊断调试底层的 Agent 派发
```

---

## 📐 架构设计

```text
MCP Client / 主控 Agent (Antigravity / Codex / Claude Code)
         │ (stdio JSON-RPC)
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentMesh MCP Server                     │
│ (delegate_task, review_changes, continue_task, workflow...) │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Core Runner                         │
│  - SessionManager (轻量 Bridge 会话持久化与状态跟踪)        │
│  - ProjectConfig (.agentmesh/config.json 角色映射)          │
│  - WorkflowEngine (确定性编排状态机与需求对账单)             │
│  - Executor (跨平台子进程调度、树守卫与超时中断)             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Adapters                            │
│  Codex | Claude | Antigravity | Grok | OpenCode | ZCode    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🧪 自动化测试与质量保障

```bash
npm test              # 单元测试与协议测试
npm run test:coverage # 覆盖率校验
npm run test:integ    # 伪 CLI 进程集成测试
npm run test:package  # 打包与 Smoke 校验
npm run check         # 本地 complete CI 门槛 (Format, Lint, Typecheck, Build, Test)
```

---

## 📄 授权协议

[MIT License](./LICENSE)
