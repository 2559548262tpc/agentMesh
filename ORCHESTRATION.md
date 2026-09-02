# ORCHESTRATION.md — 面板按任务聚合重构（第十九轮）项目宪法

> 每轮开工先读本文。需求源：`ui重构需求.md`（488 行完整版）＋ v2 迭代需求（见第 6 节）。

## 1. 目标

将 AgentMesh 可视化面板（`src/ui/panel.html`）从「按会话展示」重构为「按任务聚合展示」的三栏浅色 SaaS 后台界面。

## 2. 验收标准（可判定，返工以此为据）

1. 新增 `GET /api/board` 端点（`src/ui/data.ts` 新增 `buildTaskBoard()`，`src/ui/api.ts` 新增路由），返回按任务聚合的 `BoardTask[]`。
2. 三栏布局：左侧任务列表（260-320px）+ 搜索框 + 状态筛选；中间任务详情（指令卡片、产出卡片、实时终端）；右侧（检查结论、任务组员、Token 消耗）。
3. 任务四态：进行中(蓝 #165DFF)/已通过(绿 #00B42A)/失败(红 #F53F3F)/待检查(橙 #FF7D00)。
4. 终端只展示当前选中任务；未选中/未执行时显示需求 8.2 表中的占位文案；running 任务 2s 轮询 `/api/tasks/{bgTaskId}/output?offset=`。
5. 色彩严格按需求 3.2 表（背景 #F7F8FA、卡片 #FFFFFF、标题 #1D2129、正文 #4E5969、辅助 #86909C）。
6. 默认态：中间「请选择左侧任务查看详情」、右侧「暂无任务数据」。
7. 保留既有安全行为：`esc()` HTML 转义、`apiFetch` 错误条、`/api/file` 路径穿越防护不变。
8. `npm run typecheck`、`npm run lint`、`npm test` 全部退出码 0；`tests/ui/api.test.ts` 新增 `/api/board` 聚合用例（contextSources 归组、verdict 推导、任务状态推导、终端贪心绑定）。

## 3. 聚合契约（组长定稿，worker 不得自行更改语义）

- **任务锚点**：`session.role === "worker"` 且其 `contextSources` 不含其他 worker 会话 id 的 Bridge Session。
- **干活组员**：锚点自身 + `contextSources` 含锚点（或成员）会话 id 的其他 worker 会话（传递闭包）。
- **检查组员**：`role === "reviewer"` 且 `contextSources` 含任务内任一会话 id 的会话。
- **检查结论 verdict**：检查组员最后 entry `status==="failed"` → FAIL；否则从 summary/finalAnswer 前 200 字符匹配 `PASS`/`FAIL` 关键词；都没有 → UNKNOWN。
- **任务状态**：锚点最后 entry failed 或 verdict=FAIL → failed；verdict=PASS → passed；有产出（finalAnswer/summary）但无检查 → pending_review；否则 running。
- **终端绑定**：后台任务注册表（`tasks/registry.jsonl`）中 startedAtMs 与任务 updatedAt 最接近且未被其他任务认领的记录（贪心一对一）；无匹配 → terminal=null，前端显示占位。
- **Token**：任务总消耗 = Σ 成员会话 totalTokens；环形图按 worker/reviewer 角色分组展示，无数据源的角色不造假数据。

## 4. 非范围

不改 Agent 调度/核心执行逻辑（`src/core/background.ts` 等只读复用）；不做终端日志持久化；不做权限系统；不重构全局聊天会话界面。panel.html 保持单文件 vanilla JS，不引入构建依赖和外部 CDN。

## 5. 分工与模型

| 角色           | 通道     | 模型                            |
| -------------- | -------- | ------------------------------- |
| 组长（本会话） | —        | —                               |
| worker         | opencode | opencode/big-pickle             |
| reviewer       | opencode | opencode/nemotron-3-ultra-free  |
| tester         | opencode | opencode/mimo-v2.5-free（如需） |

安全姿态：opencode 为 prompt-only 通道，任务文本不含破坏性命令示例；reviewer 结论 PASS 前必须澄清 SECURITY/SAFETY 警告。

## 6. v2 迭代契约（三级任务树 + P0 修复，2026-09-01）

### 6.1 数据契约（`GET /api/board` v2，替换 v1 的 `{ tasks }`）

```ts
{ groups: BoardGroup[] }
interface BoardGroup {
  groupId: string;            // 锚点会话 id
  title: string;              // 锚点 taskTitle
  status: "running"|"passed"|"failed"|"pending_review";  // 组内子任务最差态滚动：running > failed > pending_review > passed
  totalTokens: number;        // 组内全部子任务合计
  startedAt: string; updatedAt: string;
  roles: { worker: BoardSubtask[]; reviewer: BoardSubtask[]; tester: BoardSubtask[] };
}
interface BoardSubtask {
  sessionId: string;          // 真实会话 id；live 子任务为后台 taskId
  title: string; agent: string; model?: string;   // model = findLastRequestedModel，无则前端降级显示 agent
  status: "running"|"passed"|"failed"|"pending_review";
  totalTokens: number;
  usageSplit?: { input: number; output: number; reasoning: number; cached: number }; // usage 分项，无计量省略
  instruction: string; instructionFull?: string;   // 本会话 history[0].task
  output?: { summary?; finalAnswer?; status; finishedAt; changedFiles: string[] };
  startedAt: string; updatedAt: string;
  terminal: { bgTaskId: string; bgStatus: string } | null;
  review: { verdict: "PASS"|"FAIL"|"UNKNOWN"; checkedAt: string; conclusion: string; findings: string[] } | null;
  live: boolean;              // true = 仅存在于后台注册表的执行中任务
}
```

### 6.2 树形聚合规则（组长定稿，不得更改语义）

1. **任务组（一级）** = v1 锚点 + contextSources 闭包收集的全部会话（worker/reviewer/tester 混收，`usedSessions` 一对一去重沿用）。
2. **角色文件夹（二级）** = 组内会话按 `session.role` 分桶（worker/reviewer/tester）；空文件夹不渲染。
3. **子任务（三级）** = 单个 Bridge Session（最小单元），不再合并展示；标题 = 该会话 taskTitle。
4. **子任务 review** = contextSources 含「该子任务 sessionId」的检查组员会话的结论（推导规则沿用 v1 §3 第 4 条）。
5. **终端绑定** = 沿用 v1 贪心一对一；未被任何会话认领的后台任务（running/interrupted）生成为 `live:true` 合成子任务，归入合成组 `groupId:"__live__"`（标题「实时任务」），完成后其会话落盘即被贪心认领，live 条目自动消失——这是「新建任务实时上树」的实现路径。
6. **usageSplit** = 该会话全部 turn 的 usage 分项求和（input/output/reasoning/cached），环形图数据源；无任何 usage 时省略，前端显示「—」，不造假数据。
7. **推断归属（v6 回退，2026-09-01）** = 无 contextSources 的检查员会话，当其任务文本与锚点任务文本共享显式轮次标记（如 `v4`）、cwd 一致、且候选组唯一选时间窗最近者时，归入该组并打 `inferred:true`，树与详情头渲染「推断」徽章。推断永不冒充记录事实：精确归属（规则 1/4）始终优先；无标记或 cwd 不匹配则保持不归属。背景：r19-v4 数据 21 个 reviewer 会话 contextSources 全空（派发未传 contextSessionIds），真实评审工作在面板上整体消失——回退通道让历史评审可见，协议规则（§9 第 2 条）保证未来派发走精确归属。

### 6.3 P0 修复验收

1. 子任务条目渲染 `model ?? agent ?? "—"`，不再出现「模型未记录」字样；有计量的会话显示真实 Token（实测：38 会话中 11 个有计量，如 bridge-sess 上 `opencode/big-pickle` / 684,325 tok 必须能显示）。
2. 组员条目展示模型 ID（同样 `model ?? agent` 降级）。
3. Token 卡片（选中子任务）：总消耗 + usageSplit 环形（输入/输出/推理/缓存四段，无计量段不画）；无 usageSplit 时显示「该会话无 Token 计量记录」。
4. 树 3s 轮询保留；运行中新任务（live）出现 ≤3s；树头部新增手动刷新按钮。
5. 全树搜索：命中子任务自动展开其祖先文件夹并高亮；状态筛选只作用于子任务，含命中子任务的文件夹/组保留，空文件夹/组隐藏。
6. 交互：仅三级节点可选中；文件夹点击仅折叠切换；顶层组默认展开，二级文件夹默认展开；刷新后保持展开态与选中态（按 sessionId）。

### 6.4 非范围

调度逻辑不变；终端不持久化；浅色 SaaS 风格与配色不变。改动文件集仍限 `src/ui/data.ts`、`src/ui/api.ts`、`src/ui/panel.html`、`tests/ui/api.test.ts`。

## 7. v3 迭代契约（数据源校验 + MCP 记录 + 树图标改版，2026-09-01）

背景根因（已实证）：数据目录由 `AGENTMESH_SESSIONS_FILE` 决定（session.ts:197-201），编排环境写 `F:\agentmesh-data`（38 会话），用户 CLI 默认读 `C:\Users\25595\.agentmesh`（40 旧会话）——双目录分裂造成「近几轮记录丢失」假象。

### 7.1 数据源校验与提示条

- data.ts 新增 `inspectDataSource(homeDir)`：检查目录存在性、sessions.json 可读性、JSON.parse 合法性；`/api/board` 响应顶层加 `dataSource: { homeDir, sessionsFile, warnings: string[] }`。
- 前端：warnings 非空 → 顶部可关闭轻提示条「读取本地任务目录异常，请检查 `.agentmesh` 目录（当前：{homeDir}）：{原因}」，不阻塞渲染；正常时隐藏。提示条始终展示当前 homeDir 的能力保留在异常态即可。

### 7.2 MCP 调用记录

- BoardSubtask 新增 `mcpCalls: { index: number; task: string; status: string; finishedAt: string; durationMs?: number; transport?: string; exitCode?: number; model?: string }[]`（映射自会话 history entries 的 task/status/timestamp/evidence/usage；vendor 内部工具调用不在 AgentMesh 记录范围，如实展示）。
- 产出卡片新增「MCP 调用记录」区（与改动文件清单同卡片）：每条显示序号+状态点+耗时+模型，点击展开参数全文（instructionFull）。

### 7.3 Token 与模型展示规则

- 树：一级组标题行右侧显示组 totalTokens（worker+reviewer+tester 合计，全部无计量显示「暂无Token统计」）；二级、三级不展示 Token。
- 模型：三级条目与中间标题行显示 model，缺失显示「暂无模型数据」（不再用 agent 名降级）。
- 右侧 Token 卡（选中子任务）：所属组内 worker/reviewer/tester 三角色分项合计 + 顶层总合计 + 三段环形图 + 「当前子任务消耗」行；无计量角色段不画、不造假。

### 7.4 脏数据过滤与加载策略

- 隐藏规则：会话 history 为空，或全部 entry 无 task 文本且无 finalAnswer/summary/evidence → 隐藏；status=failed 且无任何产出证据 → 隐藏；live 任务不过滤；usedSessions 去重沿用。
- 默认渲染组按 startedAt 降序前 N=8（localStorage `panel.maxGroups` 可配 5~10）；搜索/筛选命中时解除裁剪全量渲染；后端不裁剪。

### 7.5 树图标与缩进规范（替换 emoji）

- 内联 16px SVG 线性图标（stroke 1.5、currentColor，禁 CDN/emoji）：一级 folder/folder-open（#4E5969，展开切换）；二级 folder-bot(干活)/folder-check(检查)/folder-bug(测试)（#86909C）+ 子任务数量角标；三级 file-code（changedFiles 非空）/file-text（#C9CDD4）。
- 缩进：一级 0px、二级 24px、三级 48px；状态圆点独立于节点最右侧。
- 状态点配色（全站统一更新）：进行中 #FF7D00（呼吸动效可选）、已通过 #00B42A、失败 #F53F3F、待检查 #165DFF。
- 交互不变：仅三级可选中；文件夹点击仅折叠；搜索命中自动展开高亮；筛选作用于全部子任务。

### 7.6 验收

1. 模拟目录异常（改 AGENTMESH_SESSIONS_FILE 指向不存在路径启动）→ 提示条出现且含路径，页面正常渲染空态。
2. 近几轮含 usage 的会话（如 big-pickle 684,325 tok）在一级行显示总 Token；三级条目显示模型 ID。
3. 有多轮 history 的会话产出卡片可见 MCP 调用记录列表与展开详情。
4. 40 会话脏数据（空 history）被过滤，组数 ≤ N。
5. 全站无 emoji 图标；缩进三档清晰；`npm run typecheck`/`npm run lint`/UI 测试全绿（新增：dataSource warnings、mcpCalls 映射、脏数据过滤、组裁剪逻辑用例）。

## 8. v4 迭代契约（Token 卡片修复 + 卡片视觉统一，2026-09-01）

纯展示层迭代，不改数据契约结构（/api/board v3 响应字段不变）。

### 8.1 Token 消耗卡片（P0）

1. 数据层：组内三角色 Token 独立合计（worker/reviewer/tester，数据源 v3 已具备）。
2. 数值规则：角色无消耗显示 `0`（**不得显示 `-` 横线占位**）；环形图忽略 0 值段（不渲染极小切片）；中心大圆 = 顶层任务全部角色 Token 总和（缩写格式）；分项列表每行 = 角色名 + 独立数值；底部保留「所属组总消耗」「当前子任务消耗」两行。
3. UI：环形图左、分项列表右侧顶部对齐；压缩垂直留白；图例圆点统一尺寸、文字与数字基线对齐；数字加粗、字号放大一档。
4. 配色锁定：worker #165DFF / reviewer #00B42A / tester #FF7D00（仅 Token 卡片语义，不影响状态点配色）。
5. 数值格式化：≥1M 显示缩写（如 7.24M），title/tooltip 悬浮展示完整千分位数字。

### 8.2 右侧三卡片全局美化（P1）

1. 卡片统一：圆角 10px、边框 #E5E6EB、纯白背景、阴影 0 1px 4px rgba(0,0,0,0.06)。
2. 标题加粗、字号上调、标题下 8px 间距。
3. 卡片内 padding 统一上下 16px、左右 20px。
4. 空状态：检查结论「暂无检查结论」浅灰弱化；组员卡片名称/模型/时间三行垂直紧凑对齐。

### 8.3 左侧任务树配套（P0）

1. 二级角色文件夹沿用 folder-bot/folder-check/folder-bug 线性图标；方案 A：角色下有子任务才渲染，无任务不渲染（0 角标空文件夹禁止）。
2. 一级 Token = worker+reviewer+tester 之和（v3 已有，回归确认）；二级角标 = 子任务数、不展示 Token（回归确认）。

### 8.4 中间面板（P1）

1. 任务指令/产出卡片与右侧卡片视觉统一（同圆角/padding/阴影）。
2. 执行总结 = 会话最后一条模型回复（最后一条含 summary/finalAnswer 的 entry 的 summary），与现有实现对齐即可，回归确认。

### 8.5 验收

真实数据（F:\agentmesh-data）：含 reviewer 消耗的组环形图三段正确渲染；全 0 角色显示 0 且不出现在环形图；三卡片/中间卡片视觉统一；typecheck/lint/UI 测试全绿。

## 9. 派发检查单（2026-09-01 增补，依据 r19 数据实测；已固化为协议规则）

> 以下各项已写入 `delegate_task` / `review_changes` 工具描述（protocol-as-prompt，见 src/mcp/tools.ts，协议测试 tools.test.ts 断言覆盖），每个编排客户端调用时可见，不再依赖宪法自觉。

每次 `delegate_task` / `review_changes` 派发前逐项核对，缺一不派：

1. **`background:true` ✓** —— 所有长任务一律后台派发。同步调用存在三重问题：宿主 30s 掐断（P-R14-4）、会话第一轮完成前不落盘（面板不可见）、不进 `registry.jsonl`（无实时终端绑定）。同步通道只留给 `get_session` / `list_agents` 等快查询。
2. **`contextSessionIds` ✓** —— 交接必须引用上游会话 id。r19 实测：9 个 reviewer 会话中约 5 个未带 `contextSessionIds`，被任务聚合规则判为孤儿，前端不渲染（§6.2 归属唯一依据就是 contextSources）。
3. **角色显式确认 ✓** —— worker/reviewer/tester 逐一过目。tester 不得默认省略：需要独立测试验证的任务必须显式派发 tester（r19 实测 tester 全程零调度）。
4. **简报自足 ✓** —— 文件路径、具体改动、验收标准齐备；契约接口写在简报里，禁止"based on your findings"式转引。
5. **并行切分 ✓** —— 契约先行后按文件集拆独立包并行（如数据层 `data.ts/api.ts/tests` ∥ 展示层 `panel.html`+mock），包粒度与集成点写进本轮派发记录，不写进宪法不派发。
6. **数据根一致 ✓** —— 派发前确认 bridge 环境与面板/CLI 读同一个数据目录（`AGENTMESH_SESSIONS_FILE`，见 §7 背景根因），双目录分裂会让面板看不到刚派发的任务，也造成会话记录"丢失"假象。
7. **复杂度闸门 ✓** —— 派发前先评估任务复杂度，结论写入派发记录：单文件高内聚/改动面小 → 组长直接改，不走 MCP（编排开销 > 工作量，r19 实测 1 小时 vs 直接改 20-40 分钟）；多文件可拆并行且契约可先定 → MCP 派发两包（数据层 ∥ 展示层+mock）；只读调研 → 并行扇出。**评估为"不值得派发"是合法结论，不是偷懒。**

## 10. v5 契约（终端绑定正确性，2026-09-01 诊断并已实施）

根因（已实证 data.ts:925-950）：

1. **无持久化关联**：`registry.jsonl` 记录（taskId/startedAtMs/outputFile）与 Bridge Session 之间没有 bgTaskId↔sessionId 关联，终端绑定只能时间贪心猜（|startedAtMs − updatedAt| 最小者胜），属猜测非事实。
2. **一对一耗尽**：worker 子任务数 > 注册表记录数时，后排组全部 terminal:null。
3. **占位误导**：terminal:null 显示「任务未执行」，对已完成任务是错误文案。

修复方案（按序）：

1. **盖章（核心层）**：后台任务执行时将 `bgTaskId` 写入其 worker session 的 `metadata.bgTaskId`（background.ts 与 session 落盘同进程，改动物理位置集中）。
2. **精确绑定（data.ts）**：`bindTerminal` 优先按 `metadata.bgTaskId` 精确匹配；无盖章的历史会话沿用时间贪心降级。
3. **文案（panel.html）**：terminal:null 且子任务有产出时显示「无终端记录（任务未以后台方式执行或记录已耗尽）」，仅未执行任务显示「任务未执行」。
4. **回归**：新增单测——盖章会话精确绑定、无盖章贪心降级、null 文案分支；现有 55 个 UI 测试不回归。

约束：panel.html/data.ts 正被 v3/v4 迭代高频编辑，本契约必须在 v4 验收后认领，避免并行撞车；认领者开工前先 `git status` 确认工作区干净。

## 11. 待办：MCP 工具体验改进（r19 沉淀，v5 提交后派发，用户已确认）

前置：v5 会话完成提交（连同 v1~v4 面板改动），工作区干净后由本会话或继任会话认领。

1.（P0）`review_changes` 增加 `excludePaths` 参数：排除清单内文件变更不触发树脏守卫（对应 P-R19-1，并行会话两次误伤评审）。2.（P0）后台任务 stalled 检测：stalled ≥1 轮询周期在 poll_task 返回中带 `hint.nextCandidates`（复用模型目录已知可用池），支持组长一键换道重派（对应 P-R19-3，免费评审员连续 stalled 白等约 40 分钟）。3.（P1）`delegate_task` 模型 ID 校验失败时返回候选列表（对齐 review_changes 的 "Did you mean" 格式）（对应 P-R19-4）。

实现文件预计在 src/core（MCP 工具层）+ 对应协议测试；注意与 runner.ts（§10 v5 已实施改动）的 import 关系，派发时给 worker 显式文件集。验收：协议测试覆盖三个新行为 + `npm run check` 全绿。复盘依据见 real_test.md 第十九轮。
