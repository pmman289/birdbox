# OSPF 管理功能全量测试计划

本文用于 OSPF 管理功能的回归、发布验收和事故复盘。测试目标不是只确认配置字符串生成成功，而是验证从画布编辑、库存保存、远端下发到 BIRD 邻居收敛和路由传播的完整闭环。

## 0. P0 问题分析与复现基线

### 0.1 `STATE_CONFLICT` 的风险模型

库存采用带 revision 的乐观并发控制。一次 OSPF 保存通常会经历“读取库存、规范化和校验、逐节点预检、逐节点应用、按旧 revision 提交”几个阶段。以下任一并发写入都可能使提交时 revision 过期：

- 另一个浏览器会话同时保存同一 OSPF 域或其它域。
- 拓扑拖动产生的布局 PATCH 与域配置 PUT 交错到达。
- 其它资源编辑、节点管理、Agent 注册/撤销等库存写入。
- 后台迁移、规范化或轮询逻辑错误地把只读请求变成写入。
- 远端应用耗时期间用户重复点击保存，或多个标签页同时提交。

这类冲突必须由服务端在部署事务边界内处理：重新读取最新库存、重新构造候选配置、重新预检并应用；已经下发过的节点必须先回滚。用户不能看到可恢复的 `STATE_CONFLICT`，也不能留下“远端是新配置、库存是旧配置”的分裂状态。达到重试上限时，应返回稳定且可理解的最终错误，同时控制器和其它节点仍可继续操作。

### 0.2 标准复现步骤

1. 准备至少 3 个隔离测试节点和一个包含两条链路的 OSPF 域，记录库存 JSON、revision、各节点活动配置和 `deployment_journal`。
2. 在客户端 A 打开域编辑页，修改 n1 的策略；在客户端 B 打开同一域，修改 n2 的 cost。两边同时点击“保存并应用”。
3. 在保存持续期间连续执行 `GET /api/dashboard`、`GET /api/ospf/:id/runtime`，并在第三个客户端拖动 n3 的位置。
4. 重复上述步骤 20 次，同时注入一次首节点预检失败、一次第二节点应用失败和一次数据库 CAS 冲突。
5. 收集 HTTP 状态和响应体、事件日志、部署日志、库存 revision、远端 `birdc show protocols` 和生成配置 SHA256。

### 0.3 通过判定

- 并发保存最终按服务端定义的顺序成功，或只有最后一次返回明确的业务冲突；不得大量返回 `STATE_CONFLICT`。
- 每次失败均保持库存、活动配置、资源文件和恢复日志的一致性；不得出现半套 OSPF 配置。
- 预检和运行态 GET 不推进库存 revision；布局保存只改布局，不触发 BIRD 应用。
- 单节点失败只影响该节点和本次事务，控制器健康检查、其它节点操作和下一次保存均可用。
- 重试、回滚和最终失败各产生一条关键事件，禁止对每次轮询刷屏。

## 1. 测试分层与放行标准

| 层级 | 运行方式 | 覆盖目标 | 发布要求 |
| --- | --- | --- | --- |
| L0 单元 | `npm test` | 规范化、校验、渲染、解析、并发状态 | 全部通过，禁止跳过新增 P0 用例 |
| L1 API | Node test + MemoryDatabase/MySQL | HTTP 契约、CAS、部署回滚、节点隔离 | 所有 P0/P1 通过 |
| L2 UI | Playwright 桌面 + Pixel 7 | 表单、画布、弹窗、加载和错误状态 | 无 page error、无水平溢出、关键断言通过 |
| L3 实机 | 控制器 + 3 台 Linux/OpenWrt Agent | BIRD 邻居、路由、重启和故障恢复 | 三角形、全互联、双栈场景均收敛 |

P0 规则：任何数据丢失、错误下发、配置预览与实际配置不一致、页面锁死、并发保存返回 `STATE_CONFLICT`、单节点失败导致整个控制器不可用，均视为阻断发布。

