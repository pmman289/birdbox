# 生产就绪修复 Checklist

本清单对应 `Birdbox_生产就绪审计报告.md`。每次发布前必须重新执行验证命令；“已完成”表示代码已落地并有自动化或构建证据，不表示替代真实节点的灰度验证。

## P0

- [x] **P0-1 部署恢复**：HTTP 先监听，恢复在后台退避重试；恢复期间 `/api/health` 返回 `recovery`，变更接口返回 503，Agent 注册/轮询并完成恢复后自动解锁。证据：`src/server.ts`、`src/deployment-recovery.ts`、`test/deployment-lifecycle.test.js`（真实 HTTP listener + Agent poll 集成用例）。
- [x] **P0-2 Agent 大任务**：Agent 响应上限 24 MiB，结果分段截断；旧 Agent 缺少 `task.large_payload` 时返回升级提示。证据：`agent/client.go`、`src/agent-broker.ts`。
- [x] **P0-3 未认证错误**：未认证请求不回显或写入变更事件。证据：`src/http/application.ts`、认证/路由测试。
- [x] **P0-4 IRR 调度**：库存读取和调度异常被捕获，保留全局 `unhandledRejection` 日志兜底。证据：`src/server.ts`。

## P1

- [x] **P1-1 Agent 升级**：服务端固定 URL、目标路径、服务名和摘要，校验架构、下载前探测并保留 `.prev` 回退。证据：`src/agent-release.ts`、`src/http/mutation-routes.ts`、`agent/client.go`。
- [x] **P1-2 版本 GC**：Agent 只保留活动、candidate、rollback 引用的版本文件，并在连续 stage 后保持数量有界。证据：`agent/bird.go` 的 `gcBirdVersions`、`agent/bird_test.go`。
- [x] **P1-3 删除回滚**：删除资源前保存 rollback，失败时恢复所有资源。证据：`agent/bird.go`、部署生命周期测试。
- [x] **P1-4 长轮询断线**：请求取消会移除 waiter，任务投递到已断开的连接会重新入队。证据：`src/agent-broker.ts`、`src/http/agent-routes.ts`、`test/agent-broker.test.js`。
- [x] **P1-5 长请求**：Fastify 不设置固定请求/连接超时，Agent 任务仍受任务级 deadline 约束。证据：`src/http/application.ts`、`test/http-timeout.test.js`。
- [x] **P1-6 OpenWrt 架构**：支持 armv5/armv6、mips/mipsle、mips64/mips64le、softfloat 和 ELF 大小端识别；发布镜像包含 10 个 Agent 二进制。证据：`Dockerfile`、`scripts/docker-release.sh`、`src/agent-release.ts`、`test/agent-release.test.js`、接入脚本。
- [x] **P1-7 TLS**：支持自定义 CA 和 `BIRDBOX_AGENT_REQUIRE_HTTPS=true`，生产部署文档要求 HTTPS。证据：`agent/main.go`、`docs/docker-deployment.md`。
- [x] **P1-8 依赖**：锁文件已修复并通过 `npm audit --omit=dev --audit-level=high`。

## P2

- [x] **P2-1 凭据保护**：已有 Agent 默认拒绝重新生成脚本，只有显式轮换才签发新凭据。
- [x] **P2-2 反向代理限流**：支持 `BIRDBOX_TRUST_PROXY` 并统一使用 Fastify `request.ip`。
- [x] **P2-3 首次初始化令牌**：支持可选 `BIRDBOX_SETUP_TOKEN`，未提供时保持旧部署兼容。
- [x] **P2-4 IRR 退避**：部署失败写入错误状态和下一次重试时间，并保留旧前缀集直到新结果成功部署。证据：`test/irr-as-set.test.js`。
- [x] **P2-5 OSPF 输入校验**：密码算法、ID、控制字符和 DSCP 在规范化/渲染阶段拒绝非法值。
- [x] **P2-6 Socket GID**：从 Socket 或系统组解析属组，不再硬编码 999。
- [x] **P2-7 准备脚本**：架构/摘要/include/主配置回滚/路径白名单均校验；`chgrp` 缺失或失败会中止，避免产生半配置节点。
- [x] **P2-8 legacy.exec**：生产控制器默认拒绝 root shell；Agent 只有显式 `BIRDBOX_AGENT_LEGACY_EXEC=enabled` 才注册和执行该能力。
- [x] **P2-9 公网 URL**：校验 `BIRDBOX_PUBLIC_URL` 协议、凭据、查询和监听地址，并告警回环/明文 URL。
- [x] **P2-10 路径钉死**：Agent 对主配置、生成配置、Socket 和 Include 基目录执行环境变量白名单校验。

