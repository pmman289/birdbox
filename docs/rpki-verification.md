# RPKI 管理验收

新建默认当前节点及双栈 RTR，按来源、连接参数、折叠高级选项组织编辑。IPv4/IPv6 可独立启用；来源、传输及地址族切换保留未提交字段，TCP 与 SSH 分别记忆端口。已有 MD5 和 SSH 路径使用掩码，服务端保留原值；资源已删除后恢复新草稿必须重新填写凭据。

先预检完整节点配置及 Include，查看逐节点配置差异、引用和错误，再明确确认应用。预检无写入，绑定 revision、候选哈希和五分钟凭证。应用重新预检并复用部署锁、CAS、journal 和回滚；节点范围变化检查新旧范围并集。错误、冲突及过期响应均保留本地草稿。

独立运行态抽屉分节点展示真实协议头状态、RTR Status、ROA Channel 状态和条目数量。已有 ROA 数量不能代表 RTR 连接正常。文件来源显示实际 Static 协议实例状态。ROA 查询由服务端解析已保存的表和节点范围，支持 IPv4/IPv6、前缀/ASN 本地筛选、AS0、原始详情和 200 条截断提示。

## 接口

- `GET /api/rpki/editor-context?id=...`：库存版本、当前资源及直接符号引用。资源删除后返回 `resource: null`。
- `POST /api/rpki/preview`：候选及可选 id、inventoryRevision；返回规范化资源、previewId、candidateHash、节点配置、差异及检查结果。
- 原 POST/PUT 接受 `mode: "apply"` 及预检凭证；DELETE 接受 inventoryRevision。旧客户端仍经过完整服务端预检。
- `GET /api/rpki/:id/runtime`：节点和实际协议实例状态、检查时间和独立错误。
- `GET /api/rpki/:id/roas?nodeId=...&family=ipv4|ipv6`：受控查询已保存表；客户端不能指定任意命令或表。

## 已执行验证（2026-10-19）

- 构建和前后端类型检查通过。Node 24 全量测试 292 项：291 通过，1 项因无 MySQL 环境跳过。
- `test/rpki-api.test.js` 六项通过：真实 HTTP、模拟 RPC，覆盖无写入预检、候选一致性、凭据脱敏和恢复、作用域并集、逐节点失败、回滚/锁释放、CAS、依赖保护、运行态错误及表查询约束。
- `test/rpki-native.test.js` 通过：隔离宿主 BIRD 2.17.5，真实 RTR v1 TCP、IPv4/IPv6 ROA、文件加载、roa_check VALID/INVALID/UNKNOWN、maxLength、串行撤回及连接 Established 时条目归零。
- Go `test ./...` 和 `vet ./...` 通过。
- Debian 12 隔离 Docker 网络中，BIRD 2.17.5 / 2.19.0 两版真实 HTTP → 安装后的 Go Agent → BIRD 验证通过：双栈 RTR 公告与串行撤回、文件来源、真实状态/ROA 解析、依赖、CAS、原生预检失败、启停、重启用和删除清理。
- 桌面/移动端 RPKI 与共享资源编辑器 22 项通过；真实 HTTP 浏览器完整流程另 2 项通过。真实 HTTP 浏览器使用模拟 Agent，真实 Agent/BIRD 由上述 Docker 脚本独立覆盖。
- 补充修复共享节点选择器移动端搜索框高度及复选框排列，加入几何断言。验收 demo 提供正常 RTR、连接异常但有旧 ROA、文件来源及停用数据。

## 复现和边界

```bash
npm run build
npm test
BIRDBOX_E2E_PORT=31012 npx playwright test test/e2e/rpki-management.spec.ts test/e2e/resource-editors.spec.ts
BIRDBOX_STATIC_URL=http://127.0.0.1:31011 npx playwright test --config playwright.static.config.ts test/live/rpki-live.spec.ts
BIRD_VERSION=2.17.5 bash scripts/rpki-e2e.sh
BIRD_VERSION=2.19.0 bash scripts/rpki-e2e.sh
```

真实 RTR 测试覆盖 v1 TCP；TCP-MD5 与 SSH 的字段、密钥保留及候选校验由 API 测试覆盖，未实测相应认证连接建立。未修改生产节点或宿主路由。当前环境无 birdcc，生成语法使用对应版本原生 BIRD 校验。