## 2. 固定测试数据

### 2.1 节点

使用不包含生产数据的 `n1`、`n2`、`n3`、`n4`，每个节点至少返回以下接口：

| 节点 | Router ID | OSPFv2 接口 | OSPFv3 接口 | 备注 |
| --- | --- | --- | --- | --- |
| n1 | `192.0.2.1` | `ptp12`、`ptp14` | `ptp12`、`ptp14` | Agent |
| n2 | `192.0.2.2` | `ptp21`、`ptp23`、`ptp24` | 同名 | Agent |
| n3 | `192.0.2.3` | `ptp32`、`ptp34` | 同名 | Agent |
| n4 | `192.0.2.4` | `ptp41`、`ptp42`、`ptp43` | 同名 | SSH 兼容节点 |

预置两个策略资源和两个 Define：

- `fn_accept_n1` 只作用于 `n1`，`fn_reject_n2` 只作用于 `n2`。
- `filter_n1` 只作用于 `n1`，`filter_global` 作用于全部节点。
- `OSPF_V4_EXPORT` 类型 `cidr4`，`OSPF_V6_EXPORT` 类型 `cidr6`。

### 2.2 拓扑

测试数据按以下阶段复用：

1. 单链路：`n1 - n2`。
2. 三角形：`n1 - n2 - n3 - n1`。
3. 全互联：`n1`、`n2`、`n3`、`n4` 两两连接。
4. 平行链路：`n1` 与 `n2` 使用两条不同接口的链路；再测试 NBMA/PtMP 共享接口。
5. 多 Area：Area `0.0.0.0` 与 `0.0.0.1`，另加一条跨非骨干 Area 的 Virtual Link。

## 3. L0 数据模型与校验用例

每个用例都要断言：请求失败不改变原库存；错误信息指出字段；不会生成或下发部分配置。

| ID | 场景 | 操作与断言 | 级别 |
| --- | --- | --- | --- |
| OSPF-VAL-001 | 空域 | 无节点、无链路可以保存；画布无线段、运行详情显示空状态 | P0 |
| OSPF-VAL-002 | 节点配置去重 | 相同 `nodeId` 两条配置必须拒绝 | P0 |
| OSPF-VAL-003 | 链路节点引用 | 不存在节点、同节点自环必须拒绝 | P0 |
| OSPF-VAL-004 | 接口完整性 | 本端或对端接口为空必须拒绝；两端接口名称按端点独立保存 | P0 |
| OSPF-VAL-005 | 端点自动启用 | 链路存在时两端 `enabled` 为 false，规范化后都为 true；删除最后一条链路不应误启用其它节点 | P0 |
| OSPF-VAL-006 | 版本选择 | v2、v3 可单独或同时启用；至少保留一个版本；禁用 v2 不得影响 v3 策略 | P0 |
| OSPF-VAL-007 | 策略隔离 | n1/n2 使用不同 import/export action、Function、Filter、Define；切换节点、保存、重新加载后值仍分别保持 | P0 |
| OSPF-VAL-008 | 版本策略隔离 | 同一节点 v2 与 v3 使用不同策略；生成配置分别落在 IPv4/IPv6 channel | P0 |
| OSPF-VAL-009 | 作用域 | 节点本地 Function/Filter/Define 被其它节点引用必须拒绝；全局资源可被所有节点引用 | P0 |
| OSPF-VAL-010 | Cost 统一 | 同一节点对多条平行链路 cost 不一致必须拒绝；一致时允许保存 | P0 |
| OSPF-VAL-011 | 接口复用 | PTP/Broadcast 复用同一端口必须拒绝；NBMA/PtMP 仅在 Area、hello/dead、认证等参数一致时允许 | P1 |
| OSPF-VAL-012 | 数值边界 | cost 1/65535、hello 1/65535、dead=hello、dead<hello、instance 0/255、tick、ECMP、优先级、TTL、DSCP 等边界分别测试 | P1 |
| OSPF-VAL-013 | Area 约束 | Area 必须 IPv4；Backbone 禁止 Stub/NSSA；Networks/External/Stubnet 前缀、tag、cost 非法时拒绝 | P1 |
| OSPF-VAL-014 | Virtual Link | Router ID 和传输 Area 必须为非 Backbone IPv4；时间、认证、密码参数完整校验 | P1 |
| OSPF-VAL-015 | 认证组合 | none 不输出认证指令；simple/md5/ipsec 生成正确；OSPFv3 simple 必须拒绝；密码选项完整保留 | P1 |
| OSPF-VAL-016 | 旧数据兼容 | 缺失 `options.type`、旧认证字段、旧 layout、旧 node config 读取后补默认值且不丢字段 | P0 |
| OSPF-VAL-017 | 布局清理 | layout 中不存在的节点被移除；合法节点坐标四舍五入并保留 locked | P1 |

