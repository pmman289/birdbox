# iBGP 工作区与部署验收

## 已完善

- 域及双端会话仍独立编辑；新增连接启停开关，停用状态直接解释为“已停用”。
- 完整节点候选包含动态 IRR Include；预检覆盖新旧成员的并集，移除成员也能查看旧节点上的清理差异。节点检查并发执行，各节点异常分别返回。
- 预检只读，不覆盖输入的密码、端口、策略或已保存快照。响应必须同时匹配域、草稿签名和库存版本；过期成功和失败均被丢弃。每次修改立即使旧预检失效，空域也可预检保存。
- 显式“预检并查看变更”，按节点展开差异和错误；应用前确认影响节点。候选绑定库存 revision、哈希及五分钟凭证，应用仍完整预检，沿用 CAS、部署 journal 和回滚。
- 域切换、新建、离开工作区和关闭页面保护草稿；应用期间锁定编辑。切换取消后域选择器恢复原值。
- 冲突保留本地双端内容，可读取最新配置，选择采用远端或保留本地后重新预检。服务端域已删除时可将草稿作为新域；无法恢复的密码占位符清空，必须重新输入。
- 点击节点不再触发布局写入；真正拖动后才保存布局。节点和连线共用默认位置。布局持久化不执行配置预检、部署或占用部署锁；库存版本变化仍会使已预检候选失效。
- 修复移除连接按钮继承全行网格样式而掉到下一行的问题，逐节点成功结果使用节点名称和中文状态。

## 接口

- GET `/api/ibgp-domains` 补充 `inventoryRevision`。
- POST `/api/ibgp-domains/preview` 接受可选 `inventoryRevision`；返回规范化域与会话、各端预览、完整节点配置与差异、检查结果、`previewId` 及 `candidateHash`。
- POST/PUT 原域接口支持 `mode: "apply"`、`previewId`、`candidateHash`、`inventoryRevision`。缺失或篡改已审核候选返回 `IBGP_PREVIEW_STALE`；库存变更返回 `STATE_CONFLICT`。原 API 客户端仍执行完整服务端事务预检。
- DELETE 支持可选库存 revision；布局 PATCH 返回最新 revision。
- 凭据、候选配置及差异统一脱敏，服务端从绑定快照恢复新输入的凭据。

## 验证与边界

- `npm run build`：前后端类型检查与构建通过。
- Node 24 全量单元测试 299 项，298 通过，1 项 MySQL 环境集成测试跳过。
- `test/ibgp-api.test.js`：真实 HTTP + 库存/事务服务 + 模拟 Agent；覆盖只读预检、独立端口/双栈策略/RR、候选一致性、停用恢复、移除成员清理、无部署布局保存、空域、CAS、凭证校验、新凭据脱敏恢复、完整 IRR Include、节点失败隔离、回滚及重试。
- `test/e2e/ibgp-management.spec.ts` 与原 `ibgp-workspace.spec.ts`：桌面/移动覆盖独立双端编辑、空域创建删除、失败保留、冲突恢复、过期错误、离开保护、取消域切换及 375/390/430px 几何检查；单独断言移除按钮与连接卡片同行；最终 10 项全部通过。
- `test/live/ibgp-live.spec.ts`：桌面和移动真实 HTTP 两项通过，不拦截域 API；拓扑连接→独立端口→预检不写入→确认应用→重新编辑→停用→等待删除完成后核对库存。使用模拟 Agent。
- `scripts/ibgp-e2e.sh`：Debian 12 隔离 Docker 网络中，两台真实安装的 Go Agent + BIRD 2.17.5 / 2.19.0 分别通过：同 ASN 邻居、1179/2179 独立端口、实际双栈路由、IPv4 Filter 拒绝而 IPv6 恢复、RR、引用保护、逐节点原生预检、CAS、启停恢复、成员范围清理及删除。原生 CLI `show bfd sessions` 在两端分别确认 BFD `Up`，未用 BGP 邻居状态推断 BFD。
- 验收 Demo 增加独立 iBGP 核心互联示例。保留原有验收编辑，运行态与部署为模拟 Agent。

没有修改生产节点、宿主路由或公共邻居。原生验证覆盖 Agent，未实测 SSH 部署、MD5/AO 握手或 BFD 故障收敛时间。长期压力测试不在本轮结果内。

```bash
npm run build
npm test
BIRDBOX_E2E_PORT=31021 npx playwright test test/e2e/ibgp-management.spec.ts test/e2e/ibgp-workspace.spec.ts
BIRDBOX_STATIC_URL=http://127.0.0.1:31011 npx playwright test --config playwright.static.config.ts test/live/ibgp-live.spec.ts
BIRD_VERSION=2.17.5 bash scripts/ibgp-e2e.sh
BIRD_VERSION=2.19.0 bash scripts/ibgp-e2e.sh
```
