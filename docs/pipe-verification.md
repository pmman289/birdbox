# Pipe 管理验收记录

验收日期：2026-10-18 至 2026-10-19（Asia/Hong_Kong）。库存版本升级为 29，应用版本未改动。

## 实现范围

资源管理新增 Pipe 页签，可新增、编辑、启停、删除、服务端预检和保存应用。支持 IPv4/IPv6、多节点、已有或管理路由表、独立 Import/Export 策略、Function 组合和自定义 Filter。运行态独立查看协议状态及两侧路由，支持目标 IP 查询、200 条截断提示和节点错误隔离。保留源地址出口映射内部 Pipe 的独立管理方式。

管理表按节点与名称去重，停用资源仍保留声明；最后一个管理引用移除时，完整候选配置预检保护其它依赖。修改节点范围部署到新旧节点并集，节点删除同步清理 Pipe 范围。所有写入沿用现有部署锁、CAS、journal 与回滚机制。

## 真实 BIRD 与传输方式

| 环境 | 实际验证传输 | 结果 |
| --- | --- | --- |
| Linux 宿主机，BIRD 2.17.5 | local → 私有 birdc Socket | IPv4/IPv6、单向、双向、Filter、属性和来源保留通过 |
| Debian 12 Docker，Node 24，BIRD 2.19.0 | local → 私有 birdc Socket | 同上通过 |
| Debian 12 Docker，真实 Go Agent，BIRD 2.17.5 | 浏览器等价 HTTP API → Controller → Agent HTTP RPC → birdc | 预检、库存无写入、保存应用、状态、两侧路由、目标 IP、单向/双向、Filter、属性保留、停用保留表、最后引用删除保护通过 |
| Debian 12 Docker，真实 Go Agent，BIRD 2.19.0 | 同上 | 同上通过 |

原生测试仅启动临时目录与独立 Socket 的私有 BIRD，不使用 Kernel/BGP 协议，不修改宿主机路由。Agent 链路使用隔离 Docker 网络与临时容器，真实 systemd 启动 BIRD 和 Agent，结束后清理容器、网络与凭据。

SSH 沿用现有执行器及等价 birdc 查询，本轮未对 Pipe 进行真实 SSH 链路实测。API 故障、CAS 冲突和回滚测试使用可控的 Agent RPC 故障注入；这些结果不等同于真实网络故障演练。真实 Agent 实测覆盖一个节点，多节点范围和错误隔离由 API 测试验证。

BIRD 2 的 Pipe 实际仅提供 main channel 的 imported/exported 统计；对端没有独立统计时返回 null，页面显示未知。两侧表内路由保持原协议来源（测试中为 static），未按 Pipe 名称筛选伪造传递记录。测试核对 `BGP.local_pref: 177` 与 community `(64512,17)` 的保留。

## 自动化检查与复现

- `npm run build`：服务端编译、Web 类型检查和 Web 构建。
- `npm test`：全量单元/API/事务测试，包含旧库存升级、节点范围、策略依赖、预检无写入、部署失败回滚和 CAS 冲突。
- `cd agent && go test ./... && go vet ./...`：Agent 检查。
- `npx playwright test`：现有桌面/移动工作区回归及 Pipe CRUD、方向独立、失败保留草稿、过期响应保护、运行态、路由详情和 375/390/430px 布局测试。
- `NODE_OPTIONS=--import=tsx node --test test/pipe.test.js`：当前环境的私有 BIRD 原生实测。
- `BIRD_VERSION=2.17.5 scripts/pipe-e2e.sh` / `BIRD_VERSION=2.19.0 scripts/pipe-e2e.sh`：完整真实 Agent 链路实测，需要 Docker，容器权限仅用于真实 systemd。

全量 Node 检查在 Node 24 与 BIRD 2.17.5 的 Docker 环境运行；主机 Node 20 仅用于 Playwright 驱动。测试中既有 MySQL 集成测试在未配置 MySQL 时跳过；OSPF 一小时压力测试按既有默认规则跳过（需要显式 `BIRDBOX_RUN_LONG_E2E=1`）。

自动化结果：Node 24 全量单元/API 测试 239 项通过、1 项 MySQL 测试跳过；全站 Playwright 38 项通过、2 项一小时压力测试按默认规则跳过；最终 Pipe 专项 Playwright 12 项复测通过，覆盖桌面与 375/390/430px 布局、固定操作栏和过期响应保护；服务端/Web 类型检查、构建及 Agent test/vet 通过。


## 最终联动回归（2026-10-19）

Static、Pipe 与资源列表的桌面/移动浏览器共 46 项通过，包含 375/390/430px 布局。当前 Node 24 全量单元/API 共 322 项，321 通过，1 项 MySQL 测试因无专用数据库跳过；前后端类型检查与生产构建通过。

Pipe 在隔离 Debian 12 + BIRD 2.17.5 / 2.19.0 的真实 HTTP→Go Agent→BIRD 原生生命周期分别通过，包含双栈路由、双向策略、属性保留和清理。真实 Agent 为单节点，多节点和失败隔离由 API 故障注入覆盖；未测试真实 SSH。
