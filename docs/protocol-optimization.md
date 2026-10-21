# 协议优化与验收清单

本轮目标：分析并改善剩余全部现有协议，并分析和补齐现有 BIRD 协议管理中缺失的功能的配置、维护和运行态体验，逐协议验证完整流程及桌面、375/390/430px 布局。已有专项验收不代替本轮回归。

| 范围 | 当前证据 / 问题 | 实施与验证状态 |
| --- | --- | --- |
| Direct | 已改完整候选预检、草稿保护、接口发现与独立运行态 | 已通过 Agent + BIRD 双版本及浏览器流程，见 system-protocol-verification.md |
| Kernel | 已补独立双栈策略、管理表及高级参数、CAS、完整预检和运行态 | 已通过 Agent + BIRD 双版本及浏览器流程，见 system-protocol-verification.md |
| RPKI | 已补完整预检和 CAS、来源切换保留、密钥恢复、运行态及双栈 ROA 查询 | 已通过真实 RTR/文件、Agent + BIRD 双版本及浏览器流程，见 rpki-verification.md |
| eBGP | 已修刷新/预检丢草稿，补候选绑定、CAS、完整 Include、冲突/响应丢失恢复和策略摘要 | Agent + BIRD 双版本、API、真实 HTTP 与桌面/移动浏览器流程通过，见 ebgp-verification.md |
| iBGP | 已补完整候选预检、绑定应用/CAS、双端独立及空域、失败与过期响应保护、连接启停和布局修复 | Agent + BIRD 双版本、API、真实 HTTP 及桌面/移动 10 项通过，见 ibgp-verification.md |
| OSPF | 完整候选/Include、草稿恢复、CAS、布局独立、双端密钥、逐节点失败/回滚、实际协议状态和 Area 统计及移动布局 | API、桌面/移动及两个真实 Agent + BIRD 双版本通过；Area 查询失败独立显示，旧 Agent 明确提示升级，见 ospf-verification.md |
| Device / BFD | 内部生成、接口依赖、按需 BFD 联动；保持内部协议组织方式 | Device 主配置依赖与 Static BFD 已有专项检查；iBGP 两个 BIRD 版本的两端 CLI 确认 BFD Up，见 ibgp-verification.md |
| Function / Filter | 已补候选预检/CAS、完整 Include、直接/间接引用、草稿保护和冲突恢复 | API、桌面/移动真实 HTTP 及 Agent + BIRD 双版本策略联动通过，见 policy-verification.md |
| 源地址出口 | 已补候选绑定、完整预检、草稿/冲突恢复、Agent 规则持久化和独立运行态 | API、桌面/移动 34 项、Agent + BIRD 双版本生命周期及离线启动恢复通过，见 source-policy-verification.md |
| Static / Pipe / Defines | 完整候选、独立策略/转发、草稿/冲突恢复与联动回归；Defines 补分类型草稿和响应丢失核对 | Static/Pipe/列表 46 项及两版真实 Agent + BIRD 通过；Defines 真实 HTTP、双版本原生解析通过，见各专项 verification 文档 |

每项验收须具备：创建→服务端预检→明确确认应用→重开编辑→启停→运行态/路由（适用时）→删除；无写入预检、CAS、失败保留草稿、回滚及清理；桌面与移动布局检查。测试须说明真实 HTTP、模拟 RPC、原生 BIRD 的边界，不能用模拟远端结果宣称实际路由收敛。

本轮针对现有协议管理中缺失的功能；RIP/RIPng、Babel、RAdv 等尚未接入的协议类型作为覆盖差距记录，不作为本轮新增协议范围。Device/BFD 检查项目已有内部协议及联动能力。

## 最终代码复核（2026-10-19）

| 资源 | 服务/API 完整流程与故障保护 | 浏览器交互验证 | 隔离原生验证入口 |
| --- | --- | --- | --- |
| Direct / Kernel | `test/system-protocol-api.test.js` | `system-protocol-management.spec.ts`、`test/live/system-protocol-live.spec.ts` | `scripts/system-protocol-e2e.sh` |
| RPKI | `test/rpki-api.test.js`、`test/rpki-native.test.js` | `rpki-management.spec.ts`、`test/live/rpki-live.spec.ts` | `scripts/rpki-e2e.sh` |
| eBGP | `test/ebgp-api.test.js` | `ebgp-management.spec.ts`、`test/live/ebgp-live.spec.ts` | `scripts/ebgp-e2e.sh` |
| iBGP | `test/ibgp-api.test.js` | `ibgp-management.spec.ts`、`test/live/ibgp-live.spec.ts` | `scripts/ibgp-e2e.sh` |
| OSPF | `test/ospf-api.test.js`、`test/ospf-runtime-details.test.js` | `ospf-review.spec.ts`、`ospf-workspace.spec.ts`、`test/live/ospf-live.spec.ts` | `scripts/ospf-e2e.sh` |
| Define / Function / Filter | `test/define-api.test.js`、`test/policy-api.test.js`、引用与原生解析专项 | `define-management.spec.ts`、`resource-editors.spec.ts`、`test/live/{define,policy}-live.spec.ts` | eBGP 的 Define → Function → Filter 原生策略链及 Define 原生解析 |
| 源地址出口 | `test/source-policy-api.test.js`、Go 恢复与规则检查测试 | `source-policy-management.spec.ts`、`test/live/source-policy-live.spec.ts` | `scripts/source-policy-e2e.sh` |
| Static | `test/static-api.test.js`、`test/static.test.js` | `static-management.spec.ts`、`resource-editors.spec.ts`、`test/live/static.spec.ts` | `scripts/static-e2e.sh` |
| Pipe | `test/pipe-api.test.js`、`test/pipe.test.js` | `pipe-management.spec.ts` | `scripts/pipe-e2e.sh` |
| 资源列表 | `test/resource-list.test.js` | `resource-lists.spec.ts` | 不涉及远端路由变更 |

