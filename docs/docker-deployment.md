# Docker Compose 部署流程

根目录的 `docker-compose.yml` 使用 Docker Hub 镜像
`pmman/birdbox:${BIRDBOX_IMAGE_TAG}`，并同时启动 MySQL 8.4。Birdbox 容器不以
root 运行，根文件系统只读；SSH 私钥、`known_hosts` 和控制器运行数据保存在
`birdbox_data` 卷，MySQL 数据保存在 `birdbox_mysql` 卷。

## 前置条件

- Docker Engine 24 或更新版本
- Docker Compose v2
- 宿主机可访问 Docker Hub
- 反向代理或防火墙允许访问 Birdbox HTTP 端口
- 管理 SSH 目标可以从 Birdbox 容器访问

## 首次部署

从发布仓库获取 Compose 文件和环境模板：

```bash
git clone https://github.com/pmman289/birdbox.git
cd birdbox
cp .env.example .env
```

编辑 `.env`，至少更改两个 MySQL 密码，并选择要部署的镜像 tag：

```dotenv
BIRDBOX_IMAGE_TAG=latest
MYSQL_PASSWORD=<随机的应用数据库密码>
MYSQL_ROOT_PASSWORD=<随机的数据库 root 密码>
BIRDBOX_BIND_ADDRESS=127.0.0.1
BIRDBOX_PORT=3000
BIRDBOX_SECURE_COOKIE=true
BIRDBOX_SHUTDOWN_TIMEOUT_MS=1800000
```

`.env` 含有凭据，不要提交 Git 或公开分享。`BIRDBOX_SECURE_COOKIE=true` 只应
在 HTTPS 已由 Birdbox 或可信反向代理提供时启用。端口默认只绑定宿主机
`127.0.0.1`；只有防火墙和 HTTPS 入口已准备好时，才把
`BIRDBOX_BIND_ADDRESS` 改为 `0.0.0.0`。

`latest` 适合作为首次安装的默认值。生产环境验证完成后，建议将
`BIRDBOX_IMAGE_TAG` 固定为具体版本 tag 或镜像 digest，使升级和回滚结果可重复。

启动并检查服务：

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

MySQL 健康检查通过后 Birdbox 才会启动。首次打开 Web 页面时设置管理密码；新
Compose 卷没有节点，按页面流程添加第一个 SSH 受管节点。
Compose 会在停止 Birdbox 时为正在执行的远端部署保留 30 分 10 秒；应用本身默认在
30 分钟后强制退出。若调整 `BIRDBOX_SHUTDOWN_TIMEOUT_MS`，编排平台的停止宽限期应
始终比它更长。

远端配置切换前，Birdbox 会在 MySQL 写入部署恢复日志。容器或进程意外中断后，下次
启动会在同一数据库部署锁下完成目标提交或回滚；若库存既不匹配日志的旧版本也不匹配
目标版本，服务会拒绝启动，避免自动覆盖人工修改的数据。此时应保留现场并从同一时间点
的 MySQL 与 `birdbox_data` 备份恢复。

## 升级和回滚

升级只修改 `.env` 的 `BIRDBOX_IMAGE_TAG`，然后拉取并重建 Birdbox 容器：

```bash
docker compose pull birdbox
docker compose up -d --no-deps birdbox
docker compose ps
```

数据库和 SSH 数据卷会被保留。回滚到上一个 tag 或 digest 使用相同命令。不要
使用 `docker compose down -v`，除非明确要删除全部数据。

## 备份

MySQL dump 和 Birdbox 数据卷必须一起备份；只有 MySQL dump 无法恢复控制器 SSH
身份和 `known_hosts`：

```bash
docker compose exec -T db sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump --single-transaction --no-tablespaces -u"$MYSQL_USER" "$MYSQL_DATABASE"' \
  > "birdbox-mysql-$(date -u +%Y%m%dT%H%M%SZ).sql"

docker compose exec -T birdbox tar czf - -C /var/lib/birdbox . \
  > "birdbox-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
```

备份文件也应按敏感凭据处理。恢复前停止 Birdbox，先恢复数据卷，再恢复 MySQL，
最后执行 `docker compose up -d`。

## 日志和故障排查

```bash
docker compose logs -f birdbox
docker compose logs -f db
docker compose ps
docker compose exec birdbox id
```

若 Birdbox 无法启动，先检查 `docker compose ps` 中 MySQL 是否为 `healthy`，再
检查 `.env` 中的数据库名称、用户和密码是否一致。健康接口只检查控制器进程和
数据库连通性，不代表所有远端 BGP 会话已 Established；登录后应在拓扑和会话状态
页面确认各节点状态。

## 从旧 JSON 安装迁移

旧的直接 Node.js 安装可以在第一次连接 MySQL 时导入 `data/inventory.json` 和
`data/auth.json`。Docker Hub 镜像本身不包含 `data/`，因此迁移时应先将旧文件
放在当前目录的 `data/` 下，并在第一次启动前复制到 Birdbox 数据卷：

容器不包含本机 BIRD daemon。若旧资产中存在 `transport: "local"` 节点，应先
把它迁移为独立主机上的 SSH Include 节点；不要把仍依赖本机管理模式的资产直接
用于容器部署。

```bash
docker compose pull birdbox
docker compose run --rm --no-deps \
  --user 0:0 \
  --cap-add DAC_OVERRIDE \
  --cap-add CHOWN \
  --volume "$PWD/data:/migration:ro" \
  --entrypoint sh birdbox -c '
    cp /migration/inventory.json /var/lib/birdbox/inventory.json
    if [ -f /migration/auth.json ]; then
      cp /migration/auth.json /var/lib/birdbox/auth.json
    fi
    if [ -d /migration/ssh ]; then
      mkdir -p /var/lib/birdbox/ssh
      cp -R /migration/ssh/. /var/lib/birdbox/ssh/
    fi
    chown -R 10001:10001 /var/lib/birdbox
  '
docker compose up -d
```

已经初始化过的 MySQL 状态不会再次读取旧 JSON。迁移前必须备份旧 JSON、SSH
私钥和 MySQL 数据，避免把认证 hash 或路由凭据提交到仓库。上述命令会同时复制
旧 `data/ssh/`，从而沿用控制器 SSH 身份。只有库存中没有受管节点时，Birdbox 才会
在该目录不存在时生成新密钥；已有节点时身份文件或对应主机指纹缺失会拒绝启动。

## 节点退役

从页面删除受管节点前，应先删除该节点的会话、Peer 和节点级资源。Birdbox 会先向
目标应用空的受管 include，清除全局 RPKI 和策略声明，再提交库存删除。删除操作不会
修改目标用户的 `authorized_keys` 或系统 BIRD 主配置；永久退役主机时，还应手动删除
带 `restrict` 的 Birdbox 控制器公钥和相应的 `include` 行。

节点永久离线且无法执行远端清理时，可在节点编辑框选择“强制遗忘”。该操作需要再次
输入 `遗忘 <node.id>`，会级联删除其会话、Peer 和节点级资源，并返回 `cleanupRequired: true`。
它不会清理远端生成配置、主配置中的 include 行或 `authorized_keys` 中的控制器公钥；
主机恢复或重新投入使用前必须人工完成这些清理。