## 4. L0 配置渲染与 BIRD 语法用例

对每个组合执行 `bird -p -c <generated.conf>`；除断言字符串外，必须以 BIRD 实际解析成功为准。

| ID | 场景 | 关键断言 | 级别 |
| --- | --- | --- | --- |
| OSPF-REN-001 | v2/v3 双栈 | 协议名称稳定、唯一、长度不超过限制；分别生成 v2 和 v3 | P0 |
| OSPF-REN-002 | 禁用节点 | 节点 `enabled=false` 时不渲染 OSPF 协议；其它节点配置不受影响 | P0 |
| OSPF-REN-003 | 自动 Router ID | Router ID 留空时由 BIRD 自动选择；填写时只影响当前节点 | P1 |
| OSPF-REN-004 | 默认 PTP | 未提供 type 时明确输出 `type ptp;`；不默认输出认证 | P0 |
| OSPF-REN-005 | 端点方向 | 从节点 A 渲染使用 `localInterface`，从节点 B 渲染使用 `remoteInterface`；不能把对端接口写到本端 | P0 |
| OSPF-REN-006 | 平行链路 | 不同物理接口生成独立 interface block；NBMA/PtMP 共享接口合并 neighbors | P1 |
| OSPF-REN-007 | 基础策略 | import/export all、none、cidr、combined、custom Filter 分别生成正确语法 | P0 |
| OSPF-REN-008 | 策略顺序 | Function 按步骤顺序执行；静态重分发的 `if source = RTS_STATIC then accept;` 位于终止动作前 | P0 |
| OSPF-REN-009 | 高级协议 | rfc1583compat、rfc5838、instance id、stub router、tick、ECMP、merge external、graceful restart 全部按开关输出 | P1 |
| OSPF-REN-010 | Area 属性 | stub、nssa、summary、default cost、translator、networks、external、stubnet 全部输出且无重复 area | P1 |
| OSPF-REN-011 | Interface 属性 | poll、retransmit、transmit delay、priority、wait、dead mode、rx/tx、bfd、ttl、DSCP、密码、neighbors 全部输出 | P1 |
| OSPF-REN-012 | Virtual Link | 虚链路及其认证、时间和密码选项生成可解析配置 | P1 |
| OSPF-REN-013 | 互不污染 | n1 的配置预览只包含 n1 的 OSPF 段；切换 n2 后预览立即变化，不显示 n1 的策略或接口 | P0 |
| OSPF-REN-014 | 复杂组合 | v2-only、v3-only、双栈、无链路、有 Area 无链路、多个域同时存在均可解析 | P0 |

## 5. L1 API 与部署事务用例

### 5.1 HTTP 契约