上表未写完整路径的浏览器文件位于 `test/e2e/`。API 专项核对无写入预检、规范化候选与实际保存一致、范围清理、CAS、失败隔离和回滚；浏览器核对草稿、明确确认、冲突恢复、运行态及窄屏可操作性。原生脚本各自在 BIRD 2.17.5 / 2.19.0 环境通过，具体断言和传输边界见各专项文档。

最终复核追加修复了两处拓扑主流程问题：OSPF 节点 pointer-up 现在经过连接模式处理，不再绕过“点选两个节点”；域数据早于 Dashboard 节点到达时会补做接口发现。新建域也立即取消原域运行态请求并清空状态。真实 HTTP 浏览器流程覆盖自动发现、双端 Priority 独立保存、双栈、草稿重载、预检不写库存、确认应用、Area/邻居/路由、启停和删除。

Define 追加文件导入时分别处理原列表和文件的外层方括号，带长度范围的前缀保持完整；真实 HTTP 浏览器从已有前缀追加文件，再完成预检、应用和整个生命周期。

原生实测主要使用安装后的 Go Agent RPC；Static 另有真实浏览器贯通 Agent/BIRD，Pipe 另有私有 Socket local 路由验证。其余真实 HTTP 浏览器使用模拟 Agent，故障注入覆盖事务边界，不等同于真实设备失联。MySQL、真实 SSH/OpenWrt、MD5/AO 握手、物理断电、一小时压力及 BIRD 3 未纳入本轮通过结论。

最新交叉验证：Define 与共享资源编辑器桌面/移动 38 项通过；OSPF 桌面/移动 26 项通过；当前验收实例的 Define、Function、Filter、eBGP、iBGP、RPKI、源地址出口、Direct、Kernel 真实 HTTP 浏览器 18 项通过，OSPF 真实 HTTP 另 2 项通过。前后端类型检查和生产构建通过，Node 24 全量单元/API 324 项中 323 通过、MySQL 环境专项跳过 1 项。验收 Demo 已保留库存、全局和域布局后重启并加载当前实现。

最终 Define 语义复核补齐单引号 BIRD 符号的引用扫描和依赖保护。对应图/API 测试、桌面/移动引用浏览器 2 项，以及 BIRD 2.17.5 / 2.19.0 原生解析通过。修复后的最新全量单元/API 为 326 项，325 通过，MySQL 环境专项跳过 1 项；前后端类型检查与构建通过。

### 全站浏览器收尾结果

`BIRDBOX_E2E_PORT=31040 npx playwright test` 首轮执行 198 项：179 通过、2 项一小时压力按条件跳过、17 项因有效登录会话耗尽停在登录页。截图明确显示 `AUTH_SESSION_LIMIT` 对应提示，失败发生在进入业务页面之前。排查确认部分旧测试未注销，共补齐 8 个套件的路由清理与真实注销请求，保持现有生产认证语义。

随后以全新测试实例执行 `BIRDBOX_E2E_PORT=31044 npx playwright test --last-failed`，17 项全部通过。该轮为失败项复测，不是第二次完整执行；合计已完成全部 196 个非长时用例的验证。首轮与复测日志分别保留在 `/tmp/birdbox-protocol-final-browser.log`、`/tmp/birdbox-protocol-browser-retry.log`。另有修复后 Define 引用保护 2 项、当前 Demo 的 Define 真实 HTTP 生命周期 2 项通过。`git diff --check` 通过，Demo 健康检查无部署锁或恢复任务。

### eBGP / iBGP / OSPF 体验补充

工作区继续按“连接对象 → 基础配置 → 独立策略 → 预检确认”优化，保留现有协议和升级语义。新增分步定位、iBGP 单端编辑/双端对照、OSPF Inspector 内容隔离与移动返回入口，修复无邻接节点误显旧连接、预检遮罩阻断编辑和短窗口高级项滚动跳跃。完整浏览器 62 项通过、2 项长时压力跳过；真实 HTTP Demo 桌面/手机生命周期 6 项通过，补充交互回归 6 项通过。测试边界和日志见 [体验验收记录](bgp-ospf-ux-verification.md)。
