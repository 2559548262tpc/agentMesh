# ORCHESTRATION.md — r22 多人点餐小程序项目宪法

> 通用约束见 ORCHESTRATION.BASE.md（裁决争议时才读）。本文只写本项目特有内容，开工先读本文。

## 1. 目标

按需求文档实现微信点餐小程序全栈系统（9 页 + 8 个云函数），同时暴力测试多 worker×多 reviewer×多 tester 并行协作。需求源：`F:\AgentMesh_8_28\wechat_eat\多人内部点餐小程序完整版需求文档（液态玻璃UI+自定义背景+90帧丝滑交互+轮播公告+订单推送）.md`（只读）。工作区：`F:\agentmesh-r22\workspace`（隔离 git 仓库）。共享契约：工作区 `CONTRACT.md`（语义定稿，组员不得更改）。

## 2. 验收标准（可判定，返工依据）

1. `node acceptance.test.js` 退出码 0（结构完整/9页4文件/占位appid/云函数结构/node --check 全量/管理页拦截代码/wxss 动画白名单/7 集合字段逐字）。
2. `node --test cloudfunctions/` 退出码 0（mock 版单测：5人上限、三级权限守卫、状态流转 0→1→2、下单推送断言、上下架过滤）。
3. 零第三方依赖（云函数仅 wx-server-sdk 声明，前端无任何 npm 引入）；无真实凭据写死。
4. 不可验证项诚实声明：90帧/真机视觉/微信推送真机行为不在验收内，仅静态规则检查。

## 3. 项目特有契约

- 错误码/API 签名/集合字段/文件集归属：全部以工作区 `CONTRACT.md` 为准（§1-§7）。
- 骨架文件组长所有：`project.config.json`、`miniprogram/app.json`、`miniprogram/app.wxss`、`miniprogram/utils/*`、`cloudfunctions/test/helpers/*`、`acceptance.test.js`、`CONTRACT.md`。worker 越界改动=FAIL。
- 单测 mock：`cloudfunctions/test/helpers/`（install-mock.js + mock-wx-server-sdk.js），不装真实 SDK。
- 进度流水：每阶段结束在 `F:\agentmesh-r22\workspace\PROGRESS.md` 追加一行（时间、会话、结论）。

## 4. 非范围

- 真机 90帧/视觉走查、微信开发者工具调试、真实 appid/云环境、订阅消息真实下发。
- 第三方 CSS/JS 框架引入。

## 5. 分工与模型（全部 opencode 通道，免费池）

| 角色                      | 包                                    | 模型                                                            |
| ------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| worker W1 用户/登录云函数 | user+login                            | opencode/big-pickle                                             |
| worker W2 点餐核心云函数  | foods+orders                          | opencode/big-pickle                                             |
| worker W3 内容配置云函数  | config+banner+notice+push_config      | opencode/nemotron-3-ultra-free（0字节2分钟弃换 mimo-v2.5-free） |
| worker W4 顾客侧前端      | index/cart/orders/order-detail+app.js | opencode/muse-spark-1.2-contributor-free                        |
| worker W5 管理侧前端      | pages/admin/\*\*（5页）               | opencode/muse-spark-1.2-contributor-free                        |
| reviewer R1 契约快审      | 全线                                  | opencode/big-pickle                                             |
| reviewer R2 云函数深审    | W1-W3                                 | opencode/mimo-v2.5-free                                         |
| reviewer R3 前端深审      | W4-W5                                 | opencode/big-pickle                                             |
| tester T1 云函数执行      | 全部单测+对抗输入                     | opencode/mimo-v2.5-free                                         |
| tester T2 结构验收        | acceptance+node --check               | opencode/mimo-v2.5-free                                         |

## 6. 交付物

工作区内：`miniprogram/`（9页全量）、`cloudfunctions/`（8函数+tests）、`acceptance.test.js` 通过、单测通过、`PROGRESS.md` 流水、主仓库 `real_test.md` 追加第 22 轮记录。