| ID | 请求 | 预期 |
| --- | --- | --- |
| OSPF-API-001 | `GET /api/ospf`，空库存 | 200，domains/layout/inventory 结构完整 |
| OSPF-API-002 | `POST /api/ospf` | 只创建一个域，返回 domain、inventory、deployment、events |
| OSPF-API-003 | `PUT /api/ospf/:id` | 只更新目标域；其它 OSPF 域、BGP、资源不变 |
| OSPF-API-004 | `POST /api/ospf/preview` | 只预检不持久化、不切换远端活动配置；返回每节点 config 和 validation |
| OSPF-API-005 | `PATCH /api/ospf/layout` | 只改全局布局，不触发远端 BIRD 应用；过滤未知节点 |
| OSPF-API-006 | `PATCH /api/ospf/:id/layout` | 只改目标域布局，增量合并，不删除其它节点坐标 |
| OSPF-API-007 | `GET /api/ospf/:id/runtime` | 按域节点返回 v2/v3 状态、邻居详情、路由详情；单节点失败仍返回其它节点 |
| OSPF-API-008 | 非法 JSON/ID/域不存在 | 400/404，错误可读，库存 revision 不变 |

### 5.2 事务、并发与故障注入

| ID | 故障注入 | 预期 |
| --- | --- | --- |
| OSPF-TXN-001 | 4 个客户端同时 PUT 同一域 | 不向用户暴露可恢复的 `STATE_CONFLICT`；服务按最新库存重试，最终成功或返回明确的最终失败 |
| OSPF-TXN-002 | 远端应用耗时期间并发 GET dashboard/runtime/interfaces | GET 不写库存、不推进 revision；部署最终 CAS 成功 |
| OSPF-TXN-003 | 拖动布局与域保存同时发生 | 布局增量合并，域配置不丢；不得出现 revision 冲突 |
| OSPF-TXN-004 | 第一个节点预检失败 | 不应用任何节点，不改变库存，返回失败节点和 BIRD stderr |
| OSPF-TXN-005 | 第二个节点应用失败 | 已应用节点全部回滚；库存保持旧版本；恢复日志清理成功 |
| OSPF-TXN-006 | 库存提交第一次 CAS 冲突 | 远端回滚后重新读取、重新预检、重新应用；最多 3 次，测试日志为 warning 而非 error 风暴 |
| OSPF-TXN-007 | 连续 3 次 CAS 冲突 | 返回可识别错误，恢复日志可恢复，控制器仍可 GET/操作其它节点 |
| OSPF-TXN-008 | Agent 超时/断线 | 当前节点状态明确为失败或未知，不阻塞其它节点和后续健康检查 |
| OSPF-TXN-009 | 重复点击保存/预检 | 同一页面只允许一个动作；不会生成重复部署或重复域 |
| OSPF-TXN-010 | 多个 OSPF 域 | 更新域 A 不触碰域 B 的配置、协议名、邻居和节点策略 |

### 5.3 多配置保存专项回归（P0）

以下用例必须在每次发布前执行，不能用“接口返回 200”替代一致性检查。每个用例至少重复 20 轮，并同时覆盖 MemoryDatabase 和 MySQL。

