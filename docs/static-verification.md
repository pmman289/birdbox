# Static 管理验收记录

## 交付范围

保留原有节点级 Static、CIDR Define 批量动作、逐路由属性和自定义源码，新增直接路由数组，每条路由有独立 ID。支持 IPv4/IPv6、普通下一跳、接口、ECMP 权重、递归、blackhole/unreachable/prohibit、BFD、Onlink、check link 和 IGP 表；Import 支持 Function 组合和 Filter。Static 与 Pipe 共用表声明，停用资源保留表。

新增独立候选预检、配置差异、候选与库存 revision 校验、Static 运行态和协议路由查询。客户端修改或关闭会取消旧预检，请求返回前草稿改变时丢弃响应。应用重新执行完整预检，失败保留编辑内容。已有 Static 在列表中的顺序在预检与应用之间保持一致，避免编辑首个资源时出现配置顺序差异。

库存格式由 29 升级为 31（v30 引入直接路由，v31 统一 Define 转发能力）；旧 Static 保留 ID、Define、动作、属性、自定义指令和启停状态，补默认表和新字段。升级不下发活动配置。应用版本未变更，未提交或推送。

## 实际环境与传输

| 环境 | 实际验证链路 | 结果 |
| --- | --- | --- |
| Linux，BIRD 2.17.5 | 本地 `bird -p`，临时配置 | 双栈高级配置、BFD 与 Onlink 分离、接口、递归、重复前缀、属性通过 |
| Debian 12 Docker，Node 24，BIRD 2.17.5 | HTTP API → Controller → 真实 Go Agent HTTP RPC → BIRD | 双栈预检、应用、运行态、路由、Static → Pipe、失败保护通过 |
| 同上，BIRD 2.19.0 | 同上 | 同上通过 |
| Chromium 桌面与移动端，BIRD 2.17.5 / 2.19.0 | 真实浏览器 → API → Agent → BIRD，无 API 拦截 | 创建、预检确认、应用、查看状态和目标路由、重新编辑、停用、删除通过 |

隔离实验使用临时 Docker 网络和容器。测试节点内的 lab0 接口、IPv4/IPv6 地址与路由仅存在于容器中，不使用 Kernel/BGP 协议修改宿主机转发。结束后清理容器、网络和临时凭据。

本轮未进行真实 SSH 传输验收。部署失败、CAS 提交失败、回滚与锁释放由 API 测试中的可控 Agent RPC / 库存故障注入验证；真实实验验证实际 BIRD 预检失败和陈旧 revision 被拒绝。

## 真实 BIRD 流程断言

- 预检前后库存一致，没有活动配置应用；确认后生成配置与预览逐字一致。
- IPv4/IPv6 的 ECMP 权重、主备、递归、接口和 Onlink 路由实际存在。
- Import Filter 拒绝指定前缀，已接收路由包含 Local Pref 177 和 Community `(64512,17)`。
- BFD 下一跳在没有对端会话时保持撤回；本轮未建立真实对端 BFD 会话测试恢复计时。
- 路由查询使用已保存的节点、表及协议，目标 IP 查询保留协议选择器；不把其它 Static 的路由算入当前实例。
- Static 自定义表中的路由经 Pipe 进入 master 表。
- 无效候选和陈旧 revision 不改变库存；停用后协议显示停用，路由为空。
- Pipe 仍引用 Static 所管理的表时，删除最后一个表声明会被实际 BIRD 预检拒绝；移除依赖后可正常删除。

## 自动化验证

- `npm run build`：服务端编译、Web 类型检查和构建。
- `npm test`：全量单元/API/事务与迁移测试。
- `cd agent && go test ./... && go vet ./...`：Agent 校验；覆盖目标 IP 与协议选择器同时保留及命令输入校验。
- `npx playwright test`：桌面/移动端全站回归。
- `npx playwright test test/e2e/static-management.spec.ts test/e2e/resource-editors.spec.ts test/e2e/pipe-management.spec.ts`：相关编辑器和 Pipe 回归。
- `BIRD_VERSION=2.17.5 bash scripts/static-e2e.sh`、`BIRD_VERSION=2.19.0 bash scripts/static-e2e.sh`：真实 BIRD/API/Agent 与桌面/移动浏览器完整流程，需要 Docker 和已安装的 Chromium。

Static 页面覆盖直接路由、独立下一跳、预检后二次确认、冲突后保留草稿并重新预检、编辑/删除、运行态、未保存关闭保护和过期预检响应；另覆盖 375/390/430px 布局、展开高级字段、固定标题和底部操作栏。已有 Define 批量属性编辑由资源编辑器回归覆盖。

