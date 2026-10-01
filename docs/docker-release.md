# Docker Hub 发布流程

本文给维护者和发布 agent 使用。目标仓库是
`pmman/birdbox`，发布镜像格式为 `pmman/birdbox:<tag>`。

## 发布约定

`package.json` 的 `version` 是默认发布 tag。版本 tag 必须是 Docker 合法的
tag 字符串，例如 `0.02a`、`0.03a` 或 `2026.07.31`。当前发布流程每次都将
该版本同步到 `latest`。

一个 tag 发布后视为不可变版本。修复同一版本时应递增版本号，而不是覆盖
已有 tag。部署端也可以把 `BIRDBOX_IMAGE_TAG` 写成
`<tag>@sha256:<digest>` 来锁定镜像内容。

## 一键发布脚本

仓库根目录执行以下命令即可完成版本读取、依赖安装、测试、构建、本机 amd64
冒烟测试、Agent 文件及下载摘要校验、多架构推送，以及 `latest` 同步：

```bash
./scripts/docker-release.sh
```

脚本默认发布 `package.json` 当前版本到 `pmman/birdbox:<version>`，并推送
`linux/amd64,linux/arm64`。工作区必须干净，已有版本 tag 默认拒绝覆盖。仅在
明确需要替换版本 tag 时使用 `--overwrite-version`；调试时可使用
`--skip-tests`、`--skip-smoke` 或 `--dry-run`。完整参数和环境变量说明可用
以下命令查看：

```bash
./scripts/docker-release.sh --help
```

## 发布前检查

在仓库根目录执行：

```bash
git status --short
npm ci
npm test
docker buildx version
docker compose version
```

如果需要验证真实 MySQL 集成测试，使用一个专用测试数据库，不要连接生产库：

```bash
export BIRDBOX_TEST_MYSQL_URL='mysql://user:password@127.0.0.1:3306/birdbox_test'
npm test
unset BIRDBOX_TEST_MYSQL_URL
```

确认 `package.json` 的版本、变更日志和待发布 Git commit 已经确定。不要把
`.env`、`data/`、SSH 私钥、`known_hosts` 或真实路由凭据放进构建上下文。
仓库的 `.dockerignore` 已排除这些目录，但发布前仍应检查 `git status`。

## 登录 Docker Hub

使用 Docker Hub access token，不要使用个人密码：

```bash
docker login
```

登录账号必须拥有 `pmman/birdbox` 的 push 权限。发布 agent 应通过环境或凭据
管理器提供 token，命令历史中不应出现 token 明文。

## 本机镜像冒烟测试

先在当前架构加载镜像，验证容器能启动。下面的命令只创建临时 Compose 项目和
临时卷：

```bash
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")"
VCS_REF="$(git rev-parse --short=12 HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE="pmman/birdbox:${VERSION}"

docker buildx build \
  --platform linux/amd64 \
  --load \
  --build-arg BIRDBOX_VERSION="$VERSION" \
  --build-arg VCS_REF="$VCS_REF" \
  --build-arg BUILD_DATE="$BUILD_DATE" \
  --tag "$IMAGE" \
  .

BIRDBOX_PORT=33100 \
BIRDBOX_IMAGE_TAG="$VERSION" \
docker compose --env-file .env.example -p birdbox-release-smoke up -d

docker compose --env-file .env.example -p birdbox-release-smoke ps
curl --retry 15 --retry-all-errors --retry-delay 1 -fsS http://127.0.0.1:33100/api/health
curl --retry 15 --retry-all-errors --retry-delay 1 -fsS http://127.0.0.1:33100/api/auth/status

docker compose --env-file .env.example -p birdbox-release-smoke down -v
```

冒烟测试必须看到 `/api/health` 返回 `{"status":"ok",...}`，并且 Birdbox 与
MySQL 容器均为 `healthy`。若宿主机不是 amd64，把 `--platform` 改成当前架构，
或直接执行多架构构建后在目标平台验证。

## 构建并推送多架构镜像

首次使用时创建一个持久的 buildx builder：

```bash
docker buildx create --name birdbox-builder --driver docker-container --use
docker buildx inspect --bootstrap
```

然后执行一次构建并直接推送 manifest list。每个控制器镜像同时携带全部 Agent
架构的二进制，因此安装脚本不依赖构建主机架构：

```bash
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")"
VCS_REF="$(git rev-parse --short=12 HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker buildx build \
  --builder birdbox-builder \
  --platform linux/amd64,linux/arm64 \
  --build-arg BIRDBOX_VERSION="$VERSION" \
  --build-arg VCS_REF="$VCS_REF" \
  --build-arg BUILD_DATE="$BUILD_DATE" \
  --tag "pmman/birdbox:${VERSION}" \
  --provenance=mode=max \
  --sbom=true \
  --push \
  .
```

推送完成后核对架构、digest 和镜像标签：

```bash
docker buildx imagetools inspect "pmman/birdbox:${VERSION}"
```

输出应包含 `linux/amd64`、`linux/arm64` 和 `linux/arm/v7`。记录 digest，生产环境推荐将
`.env` 中的 `BIRDBOX_IMAGE_TAG` 设置为例如
`0.02a@sha256:...`，从而避免 tag 被意外替换。

如果明确只发布当前宿主机架构，也可以使用传统 push 流程：

```bash
docker build --tag pmman/birdbox:tagname .
docker push pmman/birdbox:tagname
```

这种方式不会生成 amd64/arm64 manifest list，不应替代正式的多架构发布流程。

## 稳定版标签