| ID | 并发参与者 | 注入时机 | 详细步骤 | 通过条件与证据 |
| --- | --- | --- | --- | --- |
| OSPF-CONC-001 | A、B 同一域不同节点参数 | 两次 PUT 同时发出 | A 修改 n1 策略，B 修改 n2 cost，同时保存 | 至少一次成功；若重试，响应不含 `STATE_CONFLICT`；最终域同时保留双方修改或按明确的最后写入规则落盘；抓取两次响应、最终库存和 revision |
| OSPF-CONC-002 | A、B 两个不同 OSPF 域 | 远端预检进行中 | 同时保存域 A、域 B | 两域均可完成或一方得到“部署进行中”提示；不得互相覆盖、重复协议或留下活动 journal；记录域 ID、节点配置 SHA256 |
| OSPF-CONC-003 | 保存 PUT、布局 PATCH | PUT 应用前 | A 保存域配置，B 连续拖动 3 个节点并 PATCH | 配置和布局都保留；布局 PATCH 不触发远端应用；revision 单调递增且无冲突风暴 |
| OSPF-CONC-004 | 保存 PUT、资源编辑 PUT | 节点逐个应用之间 | A 保存 OSPF，B 修改被 OSPF 策略引用的 Function/Filter | 服务重新读取并校验依赖；最终配置中引用版本唯一；失败时所有已应用节点回滚 |
| OSPF-CONC-005 | 三个保存客户端 | 第一次 CAS 提交前 | A/B/C 连续修改同一域并发提交，模拟三次 revision 变化 | 服务按上限重试；最终失败必须是可读业务错误且控制器仍能 `GET /api/health`、读取域和保存其它域 |
| OSPF-CONC-006 | 保存 PUT、后台轮询 | 远端应用持续 5 秒 | 保存期间每 100ms 请求 dashboard、runtime、interfaces | 轮询完全只读，不推进 revision，不产生部署任务；保存一次完成，事件日志无重复“检查通过” |
| OSPF-CONC-007 | 应用成功、提交响应丢失 | CAS 已提交后断开连接 | 让数据库写入成功但 HTTP 响应超时，再重试同一请求 | 服务确认 durable state，不重复回滚已成功配置；重试为幂等操作，库存和远端配置只有一个版本 |
| OSPF-CONC-008 | 第二节点应用失败 | 第一节点已成功应用 | 注入第二节点 `bird -p` 或 `configure` 失败 | 第一节点恢复旧配置，第二节点无半成品；库存 revision 不变，journal 清理或可恢复，下一次保存可成功 |
| OSPF-CONC-009 | 预检失败与并发保存 | 预检阶段 | A 提交非法接口，B 同时提交合法修改 | A 不写库存、不应用任何节点；B 不被锁死且可成功；错误字段和节点明确 |
| OSPF-CONC-010 | 重启恢复 | journal 标记 rollback/forward 后重启控制器 | 在保存中止进程，重启后观察恢复，再发起新保存 | 恢复只执行一次；journal 清空；新保存不返回 `STATE_CONFLICT`，节点活动配置与库存一致 |

每轮测试结束后执行以下一致性检查：

```sh
# 控制器
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/ospf

# 每个隔离节点（按实际 socket 替换）
birdc -s /run/bird/bird.ctl show protocols all
birdc -s /run/bird/bird.ctl show ospf state
sha256sum /etc/birdbox/generated.conf /etc/birdbox/resources/*.conf
```

应保存响应体、HTTP 状态、`deployment_journal`、库存 revision、事件日志和节点命令 stderr；缺少任一证据时用例只能标记为“未完成”，不能标记通过。

## 6. L2 Playwright 界面用例

每个用例运行 desktop 和 Pixel 7 两个项目；监听 `pageerror`，结束时必须为空。

### 6.1 初始化和画布

| ID | 步骤 | 断言 |
| --- | --- | --- |
| OSPF-UI-001 | 空节点打开 OSPF 管理 | 无线段、无幽灵节点、无异常红色错误块；空状态可操作 |
| OSPF-UI-002 | 4 节点打开画布 | 初始节点位于画布中心区域，所有节点可见；名称不截断、不重叠 |
| OSPF-UI-003 | 拖动节点后松开 | 只发一次布局 PATCH；页面不刷新、不重新选择节点、不旋转节点；刷新后坐标保持 |
| OSPF-UI-004 | 拖动后重置 | 重置按钮立即恢复默认布局并保存；不触发域部署 |
| OSPF-UI-005 | 滚轮、放大、缩小、重置视口 | 缩放后可在大画布内平移；节点不会越界消失；cost 标签不拉伸、不偏移 |
| OSPF-UI-006 | 多条平行线 | 线段分离、端点接近节点中心、cost 固定且标签尺寸稳定 |

