# Birdbox

Birdbox 是一个面向 BIRD 2 的 Web 控制台，用于管理受管路由节点、外部 BGP Peer、BGP 会话和路由策略。它通过 SSH 连接节点，生成并校验 BIRD 配置，然后安全地部署到目标节点。

Birdbox 适合希望通过浏览器完成以下工作的网络管理员：

- 查看节点和 BGP 会话状态；
- 创建、预检和部署 IPv4/IPv6 eBGP 会话；
- 管理 CIDR Define、节点级 Static Protocol、Function、Filter、RPKI 和源地址出口映射资源；
- 为每个会话独立设置导入、导出和高级 BGP 参数；
- 在配置失败时保留原库存并回滚已完成的节点部署。

## 工作方式

Birdbox 不替换目标机器上的 BIRD 主配置，也不需要日常使用远程 root 登录。首次接入时，由管理员在目标节点以 root 执行一次准备脚本；之后 Birdbox 使用专用的非特权 SSH 用户，只维护自己的生成配置文件。

准备脚本会自动在 BIRD 主配置中加入 Birdbox 文件：

```bird
include "/var/lib/birdbox/generated.conf";
```

Birdbox 会在写入库存前使用目标节点上的原生 `bird -p` 校验完整配置。远程部署期间会使用数据库锁和持久恢复记录，服务重启后能够继续完成提交或回滚。

## 快速部署

### 前置条件

- Docker Engine 24 或更高版本；
- Docker Compose v2；
- 宿主机可以访问 Docker Hub；
- 目标路由节点运行 BIRD 2.19.1，并允许 SSH 访问；
- 目标节点的 BIRD 控制 Socket 属于一个可授权的非 root 用户组；
- 生产环境建议使用 HTTPS 反向代理。

### 使用 Docker Compose

```bash
git clone https://github.com/pmman289/birdbox.git
cd birdbox
cp .env.example .env
```

编辑 `.env`，至少修改两个数据库密码：

```dotenv
BIRDBOX_IMAGE_TAG=latest
MYSQL_DATABASE=birdbox
MYSQL_USER=birdbox
MYSQL_PASSWORD=请替换为随机密码
MYSQL_ROOT_PASSWORD=请替换为另一组随机密码
BIRDBOX_BIND_ADDRESS=127.0.0.1
BIRDBOX_PORT=3000
BIRDBOX_SECURE_COOKIE=true
```

`latest` 便于首次部署直接取得当前稳定版本。生产环境完成验证后，建议把
`BIRDBOX_IMAGE_TAG` 固定为具体版本 tag 或镜像 digest，避免后续拉取到未经本环境验证的版本。

启动服务并检查状态：

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

浏览器打开 <http://127.0.0.1:3000>。第一次访问时直接设置 `admin` 管理密码。设置成功后，初始化接口会永久关闭。

### 使用局域网访问

默认只把宿主机端口绑定到 `127.0.0.1`。如果需要从局域网其它设备访问，把 `.env` 改为：

```dotenv
BIRDBOX_BIND_ADDRESS=0.0.0.0
```

然后重建容器：

```bash
docker compose up -d --force-recreate birdbox
```

同时在防火墙中只允许可信网段访问 `BIRDBOX_PORT`。未初始化的服务不能直接暴露到公网。

## 接入第一个节点

### 1. 准备目标节点

目标节点应满足：

- BIRD 2 已安装并正在运行；
- BIRD 控制 Socket 已创建。常规 Linux 应使用非 `root` 控制组，OpenWrt 可以由准备脚本自动配置专用控制组；
- BIRD 主配置文件路径已确定，例如 `/etc/bird/bird.conf`。
- 管理员可以在首次接入时执行一次 root 准备脚本。

### 2. 生成准备脚本

登录 Birdbox 后进入“资源管理”中的“受管节点”，点击“添加节点”，填写节点地址、SSH 用户、Router ID 和配置路径，然后点击“生成准备脚本”。

常规 Linux 使用默认的 Linux 预设。OpenWrt/iStoreOS 应选择 OpenWrt 预设，默认路径为：

```text
主配置：/etc/bird.conf
生成配置：/etc/birdbox/generated.conf
控制 Socket：/var/run/bird.ctl
```

OpenWrt 的 `/var` 和 `/tmp` 位于内存盘，不能把生成配置或受管用户 Home 放在这些目录。Birdbox 会把 OpenWrt 的生成配置和 SSH Home 放在 `/etc` 下的持久存储中。

复制完整脚本，在目标节点的 root Shell 中执行：

```bash
sh birdbox-node-setup.sh
```

常规 Linux 使用非 root 管理账户登录时，也可以执行 `sudo sh birdbox-node-setup.sh`。

脚本会自动完成以下工作：创建缺失的专用用户和持久 Home 目录、加入 BIRD Socket 用户组、安装受限 SSH 公钥、创建受管配置目录、写入主配置 Include，并执行 `configure check` 和 `configure`。主配置修改前会在同目录创建临时备份；任何检查或加载失败都会恢复原配置。脚本可重复执行，不会重复添加用户、公钥或 Include。

在 OpenWrt 上，脚本还会使用 `/bin/ash` 作为 Dropbear 登录 Shell，并为 `/etc/init.d/bird` 的 procd 启动命令配置专用运行组。首次配置控制组时 BIRD 会重启一次；脚本会等待 `birdc show status` 真正恢复后再继续，失败时恢复原 init 脚本。

### 3. 测试并保存节点

脚本成功后回到 Birdbox 点击“测试连接”，通过后保存节点。首次 SSH 连接使用 TOFU（首次信任）策略；高安全环境应在首次连接前人工核对主机指纹。

