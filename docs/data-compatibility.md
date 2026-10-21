# 数据兼容与迁移

Birdbox 的迁移必须原位兼容现有用户数据。禁止要求用户清空 MySQL、删除数据卷或手工重建资源。

## 当前格式

| 数据 | 权威位置 | 当前版本 | 兼容入口 |
| --- | --- | ---: | --- |
| 库存 | MySQL `birdbox_state:inventory` | 31 | `InventoryStore` |
| 认证 | MySQL `birdbox_state:auth` | 2 | `AuthStore` |
| 数据库结构 | `birdbox_schema_migrations` | 1 | `MySqlDatabase` |
| 部署恢复日志 | MySQL `birdbox_state:deployment_journal` | 1 | deployment service |
| 旧库存文件 | `/var/lib/birdbox/inventory.json` | 多版本 | 首次数据库初始化 |
| 旧认证文件 | `/var/lib/birdbox/auth.json` | 1/2 | 一次性导入标记 |

## 必须保持的兼容性

- 库存版本 2、8、10、14、18、19、20、22、23、25、26、27、28、29 和 30 必须可升级到当前版本。
- v18 及更早的 Session Static 配置必须迁移为节点级 Static 资源。
- 旧 prefix list、Define 顺序、Function 顺序、组合策略和导出策略引用必须保留。
- 认证 v1 的有效 token 在数据库内升级时保持有效；从旧 JSON 导入时必须主动失效，避免复制文件后复用登录。
- 已存在的多会话认证、密码 hash 参数和会话来源信息必须保留。
- 已存在的 SSH 私钥和 `known_hosts` 必须原样沿用，不得静默生成新身份或重新信任主机。
- 高于当前程序支持版本的数据必须拒绝写入，不能尝试降级规范化。
- v31 允许 Define 的默认及逐网段转发动作使用结构化设置，与直接路由共用下一跳、ECMP、递归、BFD、Onlink 和启停校验。旧字符串动作保持兼容；旧版程序应拒绝回写 v31 库存。
- v29 及更早的 Static 保留 Define、逐 CIDR 动作、属性、自定义指令和启停状态，补默认 master4/master6 表、空直接路由、checkLink=false、默认 IGP 表及兼容的 Import 策略；升级不主动部署。
- v28 及更早库存缺少 `pipeProtocols` 时补空数组，不从源地址出口映射内部 Pipe 反向创建管理资源，也不因迁移主动部署。
- Direct/Kernel 兼容特别规则：历史 `ManagedNode.directProtocol` 与 `ManagedNode.kernelProtocol` 仅保留用于读取旧表单和识别历史数据，绝不能在迁移、启动、Dashboard 读取或配置渲染时隐式转换为 `directProtocols`/`kernelProtocols` 资源。缺少资源数组等价于空数组；仅当数组中已有显式资源时才继续渲染和部署。该规则用于防止升级后每节点凭空出现协议、名称冲突和路由故障。
- 已保存 Kernel 资源若缺少 `importPolicy`/`exportPolicy`，迁移时固定为历史通用 Channel 默认值 `all`/`none`。新建 Kernel 的默认值 `none`/`all` 只用于显式创建；不能反向改变存量资源。已有策略、分地址族设置、作用域及停用状态须保留。
- 所有候选库存规范化，以及数据库/旧 JSON 的迁移，必须检查 Direct、Kernel、Pipe 的资源 ID 集合。若规范化或迁移隐式增删资源，返回 `INVENTORY_PROTOCOL_SET_CHANGED`，在库存写入和部署候选使用之前终止。用户显式创建、编辑、删除时以候选输入中的资源集合为准。

## 升级函数规则

1. 升级函数接收 `unknown`，先检查源版本，再逐版本转换。
2. 每一步只负责一个版本差异，结果必须可重复执行。
3. 不修改输入对象；返回新对象并在最后执行当前版本完整规范化。
4. 不删除无法识别的数据后继续运行；不兼容时应停止并给出稳定错误码。
5. 数据库写回使用 revision/CAS。并发冲突时重新读取并重新升级，不能覆盖新数据。
6. 只有当前库存完整验证通过后才能写回；远端部署失败不得提交候选库存。
7. 迁移不得主动连接或修改远端节点，除非该版本明确需要一次受控部署并提供恢复日志。

## Fixture 和回归

历史 fixture 不包含真实密码、路由凭据、IP 资产或 SSH 密钥。每个支持版本至少有一个 fixture，测试必须验证：

- 输出版本和完整规范化结果。
- 资源 ID、BIRD symbol、节点归属和引用关系。
- Session 的地址族、策略、高级参数和启停状态。
- Static 的逐 CIDR 动作及 per-route 块。
- 第二次读取不再产生写入，证明升级幂等。
- 新版本数据会被明确拒绝。

迁移代码删除前，必须先发布一个明确停止支持旧版本的版本，并在 README、发布说明和升级文档中给出跨版本升级路径。

## 2026-10-19 存量节点安全专项

`test/upgrade-safety.test.js` 随 `npm test` 执行，覆盖 v2/8/10/14/18/19/20/22/23/25/26/27/28/29/30/31：集合缺失/显式为空、旧节点协议字段开启、重复读取和重启、JSON/节点文件导入、Dashboard 与编辑器上下文读取、Static 预检无写入、仅显式应用目标节点、旧 Kernel 缺省策略及停用状态。另有运行时资源集合保护和真实 MySQL 升级/重启测试；MySQL 项需提供 `BIRDBOX_TEST_MYSQL_URL`。

验收使用临时 MySQL 8.4.11，未连接生产数据库或部署真实节点。专项 42 项与全量 368 项均通过，无跳过；前后端类型检查和构建通过。以修改前 v28 代码为基线，对比四组配置的协议声明（集合缺失、为空、已有显式资源、已有 Kernel 缺省策略），声明集合保持一致；生成配置在隔离 BIRD 2.17.5 / 2.19.0 容器中通过 `bird -p`，没有启动或重载 BIRD。当前环境未安装 `birdcc`，未执行其 lint。

Demo 的 Direct/Kernel 示例仅由显式启动的 `scripts/static-demo.ts` 注入模拟内存库存；生产入口 `src/server.ts` 不导入该脚本。旧版 Session 内 Static 拆为节点资源的兼容迁移继续保留，不视为无来源的新路由。启动后的 IRR 定时刷新和未完成部署 journal 恢复针对已有资源/事务，不得作为补建默认协议的入口。

## 发布前数据演练

2026-10-19 补充：存量 eBGP/iBGP/OSPF 的公开 API 保存往返、各节点 Area 参数、MySQL 重启幂等及提交响应丢失实测见 [流程与旧数据验收](bgp-ospf-flow-verification.md)。库存比较按 JSON 持久化语义处理未设置的可选字段，不能因 MySQL 省略 `undefined` 而重复递增 revision。

发布镜像必须在临时 MySQL 和临时数据卷中完成以下演练：旧 fixture 启动、自动升级、登录、读取 dashboard、执行无变更预检、重启、再次读取并比较库存。随后用高版本 fixture 验证服务拒绝启动且原数据未变化。

生产升级前仍需同时备份 MySQL 和 `/var/lib/birdbox`；仅备份一侧不足以恢复部署日志与 SSH 身份的一致状态。