### 6.2 编辑链路与节点

| ID | 步骤 | 断言 |
| --- | --- | --- |
| OSPF-UI-007 | 打开添加链路 | 本端接口下拉只列本端接口，对端只列对端接口；无接口时可手工填写 |
| OSPF-UI-008 | 切换本端节点 | 本端接口选择清空并重新加载；对端接口列表不混入本端接口 |
| OSPF-UI-009 | 选择相同节点 | 自动换成另一个节点或显示明确错误；不能创建自环 |
| OSPF-UI-010 | 创建链路 | 两端 OSPF 自动启用；cost 默认值正确；策略和已有高级参数不被清空 |
| OSPF-UI-011 | 点击线段 | 只显示该线段的双方接口和参数；编辑 cost 会同步同节点对平行链路 |
| OSPF-UI-012 | 切换节点 | n1/n2 的 import/export Function、Filter、Define 动作完全独立；切换回来值不改变 |
| OSPF-UI-013 | 表单错误 | 字段有 `aria-invalid` 或错误样式；错误信息明确指出节点、链路和字段 |
| OSPF-UI-014 | 编辑表单时查看预览 | 每次输入后预览实时更新；预览只显示当前节点；全屏预览内容一致 |
| OSPF-UI-015 | 高级选项 | 展开/收起不改变已填值；数值非法时阻止保存并定位字段 |

### 6.3 保存、预检与运行详情

| ID | 步骤 | 断言 |
| --- | --- | --- |
| OSPF-UI-016 | 点击预检 | 页面出现置顶遮罩和“正在预检”提示；期间禁止重复提交；完成后显示成功或具体 stderr |
| OSPF-UI-017 | 点击保存并应用 | 页面出现置顶等待框；成功 toast、按钮恢复、最新域和状态自动刷新 |
| OSPF-UI-018 | 模拟节点失败 | 只标记失败节点；其它节点/页面仍可操作；不显示笼统控制器异常 |
| OSPF-UI-019 | 点击邻居数量 | 弹窗展示 v2/v3、Router ID、状态、接口、地址、Dead；无详情时明确说明数据不可用 |
| OSPF-UI-020 | 点击 OSPF 路由 | 弹窗展示 IPv4/IPv6 路由、来源、下一跳、截断提示 |
| OSPF-UI-021 | 点击 Area | 弹窗展示 Area、链路、cost、hello/dead、类型及高级属性 |
| OSPF-UI-022 | 路径查询 | 默认当前节点；可切换开始节点；IPv4/IPv6 均可查；经过节点高亮、其余节点低亮、箭头方向正确；窗口可缩放和平移但节点不可移动 |

## 7. L3 实机拓扑与路由用例

实机测试前保存每台机器的 BIRD 主配置、Include、Agent 服务和 `ip addr/route/rule` 快照。所有测试地址使用 `198.18.0.0/24` 和 `2001:db8:198:18::/64`，禁止覆盖生产前缀。

