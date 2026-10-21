# Function / Filter 共享编辑流程验证

共享 Define 编辑器的候选预检、引用与冲突恢复流程扩展到 Function/Filter：编辑上下文提供 inventory revision 和直接/间接引用；预览完整配置包及 IRR Include，逐节点保留结果，不写库存、不部署。有效候选绑定资源、种类、hash 和 revision，5 分钟过期，最多保留 200 项。应用仍完整预检并使用已有部署锁、CAS、journal 和回滚。

页面先展示差异，再明确确认应用；修改内容使预览失效。失败保留草稿，可读取最新版本对比、采用远端或明确保留本地后重新预检；资源已删除时可保留内容作为新资源。关闭、Esc、切换资源和浏览器离开保护未保存内容。引用面板覆盖 Function → Filter → 协议的间接依赖。编辑内容独立滚动，标题及底部操作固定。此次还修复了共享面板被惰性 HTML template 隐藏的问题。

接口为 `GET /api/functions/editor-context`、`POST /api/functions/preview`，Filter 使用对应 `/api/filters` 路径。保存接受 `mode: "apply"`、previewId、candidateHash 和 inventoryRevision；旧 API 调用继续执行完整事务预检。

当前证据（2026-10-19）：

- `test/policy-api.test.js`：只读预检、候选绑定与篡改、种类隔离、CAS、范围并集清理、启停删除、IRR Include、逐节点错误、回滚重试、直接/间接引用及依赖删除保护。包含在本轮 303 项单元/API 测试中，302 通过、1 项 MySQL 环境跳过。
- `test/live/policy-live.spec.ts`：真实 HTTP，桌面/移动 4 项通过。覆盖创建 → 无写入预检 → 确认应用 → 重开编辑 → 取消放弃草稿 → 编辑应用 → 停用/启用 → 删除。使用验收实例模拟 Agent，不代表真实节点路由传递实测。
- 共享 Defines 和资源编辑器浏览器 30 项通过；服务端/前端类型检查与构建通过。

双版本原生联动现已完成：`scripts/ebgp-e2e.sh` 在隔离 Debian 12 节点安装当前 Go Agent，通过管理 API 预检并部署表达式 Define → Function → Filter → BGP 导入链。BIRD 2.17.5 / 2.19.0 的实际路由均得到 `BGP.local_pref: 188` 和 `(64512,188)` Community；修改 Filter 后 IPv4 路由撤回，IPv6 保持。直接/间接引用、删除保护、解除消费者、停用/启用及删除均通过。原生证据与模拟 HTTP 流程分开记录；未改动生产节点。

复现：`BIRD_VERSION=2.17.5 bash scripts/ebgp-e2e.sh`，以及相同命令的 `2.19.0` 版本。源地址出口的独立验收见 `source-policy-verification.md`。
