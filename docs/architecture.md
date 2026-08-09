# Birdbox 开发架构

本文描述当前生产代码的实际结构，并约束后续功能应放置的位置。Birdbox 已完成从浏览器原生
JavaScript 与单文件服务入口向 Vue 3、严格 TypeScript 和 Fastify 路由模块的迁移。

## 技术基线

- 运行时：Node.js 24 LTS
- 后端：TypeScript、Fastify 5、MySQL 8.4、BIRD 2
- 前端：Vue 3、TypeScript、Vite 6
- 共享契约：`packages/contracts`
- 测试：Node Test Runner、Playwright、原生 `bird -p`

## 目录结构

```text
apps/web/
  src/app/                 单一 Vue 根应用、应用壳和全局交互状态
  src/auth/                登录和首次设置
  src/account-sessions/    有效登录会话管理
  src/dashboard/           拓扑、运行状态、路由详情和 Dashboard store
  src/sessions/            BGP 会话草稿、Channel、策略和高级参数
  src/resources/           Node、Peer、Define、Function、Filter、Static、RPKI
  src/shared/              HTTP 客户端、表单、命名和跨功能事件
packages/contracts/src/    HTTP 与当前持久化数据的共享类型
src/http/                  Fastify 应用工厂、认证、查询、运行控制和写接口路由
src/bird-*.ts              BIRD 规范化、渲染、运行解析和远端操作
src/deployment-service.ts  部署锁内的预检、恢复日志、提交和回滚
src/inventory-domain.ts    库存查找、资源作用域、引用检查和节点配置生成
src/controller-ssh.ts      控制器 SSH 身份、密钥权限和 known_hosts 信任
src/node-onboarding-service.ts 节点接入、接入检查、准备脚本和退役
src/dashboard-service.ts   Dashboard 选择、运行状态和库存健康汇总
src/session-application-service.ts 会话候选配置、预检、应用、等待和删除
src/resource-application-service.ts 节点、Peer、策略、Static、RPKI 写用例
src/store.ts               库存升级、CAS 和旧文件导入
src/database.ts            MySQL 与内存数据库实现
src/auth.ts                密码和多登录会话领域逻辑
src/server.ts              环境解析、依赖组装、初始化、监听和关闭
test/                      领域、API、数据库、历史升级和浏览器回归
```

`public/index.html` 只负责加载主题初始化、样式和 Vite 产物。不得重新加入业务脚本或在
`public/` 中维护第二套表单、Dialog 和状态。

## 依赖方向

```text
Vue components -> dashboard/session stores -> shared HTTP client -> Fastify routes
                                                           |
Fastify routes -> application use cases -> DeploymentService / domain -> database and BIRD
```

- Vue 组件不得导入服务端模块。
- HTTP 路由只负责认证、参数边界、调用用例和响应状态，不拼接 BIRD 配置。
- `server.ts` 不得新增资源查找、库存变更、预检、远端 SSH 或 Dashboard 组装逻辑；新用例应进入对应的应用服务。
- BIRD 规范化与渲染模块不得导入 Fastify、Vue 或 DOM。
- `DeploymentService` 是远端变更事务的唯一实现，不得在路由中复制预检、日志或回滚流程。
- MySQL 与远端 BIRD 都不是 Vue 状态的附属缓存；成功写入后必须重新读取权威状态。

## 前端状态

`apps/web/src/app/AppRoot.vue` 是唯一 Vue 根应用，负责：

- 认证态与应用显示切换；
- 深浅色主题；
- 工作区切换；
- Toast、置顶变更等待框和账户设置；
- Dashboard 选择和刷新入口。

`dashboard-store.ts` 保存唯一 Dashboard 快照。资源表、会话编辑器和运行详情只消费该快照；
成功变更后通过 `loadDashboard` 刷新。会话草稿由 `session-store.ts` 单独持有，不能直接修改
Dashboard 中的持久化对象。

`birdbox:*` 浏览器事件只承载跨功能意图，例如“打开资源 Tab”“编辑资源”“认证失效”和
“显示 Toast”。事件类型必须声明在 `shared/events.ts`，不得通过事件复制库存或表单状态。

## 后端边界

- `auth-routes.ts`：首次设置、登录、退出、修改密码和多会话注销。
- `dashboard-routes.ts`：健康检查和 Dashboard 查询。
- `session-runtime-routes.ts`：路由明细及 BGP 协议启停。
- `mutation-routes.ts`：节点、Peer、策略、Static、RPKI 和会话写接口。

所有会改变远端配置的用例遵循同一事务：

```text
读取当前库存 -> 生成并完整规范化候选库存 -> 每节点 bird -p/远端预检
-> 写入恢复日志 -> 应用远端配置 -> CAS 提交库存 -> 清理恢复日志
```

任一步失败时，已应用节点按逆序回滚。进程中断后，启动流程根据恢复日志和库存 revision
决定继续提交或回滚；两者都不匹配时拒绝自动覆盖。

## 数据所有权

- MySQL `birdbox_state`：库存、认证状态和部署恢复日志的权威存储。
- `/var/lib/birdbox`：控制器 SSH 私钥、公钥、`known_hosts` 和一次性旧 JSON 导入源。
- 远端主配置：归用户所有。Include 模式只管理生成文件和主配置中的明确 include 行。
- Vue store：可丢弃的客户端快照，不是持久化来源。

接口和数据格式约束见 [数据兼容与迁移](data-compatibility.md)。
