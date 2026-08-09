# Birdbox 发布与部署文档

- [开发架构](architecture.md)：当前技术栈、领域边界、依赖方向和数据所有权。
- [开发规范](development.md)：TypeScript、Fastify、Vue、测试和 Code Review 门槛。
- [数据兼容与迁移](data-compatibility.md)：库存、认证、数据库和历史 fixture 的兼容规则。
- [Docker Hub 发布流程](docker-release.md)：维护者或发布 agent 使用 `buildx` 构建、测试并推送 `pmman/birdbox:<tag>`。
- [Docker Compose 部署流程](docker-deployment.md)：运维人员从 Docker Hub 拉取镜像并启动 Birdbox 与 MySQL。

生产 Compose 文件是仓库根目录的 `docker-compose.yml`，默认使用
`pmman/birdbox:latest`。通过 `.env` 中的 `BIRDBOX_IMAGE_TAG` 可以固定其它发布版本或 digest。
