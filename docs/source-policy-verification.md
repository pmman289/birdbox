# 源地址出口管理与恢复验收

## 配置流程

编辑器维护独立草稿，显示节点范围、出口组、内部 Define 引用及未保存状态。先执行“预检并查看变更”，核对完整候选配置和节点结果，再明确“确认应用”。候选绑定库存 revision、资源及配置哈希；修改草稿或库存变化使候选失效。预检不写库存，也不修改内核规则。

创建、编辑、启停和删除沿用部署锁、CAS、journal 与回滚。节点失败保留草稿和其它节点结果。读取最新版本后可比较远端配置；保留本地内容时以最新远端资源作为保存基线，旧内容仍正确标记为未保存。出口组 ID、Linux 表及规则槽在编辑中保持稳定。

## Agent 持久化

默认恢复文件为 `/etc/birdbox/source-policy-rules.json`，权限为 0600，使用原子写入与 fsync。文件保留最后一次本地成功提交的规则；修改内核前记录清理集合。失败回滚仍无法完成时保留清理记录，供下次启动恢复。停用、删除后也保存空快照，避免重启重新安装旧规则。

Agent 在向控制器注册前恢复已提交规则；恢复失败时继续提供连接并每 30 秒重试。节点 ID、版本、完整 JSON 和规则均在执行命令前校验。删除时匹配实际受管规则，发现同优先级的非受管选择器时拒绝操作。优先使用 JSON `ip` 输出，并为 BusyBox 的规则及路由提供文本解析回退。

## 只读运行态

- `GET /api/source-policies/:resourceId/runtime`：按节点、出口组返回实际 Static、Kernel、内部 Pipe 状态，系统规则匹配情况、恢复文件状态及 Linux 表路由。节点和出口组错误分别保留，不以协议 Up 推断路由已安装。
- `GET /api/source-policies/:resourceId/routes?nodeId=...&groupId=...&target=...`：从已保存出口组解析 BIRD 策略表，支持目标 IPv4 查询，最多显示 200 条。
- Agent 的 `network.ip_rules.inspect` 是独立只读 RPC，只接受受限数字表及优先级选择器；读取 Linux 实际状态，不修改规则或恢复文件。旧 Agent 不支持此 RPC 时提示升级，仍保留 BIRD 检查结果。
- 本机就是出口时明确显示跳过；仍被其它映射使用的共享网关例外不误报为残留。SSH/local 使用 JSON `ip` 命令，缺少能力时显示错误。

列表和编辑器均可打开运行态抽屉。Linux 已安装路由与 BIRD 策略表路由单独显示；切换节点、出口组、视图或查询目标会取消并丢弃旧响应。只读请求不替换配置草稿。

## 实际验证（2026-10-19）

- `test/source-policy-api.test.js`：6 项通过。包含只读预检、候选绑定、CAS、范围变更、启停删除、预检失败、回滚、运行态节点错误隔离、共享规则、本机出口及非法查询。
- `test/e2e/source-policy-management.spec.ts` 与共享编辑器：桌面/移动端共 34 项通过，覆盖明确确认、失败保留草稿、冲突恢复、过期响应、嵌套运行态及 375/390/430px 操作栏和溢出检查。
- `test/live/source-policy-live.spec.ts`：桌面/移动端 2 项真实 HTTP 生命周期验证已通过；远端使用模拟 Agent。新增运行态由上述浏览器 fixture 和下述原生 API 测试分别验证。
- `go test -race ./...`、`go vet ./...` 通过。Go 测试覆盖持久化、恢复、空快照、回滚失败日志、重试、非受管规则保护、损坏文件及 BusyBox 文本规则/多下一跳路由解析。
- 全量 Node 24 单元/API 测试：310 项，309 通过，1 项因未配置 MySQL 跳过。前后端类型检查及构建通过。

`scripts/source-policy-e2e.sh` 在 Debian 12 隔离 Docker 节点安装当前 Go Agent，分别使用 BIRD 2.17.5 / 2.19.0，均通过以下真实流程：

1. 管理 API 创建、预检、确认应用、编辑、停用、启用和删除；验证库存、冻结候选及规则编号。
2. BIRD 策略默认路由、内部 Define 通过生成的 Pipe 复制，Linux 策略表路由和源/网关例外规则符合配置；实际 `ip route get` 选择预期表和网关。
3. 运行态 HTTP 返回真实协议、恢复文件、规则及 Linux 路由，BIRD 目标查询成功；只读检查不写库存。
4. 每次生命周期操作后停止 Agent、清空持久化规则对应的内核状态、断开控制器网络，再启动 Agent；核对规则恢复，或停用/删除后继续不存在，随后重新连接控制器。

复现：

```bash
BIRD_VERSION=2.17.5 bash scripts/source-policy-e2e.sh
BIRD_VERSION=2.19.0 bash scripts/source-policy-e2e.sh
```

原生实测传输方式为 Agent RPC。没有修改宿主机或生产节点路由；未宣称物理设备断电恢复、实际 OpenWrt、SSH 原生部署或端到端数据包交付已经验证。BusyBox 回退由 Go 单元测试覆盖，原生 Debian 实测使用 JSON 路径。
