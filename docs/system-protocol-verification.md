# Direct / Kernel 管理验收

Direct 与 Kernel 采用服务端完整配置预检，再明确确认应用。预检不修改库存，候选绑定库存 revision、配置哈希及五分钟预检凭证。保存重新预检并复用现有部署锁、CAS、journal 和回滚；失败保留草稿，库存冲突可对比后重新预检。

Direct 提供接口发现和手动回退、双栈、check link。Kernel 区分 BIRD 路由表与 Linux table ID，支持双栈独立 Import/Export、管理表、learn、metric、merge paths、graceful restart 和 persist。高级配置及策略默认折叠，新建默认当前节点。管理表与其它资源按节点去重。

运行态独立显示协议状态、节点错误及路由查询，不覆盖配置草稿。编辑器标题和操作栏固定，375/390/430px 下内容独立滚动。

## 已执行验证（2026-10-19）

- Node 24 全量单元/API 测试通过；包含逐节点预检失败、范围变更、依赖保护、CAS、部署回滚及运行态隔离。
- 专项 Playwright 桌面/移动端 18 项通过。
- 真实 HTTP 浏览器流程 4 项通过：Direct/Kernel 创建、预检、确认、重开编辑、启停、运行态、路由及删除。该组远端使用模拟 Agent。
- `scripts/system-protocol-e2e.sh` 在 Debian 12 的隔离 Docker 网络中，分别通过安装后的 Go Agent 与 BIRD 2.17.5 / 2.19.0 完成真实验证：双栈 Direct 路由、接口关闭后的 check link 撤回、独立导入导出及 Filter、Linux 表内安装/移除、依赖保护、无写入预检、CAS 和最终清理。
- 构建、前后端类型检查、Go test/vet 通过。

真实部署链路为 HTTP → Agent RPC → BIRD，未修改宿主或生产路由；该记录不代表 SSH 传输的端到端部署验收。

## 复现

```bash
npm run build
npm test
BIRDBOX_E2E_PORT=31002 npx playwright test test/e2e/system-protocol-management.spec.ts
BIRDBOX_STATIC_URL=http://127.0.0.1:31011 npx playwright test --config playwright.static.config.ts test/live/system-protocol-live.spec.ts
BIRD_VERSION=2.17.5 bash scripts/system-protocol-e2e.sh
BIRD_VERSION=2.19.0 bash scripts/system-protocol-e2e.sh
```

浏览器真实 HTTP 测试需要使用填充了 demo 数据的隔离实例；Docker 测试自行创建并清理控制器、节点和网络。