| ID | 场景 | 操作 | 通过条件 |
| --- | --- | --- | --- |
| OSPF-LAB-001 | 单链路 v2 PTP | 面板创建 n1-n2，保存并应用 | 双方 Full/PtP，双方学到对端测试 /32 |
| OSPF-LAB-002 | 单链路 v3 PTP | 仅启用 v3 | v3 Full/PtP，IPv6 路由可达，v2 未启动 |
| OSPF-LAB-003 | 双栈链路 | v2/v3 同时启用 | 两套邻居独立 Full，路由数量和详情分别正确 |
| OSPF-LAB-004 | 三角形收敛 | n1-n2-n3-n1，三个 /32 | 三台均有 2 个邻居；关闭一条边后仍可经另一方向到达 |
| OSPF-LAB-005 | Cost 选路 | 两条 n1-n3 路径设置不同 cost | BIRD 选择低 cost；修改任一平行链路 cost 后路径重新选择 |
| OSPF-LAB-006 | 路由撤销 | 移除 n3 测试 /32 或删除链路 | 其它节点在 dead/convergence 后撤销路由，界面详情同步 |
| OSPF-LAB-007 | 全互联 | 四节点全互联 | 邻居数量、路由数量、拓扑线段和接口一一对应，无重复协议 |
| OSPF-LAB-008 | 多 Area | Area 0 与 Area 1，配置 networks/external/stubnet | Area 信息正确，跨 Area 路由可按设计传播 |
| OSPF-LAB-009 | Virtual Link | 非骨干 Area 配置虚链路 | 虚链路建立；非法 Backbone 传输 Area 被预检拒绝 |
| OSPF-LAB-010 | 认证 | 两端配置一致/不一致的 md5 或 cryptographic | 一致时 Full，不一致时明确 Down/认证错误，不得误报成功 |
| OSPF-LAB-011 | BFD | 开启 BFD，断开接口 | 邻居快速 Down，恢复后自动 Full |
| OSPF-LAB-012 | Agent 重启 | 重启单节点 Agent/BIRD | 其它节点和控制器仍可访问；节点恢复后状态自动更新 |
| OSPF-LAB-013 | OpenWrt | 使用 OpenWrt Agent 执行 v2/v3 | 安装、接口发现、预检、应用和回滚全部成功；不依赖 GNU `stat` 等非必备命令 |
| OSPF-LAB-014 | SSH 兼容 | 使用旧 SSH 节点 n4 | 配置可下发；单 SSH 节点失败不阻塞 Agent 节点操作 |
| OSPF-LAB-015 | 回滚 | 人为注入一个节点 `bird -p` 失败 | 所有已应用节点恢复旧配置；库存、运行状态和恢复日志一致 |

## 8. 性能、安全与持久化

- 20 节点、100 条链路、v2/v3 双栈下，预览响应、画布渲染和运行详情不得阻塞浏览器；页面长任务必须有等待状态。
- 运行态轮询不能创建部署任务，不能修改库存，不能让队列无限增长。
- 所有 ID、接口、Area、前缀和策略引用均进行服务端校验；不能通过 UI 或 API 注入 BIRD 语句。
- 保存后重启控制器、切换浏览器会话、使用第二个登录会话读取，配置和布局必须一致。
- MySQL revision 在并发读写下单调递增；任何失败写入不得产生半份 JSON 或半套远端配置。
- 记录关键变更、失败节点和回滚结果；普通状态检查不得刷屏式记录“候选配置检查通过”。

## 9. 自动化落地清单

现有代码对应关系：

- `test/ospf.test.js`：补齐 OSPF-VAL、OSPF-REN、运行态解析单元用例。
- `test/deployment-service.test.js`、`test/store.test.js`：保留 CAS 冲突、只读读取和回滚用例。
- `test/e2e/ospf-workspace.spec.ts`：新增 UI 用例，使用 API route fixture 注入四节点、策略资源、邻居和路由详情。
- `test/server-resource.test.js`：新增 OSPF API 合约、预检不持久化、单节点失败和布局并发用例。
- 实机脚本只负责创建隔离 GRE/Agent 测试环境和快照，不得自动修改生产配置；每次测试结束恢复快照并验证 BIRD Include 指向。

## 10. 发布前执行顺序

1. 运行 L0/L1：`npm test`。
2. 运行构建和类型检查：`npm run build`。
3. 运行 L2：`npm run test:e2e -- --project=desktop` 与 `--project=mobile`。
4. 在隔离节点完成 OSPF-LAB-001 至 OSPF-LAB-015，保存 BIRD 配置、邻居和路由输出。
5. 重复执行 OSPF-TXN-001 至 OSPF-TXN-010，确认无 `STATE_CONFLICT` P0、无页面锁死、无远端残留配置。
6. 检查 git diff、测试报告、截图和恢复快照后才允许发布。