结果：Node 24 全量 253 项通过、1 项 MySQL 集成测试因无测试数据库跳过；全站 Playwright 48 项通过、2 项一小时 OSPF 压力测试按默认规则跳过。随后针对最终滚动布局及校验调整重跑相关专项；两版真实 BIRD 的桌面/移动浏览器各 2 项通过。最新专项结果见本记录末尾。

最终专项结果：Static、资源编辑器与 Pipe 的桌面/移动端 30 项复测全部通过，包含修复后的外层禁止滚动、内容区独立滚动、标题与底部操作栏位置断言。最终服务端/Web 构建、类型检查、Agent test/vet 和 `git diff --check` 均通过。临时实验容器、网络及安装凭据已清理。


## 路由来源统一验收（2026-10-19）

取消“直接添加 / Define 批量”编辑模式切换。保留可选 Define 关联和添加路由入口，所有结构化路由共用一份列表与编辑器。Define 前缀只读，其余转发、启停和属性控件一致。支持混合保存、临时取消关联后恢复草稿、统一转发模板、独立下一跳和独立属性。批量转发模板作为后续新增 Define 前缀的默认值，保留现有单条启停；旧字符串动作兼容，库存版本 31 防止旧程序覆盖新字段。

新增测试覆盖结构化 Define 动作与手动路由使用相同校验、双栈配置解析、停用前缀、不共享默认对象、动态 Define 更新与失效条目清理、预检/保存配置一致、v30 升级、草稿恢复及嵌套字段修改使预检失效。测试发现重新打开时默认值可能覆盖逐条设置，已改为完成来源快照加载后再初始化草稿，并通过桌面和移动端回归。

实际验证：

- Node 24 全量单元/API/迁移测试 258 项通过，1 项 MySQL 集成测试因未提供专用数据库跳过。
- 服务端编译、Web 类型检查及生产构建通过。
- Static、资源编辑器、Pipe 与来源统一共 40 个桌面/移动端场景通过（修复后针对失败项复测）；375/390/430px 检查展开 ECMP、属性和固定操作栏无横向溢出。
- 在隔离 Debian 12 容器中，对 BIRD 2.17.5、2.19.0 分别重跑 HTTP API → 真实 Go Agent → BIRD。新增关联 Define 的 IPv4/IPv6 ECMP、递归、逐条属性、停用及后续新增网段继承测试通过；每个版本的真实桌面/移动端浏览器流程各 2 项通过。未测试 SSH 传输。
- 更新中的验收 demo 使用模拟 Agent，与上述真实 BIRD 实测分离；已在桌面 1440px、移动 390px 无 API 拦截验证混合路由编辑 → 预检 → 应用 → 运行态 → 重新打开。示例“统一路由编辑 · Define + 直接添加”含 ECMP、递归、接口和停用条目。


## 最终联动回归（2026-10-19）

Static、Pipe 与资源列表的桌面/移动浏览器共 46 项通过，包含 375/390/430px 布局。当前 Node 24 全量单元/API 共 322 项，321 通过，1 项 MySQL 测试因无专用数据库跳过；前后端类型检查与生产构建通过。

Static 在隔离 Debian 12 + BIRD 2.17.5 / 2.19.0 的真实 HTTP→Go Agent→BIRD 原生流程分别通过，每个版本的桌面/移动真实浏览器各 2 项通过。原生脚本明确只运行 `test/live/static.spec.ts`，避免误跑其它 demo 专项。未测试真实 SSH。

## 公网 HTTP 添加路由修复（2026-10-19）

`crypto.randomUUID()` 仅在安全上下文可用。localhost 测试可正常新增路由，但通过公网 HTTP 打开 Demo 时，该方法不存在，点击“添加路由”不会生成条目。改用 HTTP 下可用的 `crypto.getRandomValues()` 生成独立的 128 位条目标识。

Static 专项桌面/移动端 22 项通过，包括显式移除 `randomUUID` 后连续新增、独立编辑、预检、应用与重新打开，以及 375/390/430px 布局。Web 类型检查、生产构建与 `git diff --check` 通过。

`hyhk01` 已更新为 `birdbox-acceptance:hyhk01-static-http-20261019`。在公网 HTTP 地址上，桌面/390px 手机端实际完成新增两条路由、预检不写入、应用、重新打开、编辑、运行态与删除，2 项通过。Demo 使用模拟 Agent，此次没有重测真实 BIRD 或 SSH。更新前保存库存和 OSPF 独立布局，更新后核对原有 32 条 Static 数据完全一致；测试资源已删除。验收 HTML 的资源 URL 带独立构建标识，刷新后会加载新脚本。
