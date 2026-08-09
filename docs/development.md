# Birdbox 开发规范

## 本地环境

开发、CI 和生产构建统一使用 Node.js 24。服务默认监听 `0.0.0.0:3000`。

```bash
npm ci
npm run build
npm test
npm run test:e2e
npm run dev
```

Playwright 首次运行前安装与依赖版本一致的 Chromium：

```bash
npx playwright install --with-deps chromium
```

## TypeScript

- 新代码只使用 `.ts` 或 `.vue`，严格模式必须通过。
- 禁止 `any`、`@ts-ignore` 和 `@ts-nocheck`；边界数据使用 `unknown` 并在入口收窄。
- HTTP、认证、库存和持久化结构从 `packages/contracts` 导入，不重复声明同名类型。
- 类型不能替代运行时校验。HTTP、MySQL、JSON、SSH 和 BIRD 输出进入领域层前必须规范化。
- 持久化枚举使用字符串联合，不能依赖 TypeScript 数字 enum。
- 文件使用 `kebab-case`，Vue 组件使用 `PascalCase`，变量和函数使用 `camelCase`。
- 用户可见错误应带稳定 `code`；业务逻辑不得依赖中文文案匹配。

## 后端

- Fastify 路由只做认证、参数解析、调用 service 和映射 HTTP 响应。
- 新接口应声明 Fastify JSON schema，并同步更新共享契约和接口测试。
- 禁止在路由中直接修改库存数组或拼接 BIRD 配置。
- 远端变更必须经过 `DeploymentService`，使用部署锁、恢复日志、预检、CAS 和回滚。
- SSH 参数使用参数数组或标准输入传递；不得拼接到 shell 命令字符串。
- 日志和错误响应不得输出 Cookie、控制器私钥、TCP-MD5/TCP-AO 密钥或完整敏感配置。
- 不新增 `if (pathname...)` 路径分发；按领域扩展 `src/http` 路由插件。
- 关闭流程必须等待正在执行的部署事务，不能在远端已应用但库存未提交时退出。

## Vue

- `AppRoot.vue` 是唯一根应用，不新增嵌套 `createApp` 入口。
- 服务端数据只通过 Dashboard store 和统一 HTTP 客户端读取。
- 表单草稿必须与 Dashboard 快照分离，不可直接修改持久化对象。
- 自动预检使用 debounce、AbortController 和草稿签名；过期响应不能覆盖新草稿。
- 移动端输入期间不得抢焦点、关闭键盘或重建当前输入组件。
- 超过 300 ms 的等待必须显示明确 loading；部署操作使用置顶等待框，局部预检使用区域遮罩。
- 表单失败要标记具体字段、展开所在区域、滚动到输入框并保留继续编辑能力。
- Dialog 关闭、异常和认证失效后必须恢复交互，不得残留 `inert` 或透明遮罩。
- 列表使用稳定业务 ID 作为 `key`；仅临时、不可重排的本地输入项可使用受控索引。
- 主题只通过 CSS 变量和应用壳控制，不在组件中硬编码两套颜色。
- 不使用 `v-html` 或 `innerHTML` 渲染服务端内容。

## HTTP 客户端

- 所有请求使用 `shared/api-client.ts`，默认携带 same-origin Cookie。
- GET、普通写请求和远端部署使用不同超时等级。
- `AUTH_REQUIRED` 统一清理 Dashboard 并返回登录页。
- 未知结果的部署请求不得自动重试；先刷新库存和节点状态，再由用户确认。
- 组件卸载或选择变化时取消不再需要的 GET/预检请求。

## 数据变更

- 库存 schema 只能逐版本升级，不允许原地改变旧版本含义。
- 升级必须保持幂等，并使用 CAS 写回。
- 不要求用户清空数据库、删除数据卷或重建节点。
- 修改库存或认证格式时，必须增加历史 fixture 和高版本拒绝测试。
- 控制器 SSH 私钥与 `known_hosts` 是同一身份边界，任何一侧缺失都不得静默重建。

## 测试门槛

提交前至少执行：

```bash
npm run typecheck:server
npm run typecheck:web
npm run build
npm test
npm run test:e2e
git diff --check
```

发布前还必须执行：

- MySQL 8.4 集成测试，不允许跳过；
- 涉及 BIRD 渲染时使用支持版本的真实 `bird -p`；
- Docker 镜像构建、健康检查、登录和历史库存升级演练；
- `npm audit`；
- 桌面 Chrome 与 Pixel 7 的关键流程和布局检查。

Node Test Runner 只执行 `test/*.test.js`；Playwright 用例放在 `test/e2e`，不能被普通单测命令重复加载。

## Code Review

按以下顺序检查：数据损坏与远端部署、认证与命令注入、并发一致性、秘密泄露、错误恢复、
历史兼容、移动端交互、可维护性和样式。测试结论必须说明实际覆盖范围，不能用窄单测替代
MySQL、BIRD、浏览器或容器级验证。