预发布版本只推送版本 tag。稳定版本如需更新 `latest`，先完成版本 tag 的冒烟
测试，再执行：

```bash
docker buildx imagetools create \
  --tag pmman/birdbox:latest \
  pmman/birdbox:"$VERSION"
```

不要让 `latest` 成为生产 Compose 的唯一依赖；生产部署应记录具体版本或 digest。

## Agent 构建与发布

Agent 使用仓库根目录 `Dockerfile` 的 `agent-build` 阶段交叉编译，最终复制到镜像的
`/usr/local/lib/birdbox-agent` 目录下。服务端默认通过
`/usr/local/lib/birdbox-agent/birdbox-agent-*` 查找对应架构的文件；当前发布的架构和下载参数如下：

| 目标平台 | `arch` 参数 | Go 架构 | 镜像内文件 |
| --- | --- | --- | --- |
| x86_64 | `amd64` | `GOARCH=amd64` | `birdbox-agent-amd64` |
| AArch64 | `arm64` | `GOARCH=arm64` | `birdbox-agent-arm64` |
| ARMv7 | `arm` | `GOARCH=arm GOARM=7` | `birdbox-agent-arm` |
| ARMv6 | `armv6` | `GOARCH=arm GOARM=6` | `birdbox-agent-armv6` |
| ARMv5 | `armv5` | `GOARCH=arm GOARM=5` | `birdbox-agent-armv5` |
| MIPS | `mips` | `GOARCH=mips` | `birdbox-agent-mips` |
| MIPS little-endian | `mipsle` | `GOARCH=mipsle` | `birdbox-agent-mipsle` |
| MIPS64 | `mips64` | `GOARCH=mips64` | `birdbox-agent-mips64` |
| MIPS64 little-endian | `mips64le` | `GOARCH=mips64le` | `birdbox-agent-mips64le` |
| RISC-V 64 | `riscv64` | `GOARCH=riscv64` | `birdbox-agent-riscv64` |

### 构建参数

正式构建必须显式传入以下参数：

- `BIRDBOX_VERSION`：写入 Agent `--version` 和 OCI image label，通常使用
  `package.json` 的版本。
- `VCS_REF`：Git commit 短 SHA，写入 OCI image label，便于追溯源码。
- `BUILD_DATE`：UTC ISO 8601 时间，写入 OCI image label。

示例：

```bash
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")"
VCS_REF="$(git rev-parse --short=12 HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker buildx build \
  --builder birdbox-builder \
  --platform linux/amd64,linux/arm64 \
  --build-arg BIRDBOX_VERSION="$VERSION" \
  --build-arg VCS_REF="$VCS_REF" \
  --build-arg BUILD_DATE="$BUILD_DATE" \
  --tag "pmman/birdbox:${VERSION}" \
  --push .
```

`agent-build` 本身会生成上表中的十种 Linux Agent；`--platform` 控制的是最终
Birdbox 控制器镜像的运行平台，不会减少 Agent 二进制的数量。构建后应检查镜像内
文件：

```bash
docker run --rm --entrypoint sh "pmman/birdbox:${VERSION}" -c \
  'ls -l /usr/local/lib/birdbox-agent/birdbox-agent-*'
```

### 下载、校验与安装脚本

主控提供两个无需登录的引导接口，供尚未注册的节点下载 Agent：

```text
GET /api/agent/releases/latest/download?arch=<arch>
GET /api/agent/releases/latest/checksum?arch=<arch>
```

例如：

```bash
curl -fsS -o birdbox-agent \
  "https://birdbox.example.com/api/agent/releases/latest/download?arch=arm64"
curl -fsS "https://birdbox.example.com/api/agent/releases/latest/checksum?arch=arm64"
sha256sum birdbox-agent
```

Agent 节点准备脚本会根据 `uname -m` 自动映射架构、下载二进制、校验 SHA-256，
然后安装 systemd unit 或 OpenWrt procd 服务。发布新镜像后，必须在主控执行
`docker compose pull birdbox && docker compose up -d --no-deps birdbox`，使下载
接口切换到新镜像中的 Agent；已经运行的 Agent 不会被自动替换，需从节点管理页面
发起自升级或重新执行升级脚本。

发布前至少验证每种目标架构的下载和摘要接口返回 200，并确认摘要与下载文件一致：

```bash
for arch in amd64 arm64 arm mips mipsle mips64 riscv64; do
  curl -fsS -o "/tmp/birdbox-agent-$arch" \
    "https://birdbox.example.com/api/agent/releases/latest/download?arch=$arch"
  curl -fsS "https://birdbox.example.com/api/agent/releases/latest/checksum?arch=$arch" \
    | tr -d '[:space:]' | cmp - <(sha256sum "/tmp/birdbox-agent-$arch" | awk '{print $1}')
done
```

`latest` 下载接口始终对应当前运行中的控制器镜像，而不是 Docker Hub 上尚未部署的
镜像。生产环境应先完成镜像升级，再为新 Agent 节点生成准备脚本，并保留旧版本镜像
以便回滚。

## 发布后的检查与回滚

在一台干净的目标主机上使用新 tag 执行部署文档中的流程，确认镜像拉取、MySQL
健康检查、Birdbox 健康检查和首次密码设置都正常。回滚时只需要改回上一个版本
或 digest，然后重新拉取并启动：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

不要执行 `docker compose down -v` 作为普通升级步骤；这会删除 MySQL 和 Birdbox
持久卷。发布完成后保留 Docker Hub digest、Git commit、测试结果和回滚版本记录。
