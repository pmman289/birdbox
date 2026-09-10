# Birdbox 发布与部署文档

- [开发架构](architecture.md)：当前技术栈、领域边界、依赖方向和数据所有权。
- [开发规范](development.md)：TypeScript、Fastify、Vue、测试和 Code Review 门槛。
- [数据兼容与迁移](data-compatibility.md)：库存、认证、数据库和历史 fixture 的兼容规则。
- [源地址出口映射](source-policy-routing.md)：按源 IPv4 CIDR 选择动态解析的远端出口，并通过 Agent 自动维护策略路由规则；旧 SSH 节点提供升级提示和兼容计划。
- [Docker Hub 发布流程](docker-release.md)：维护者或发布 agent 使用 `buildx` 构建、测试并推送 `pmman/birdbox:<tag>`，并构建、发布多架构 Agent。
- [Docker Compose 部署流程](docker-deployment.md)：运维人员从 Docker Hub 拉取镜像并启动 Birdbox 与 MySQL。
- [Agent 主动连接与升级](agent.md)：新增 Agent 节点、旧 SSH 节点升级、RPC 和安全要求。
- [用户操作手册](user-guide.md)：面向网络管理员的部署、节点接入、eBGP、iBGP、OSPF 和全部资源使用流程，附真实界面截图。
- [OSPF 测试分析与全量用例](ospf-test-plan.md)：OSPF 管理功能的测试分析、分层用例、并发/回滚故障注入、实机验证和发布放行标准。

生产 Compose 文件是仓库根目录的 `docker-compose.yml`，默认使用
`pmman/birdbox:latest`。通过 `.env` 中的 `BIRDBOX_IMAGE_TAG` 可以固定其它发布版本或 digest。
