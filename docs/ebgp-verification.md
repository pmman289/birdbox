# eBGP 编辑与部署验收

## 修复与交互

- 草稿与已保存快照分别维护。预检通过仍显示“有未应用修改”；手动刷新和后台运行态刷新保留草稿。
- 切换节点、远端、离开 eBGP 工作区、退出登录或关闭页面时保护未应用内容；应用期间禁止切换上下文。
- 独立的 Import、Export 和路由数量限制以摘要开始，按需展开，双栈及两个方向的配置分别保留。无效隐藏字段会展开并定位；高级 BGP/Channel 配置继续保留。
- 预检使用完整节点配置包，包括动态 IRR Include。每次预检开始使旧结果失效；过期响应不能覆盖当前节点、远端或草稿。
- 应用要求当前草稿预检有效，再展示明确确认；候选绑定库存 revision、哈希和五分钟凭证。服务端应用仍重新预检，沿用部署锁、CAS、journal 与回滚。配置差异保留行顺序与重复语句，输出有长度上限。
- 预检、部署、读取编辑版本失败均保留草稿。读取版本可重试；冲突可比较最新与本地摘要，采用最新或明确保留草稿后重新预检。比较区不展示认证字段。
- 应用响应丢失时读取服务端状态确认结果，不重复提交。保存快照去掉管理元信息，避免结果对比误判。
- 配置停用时协议详情直接解释停用状态；无需远端 RPC，也不再把已移除协议的 BIRD 符号语法错误显示给用户。Agent 与 SSH/local 的协议查询使用字符串名称选择器。

## 接口

`GET /api/sessions/editor-context?nodeId=...&peerId=...` 返回库存 revision 和当前会话；校验节点归属和 eBGP 管理范围。

`POST /api/sessions/preview` 接受可选 inventoryRevision，返回规范化会话、配置、差异、预检结果、previewId、candidateHash 和库存版本。预检不写库存或更新活动配置。

`POST /api/sessions/apply` 使用 `mode: "apply"`、previewId、candidateHash 和 inventoryRevision 绑定候选；原客户端仍可使用完整服务端预检流程。DELETE 接受可选库存版本。冲突返回 `STATE_CONFLICT`，预检过期或候选变化返回 `SESSION_PREVIEW_STALE`。

## 实际验证（2026-10-19）

- 构建及前后端类型检查通过；Node 24 全量测试 296 项，295 通过，1 项 MySQL 环境测试跳过。
- `test/ebgp-api.test.js`：真实 HTTP、库存和部署服务、模拟 Agent，验证无写入预检、候选与保存配置一致、双栈独立策略、启停删除、凭据脱敏与新凭据恢复、旧 revision/篡改凭证拒绝、完整 IRR Include、预检失败、回滚与锁释放。
- `test/config-diff.test.js`：策略顺序、重复语句及输出截断；原部署生命周期和会话 RPC 回归通过。
- eBGP 与认证壳桌面/移动 10 项通过；应用响应丢失后自动确认结果另 2 项通过。
- `test/live/ebgp-live.spec.ts` 桌面/移动真实 HTTP 两项通过：从 Peer 创建开始，创建会话、只读预检、确认应用、刷新/编辑、真实 API 协议/路由抽屉、双栈切换、启停、移除会话和删除 Peer。该组使用模拟 Agent。
- `scripts/ebgp-e2e.sh` 在 Debian 12 私有 Docker 网络和独立网络命名空间中，通过真实安装的 Go Agent，分别在 BIRD 2.17.5 / 2.19.0 验证：双栈邻居 Established、实际 IPv4/IPv6 路由接收、IPv4 Filter 拒绝并撤回、IPv6 继续接收、策略引用保护、原生语法拒绝、CAS、启停/恢复和删除清理。
- Go `test ./...` 和 `vet ./...` 通过。

补充浏览器复核通过：Define、eBGP、认证壳及 iBGP 共 34 项桌面/移动场景；策略折叠、隐藏字段定位、编辑版本失败重试及预览失效补充 6 项通过（其中策略两项与前一组重叠）。预览与已保存配置独立维护，旧预览失效及新预览等待期间不会误显示为已保存配置。策略折叠后的真实 HTTP eBGP 桌面/移动流程另 2 项通过。1440px 与 390px 截图检查无横向溢出，策略及限制默认收起。

## 复现与边界

```bash
npm run build
npm test
BIRDBOX_E2E_PORT=31014 npx playwright test test/e2e/ebgp-management.spec.ts test/e2e/auth-shell.spec.ts
BIRDBOX_STATIC_URL=http://127.0.0.1:31011 npx playwright test --config playwright.static.config.ts test/live/ebgp-live.spec.ts
BIRD_VERSION=2.17.5 bash scripts/ebgp-e2e.sh
BIRD_VERSION=2.19.0 bash scripts/ebgp-e2e.sh
cd agent && go test ./... && go vet ./...
```

原生部署测试覆盖 Agent，未实测 SSH 部署及 TCP-MD5/TCP-AO 握手。没有修改生产节点、宿主路由或公共邻居。验收 demo 提供正常双栈上联和未建立的备用上联；其状态与部署均由模拟 Agent 提供。