## 创建 Peer 和 BGP 会话

1. 在当前节点下添加外部 Peer，填写邻居地址、ASN 和 BGP 端口。
2. 在“会话与拓扑”中选择节点和 Peer。
3. 填写本地地址、本地 ASN、协议名称和启用的 Address Family。
4. 选择导入/导出策略，必要时添加 CIDR Define 或高级 BGP 参数。
5. 点击“预检”，确认生成的完整 BIRD 配置通过校验。
6. 点击“应用”，等待节点接受配置并查看 Established 状态。

预检或部署失败时，Birdbox 不会提交库存变更；已经完成的节点会尝试回滚。重复提交前应先刷新状态，确认远端和库存是否已经完成变更。

## 路由策略资源

### Define

Define 可以应用于所有节点，也可以限制到一个或多个指定节点。支持 IPv4 CIDR 前缀集合、IPv6 CIDR 前缀集合和安全的 BIRD 表达式。导出策略可以选择全部路由、禁止导出或引用一个 CIDR Define。

CIDR Define 的条目可以手工填写，也可以绑定 IRR AS-SET，由控制器使用 `bgpq4` 定期展开并同步。用户可以设置 IRR Server、Database、刷新间隔、前缀数量上限和是否匹配更具体前缀。动态前缀以独立的哈希版本文件下发，主生成配置只包含 Include；同步失败、结果为空、超过限制或节点预检失败时继续使用最近一次成功快照。官方 Docker 镜像已经内置 `bgpq4`，受管节点不需要安装。

### Static Protocol

Static 是节点级资源，不属于任何 BGP 会话。一个节点可以创建多个 IPv4 或 IPv6 Static Protocol；每个资源可选择匹配地址族的 CIDR Define 和标准路由动作，也可以填写自定义 Static 指令。Import、Export 均可独立选择 `all` 或 `none`，默认值为 `import all`、`export none`。

同一前缀可以出现在多个 Static Protocol 中，但标准路由动作必须一致；Import、Export 策略可以不同。BGP 会话是否启用、编辑或删除不会修改节点 Static 资源，路由是否向某个 Peer 发布仍由该会话自己的 Export 策略决定。

### Function 和 Filter

Function 用于可复用的策略步骤，Filter 用于完整的自定义路由过滤器。两者均可应用于所有节点或多个指定节点；Birdbox 会递归检查 Define、Function、Filter、RPKI 和 Static 自定义源码的依赖链，阻止作用域不匹配、依赖停用、声明顺序错误以及自调用或循环依赖。

### RPKI

RPKI 资源支持本地 ROA 文件和 RPKI-RTR 缓存，可应用于所有节点或多个指定节点。IPv4、IPv6 ROA Table 可以分别启用，并在 Filter 中通过 `roa_check()` 使用。

### 源地址出口映射

源地址出口映射将一批 IPv4 源 CIDR 按出口地址分组，并下发到指定节点。Birdbox 为每个出口组生成独立 BIRD table、recursive default 和 Kernel Protocol；出口地址通过 `master4` 动态解析。每个出口组的 Linux kernel table 默认自动分配，也可以手工指定未占用的 table ID。保存后，界面会按节点提供 Linux root 脚本、完整 systemd 安装/更新脚本或 OpenWrt LuCI 规则清单。Birdbox 不会自动执行 `ip rule`，删除或停用映射集后也需要执行对应的规则清理计划。

## 数据、备份和升级

生产环境必须同时备份 MySQL 和 Birdbox 数据卷：

- MySQL 保存库存、认证状态和部署恢复记录；
- `birdbox_data` 保存控制器 SSH 私钥、`known_hosts` 和运行数据。

只备份 MySQL 无法恢复控制器 SSH 身份。Compose 部署的完整备份、恢复、升级和旧 JSON 迁移流程见 [Docker Compose 部署文档](docs/docker-deployment.md)。

升级镜像：

```bash
docker compose pull birdbox
docker compose up -d --no-deps birdbox
docker compose ps
```

不要使用 `docker compose down -v`，除非确定要删除全部数据库和控制器数据。

## 节点退役

在线节点的正常退役会先部署空的 Birdbox Include，再从库存删除节点。系统 BIRD 主配置中的 Include 行和目标用户 `authorized_keys` 中的控制器公钥仍需要人工删除。

如果节点永久离线，在节点编辑页面选择“强制遗忘”，并输入：

```text
遗忘 <node.id>
```

该操作会级联删除会话、Peer 和节点级资源，但不会连接远端清理配置。完成后请按页面清单手动删除主配置 Include、生成配置和控制器公钥。

## 安全建议

- 生产环境使用 HTTPS，并设置 `BIRDBOX_SECURE_COOKIE=true`；
- 不要把 `.env`、MySQL 密码、SSH 私钥、`known_hosts` 或包含 TCP MD5/TCP-AO 密钥的库存文件提交到 Git；
- 首次初始化前不要把服务暴露到公网；
- 为每个路由节点使用专用的非特权 SSH 用户；
- 高安全环境预先核对并固定目标 SSH 主机指纹；
- 通过防火墙限制 Web 端口和 SSH 管理端口的来源网段。

## 本地开发

需要 Node.js 24 或更高版本。应用默认使用 MySQL；测试使用内存数据库：

```bash
npm install
NODE_ENV=test BIRDBOX_DATABASE_URL=memory: npm test
npm start
```

真实 MySQL 集成测试：

```bash
BIRDBOX_TEST_MYSQL_URL='mysql://用户:密码@主机:3306/测试库' npm test
```

更多运维说明见 [docs/README.md](docs/README.md)。
