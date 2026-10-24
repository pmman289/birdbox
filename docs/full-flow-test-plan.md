# Birdbox 全功能全流程测试计划

## 目标

验证 Birdbox 从管理员登录、资源创建、策略编辑、预检、应用、运行态查看、冲突处理到失败回滚的完整用户流程，并确认生成的 BIRD 配置可由真实 `bird -p` 解析。

## 测试环境

- 浏览器：Playwright Desktop Chrome、Pixel 7 移动视图
- 控制器：Memory 数据库测试服务，避免修改生产库存
- BIRD：本机 `/usr/sbin/bird`
- 验收节点：本地测试节点或 Playwright API/Agent fixture
- 每个场景开始前清理库存、认证状态和临时配置

## 流程覆盖矩阵

| 区域 | 核心流程 | 证据 |
|---|---|---|
| 认证与账户 | 首次设置、登录、退出、改密、会话注销 | `auth-shell.spec.ts`、`auth.test.js` |
| 节点与 Peer | 节点创建/编辑/测试/删除、Peer CRUD、节点准备脚本 | `resource-editors.spec.ts`、`deployment-lifecycle.test.js`、`node-onboarding.test.js` |
| eBGP | 选择节点和 Peer、双地址族策略、预检、应用、停止、删除、冲突恢复 | `ebgp-management.spec.ts`、`ebgp-api.test.js` |
| 当前项 Filter | 自定义模式、共享 Filter/当前项源码切换、代码编辑、预检载荷、BIRD 解析 | 当前流程 Playwright、`bird.test.js` |
| iBGP | 域创建、成员/邻接编辑、双端预检、应用、空域和冲突 | `ibgp-management.spec.ts`、`ibgp-workspace.spec.ts`、`ibgp-api.test.js` |
| OSPF | 域、区域、接口、链路、版本、拓扑布局、预检/渲染/应用 | `ospf-workspace.spec.ts`、`ospf-review.spec.ts`、`ospf-topology-pressure.spec.ts`、`ospf-api.test.js` |
| 路由资源 | Define、Function、Filter CRUD、引用保护、作用域、表达式/CIDR | `define-management.spec.ts`、`resource-editors.spec.ts`、对应 `*-api.test.js` |
| Static | 创建、CIDR 条目、路由动作、per-route Filter、运行态和路径 | `static-management.spec.ts`、`static-api.test.js` |
| Pipe | 双向策略、预检、应用失败保留草稿、运行态和路由 | `pipe-management.spec.ts`、`pipe-api.test.js` |
| System/Kernel | Direct、Kernel、通道策略、表冲突、运行态 | `system-protocol-management.spec.ts`、`system-protocol-api.test.js` |
| RPKI | 文件/RTR 源、同步、ROA、运行态、作用域 | `rpki-management.spec.ts`、`rpki-api.test.js` |
| 源地址出口映射 | 出口组、计划、路由/运行态、冲突和预检 | `source-policy-management.spec.ts`、`source-policy-api.test.js` |
| Agent 与部署 | 注册、心跳、任务轮询、结果、升级、部署锁、失败回滚 | `agent-*.test.js`、`deployment-*.test.js` |
| 安全与兼容 | 脱敏、权限、库存升级、状态冲突、超时、MySQL schema | `inventory-redaction.test.js`、`upgrade-safety.test.js`、`database-schema.test.js`、`http-timeout.test.js` |

## 执行顺序

1. 静态质量门：类型检查、构建、diff 检查。
2. 服务端单元/API/领域回归：`npm test`。
3. 浏览器全流程：`npm run test:e2e`，桌面和移动项目均执行。
4. 新增策略流程：当前项 Filter 页面流程，检查请求载荷和预检结果。
5. 原生配置验证：对关键生成配置运行 `bird -p -c`。
6. 汇总每个矩阵项的通过、失败、跳过和环境限制。

## 通过标准

- 自动化测试无失败；跳过项必须有明确环境原因。
- 当前项 Filter 不进入共享 Filter 资源列表，且能进入会话预检请求。
- 预检生成的配置通过真实 `bird -p`。
- 失败预检、部署失败和并发冲突不提交错误库存，并保留可恢复草稿。
- 桌面和移动视图无阻断性布局或操作问题。

## 本次执行记录（2026-10-24）

- `npm run typecheck:server`：通过。
- `npm run typecheck:web`：通过。
- `npm run build`：通过。
- `npm test`：378 通过，0 失败，3 跳过（MySQL 环境相关）。
- `npm run test:e2e`：212 通过，0 失败，2 跳过（214 条，耗时约 29.7 分钟）；跳过项是桌面和移动各一次的一小时 OSPF 压力测试，需显式设置 `BIRDBOX_RUN_LONG_E2E=1`。
- 当前项 Filter 页面专项流程：桌面和移动各 1 条均通过；登录、选择 eBGP 会话、切换自定义/当前项编写、在代码输入框输入源码、发起预检，载荷和页面结果均通过；流程测试固化为 `test/e2e/current-filter-management.spec.ts`。
- 关键生成配置已使用 `/usr/sbin/bird -p` 解析通过。