## P3 与工程化

- [x] **P3-1 Agent 主循环**：不重复注册；401 退避重试不触发重启风暴；过期任务回传 `TASK_EXPIRED`，只读任务遵守 deadline。证据：`agent/client_test.go`、`test/agent-broker.test.js`、`test/agent-release.test.js`。
- [x] **P3-2 原子写入**：临时文件、目录和关键 rename 路径执行 fsync。
- [x] **P3-3 预检隔离**：SSH Include 与 Agent Include 预检均写入候选版本并通过临时主配置/生成文件执行 `bird -p -c`，不切换活动 generated/resource 链接；apply 才切换活动链接。证据：`src/bird-runtime.ts`、`agent/bird.go`、`agent/bird_test.go`、`test/bird.test.js`。
- [x] **P3-4 离线快速失败**：后台只读 Agent RPC 在节点离线时立即返回 `AGENT_OFFLINE`。
- [x] **P3-5 密钥回显**：Dashboard、资源响应和配置预览中的密码/密钥统一脱敏；客户端回传占位符时服务端从权威库存恢复原值。证据：`src/inventory-redaction.ts` 及其单测。
- [x] **P3-6 持久审计与 metrics**：MySQL/内存数据库保存有界 HTTP 变更审计；登录用户可查 `/api/audit/events`；`/metrics` 提供 Prometheus 文本指标并可用 `BIRDBOX_METRICS_TOKEN` 保护；Agent 高频轮询不写入审计表。证据：`src/observability.ts`、`src/database.ts`、`src/http/audit-routes.ts`、`test/observability.test.js`。
- [x] **P3-7 单副本约束**：Compose、`docs/architecture.md` 和 `docs/docker-deployment.md` 明确禁止多副本。
- [x] **P3-8 工程化**：新增 GitHub Actions，运行 Node/Go 类型检查、测试、审计和构建；Docker 基础镜像固定 digest；版本改为 semver `0.38.0-alpha.1`。
- [x] **P3-9 文档与静态资源**：Secure Cookie 默认值统一；静态资源增加 ETag/缓存策略；静态路径使用 `path.resolve` 防穿越；`pinyin-pro` 仅保留在开发依赖。

## OSPF 前端补充

- [x] **F-1 多域/删除入口**：工作区支持域选择、命名、新建、删除和链路删除，失败时保留草稿。
- [x] **F-2 风险弹窗测试**：Playwright 统一处理 OSPF 风险确认。
- [x] **F-3 组件 CSS**：Vite 固定 CSS 产物并由 `public/index.html` 引用。
- [x] **F-4 移动端体验**：Playwright desktop/mobile 项目覆盖 320/375/390/430px，验证无水平溢出、操作按钮在视口内、拓扑和链路编辑器可见，并保存回归截图。证据：`test/e2e/ospf-workspace.spec.ts`、`public/styles.css`。
- [x] **F-5 错误态**：节点接口查询失败在页面显示可重试错误，不再只依赖控制台。

## 发布门槛

```bash
npm ci
npm run typecheck:server
npm run typecheck:web
npm test
(cd agent && go vet ./... && go test ./...)
npm audit --omit=dev --audit-level=high
npm run build
```

所有审计项均已完成代码闭环；生产发布仍必须执行下方门槛，并对真实节点进行灰度验证。
