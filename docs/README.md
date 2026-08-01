# Birdbox 发布与部署文档

- [Docker Hub 发布流程](docker-release.md)：维护者或发布 agent 使用 `buildx` 构建、测试并推送 `pmman/birdbox:<tag>`。
- [Docker Compose 部署流程](docker-deployment.md)：运维人员从 Docker Hub 拉取镜像并启动 Birdbox 与 MySQL。

生产 Compose 文件是仓库根目录的 `docker-compose.yml`，默认使用
`pmman/birdbox:0.01a`。通过 `.env` 中的 `BIRDBOX_IMAGE_TAG` 选择其它发布版本。
