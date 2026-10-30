# Birdbox

Birdbox 是一个面向 BIRD 2 的 Web 控制台，用于管理受管路由节点、外部 BGP Peer、BGP 会话和路由策略。它通过 SSH 连接节点，生成并校验 BIRD 配置，然后安全地部署到目标节点。

Birdbox 适合希望通过浏览器完成以下工作的网络管理员：

- 查看节点和 BGP 会话状态；
- 创建、预检和部署 IPv4/IPv6 eBGP 会话；
- 管理 CIDR Define、节点级 Static Protocol、Pipe、Function、Filter、RPKI 和源地址出口映射资源；
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
# Agent 节点回连时必须填写节点实际可达的 URL，不能填写 0.0.0.0
BIRDBOX_PUBLIC_URL=http://127.0.0.1:3000
BIRDBOX_SECURE_COOKIE=false
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

### 使用 Agent 节点

Agent 是节点主动连接模式，节点不需要暴露入站端口，但必须能够访问 Birdbox
主控的 HTTP/HTTPS 端口。Docker Compose 的端口格式是：

```text
宿主机地址:宿主机端口:容器端口
```

容器内部固定监听 `3000`，因此远程 Agent 部署可以使用下面的配置（示例主控地址为
`172.20.177.34`）：

```dotenv
BIRDBOX_BIND_ADDRESS=0.0.0.0
BIRDBOX_PORT=3500
BIRDBOX_PUBLIC_URL=http://172.20.177.34:3500
BIRDBOX_SECURE_COOKIE=false
```

对应的 Compose 映射为 `0.0.0.0:3500:3000`（容器端口仍固定为 `3000`）：

```yaml
services:
  birdbox:
    ports:
      - "0.0.0.0:3500:3000"
```

使用仓库自带 Compose 文件时，无需手工改 YAML，`.env` 中的
`BIRDBOX_BIND_ADDRESS` 和 `BIRDBOX_PORT` 会生成同样的映射。修改 `.env` 后重建主控容器：

```bash
docker compose up -d --force-recreate birdbox
curl -fsS http://172.20.177.34:3500/api/health
```

在浏览器中为 Agent 节点生成准备脚本时，脚本会使用
`BIRDBOX_PUBLIC_URL` 下载对应架构的 Agent，并连接以下主控接口：
`/api/agent/register`、`/api/agent/tasks/poll` 和
`/api/agent/tasks/:taskId/result`。防火墙和反向代理必须放行该 URL；Agent 不需要
单独的 Docker 服务或入站端口。若通过 HTTPS 反向代理发布，`BIRDBOX_PUBLIC_URL`
应填写完整的 `https://` 地址，并将 `BIRDBOX_SECURE_COOKIE` 设为 `true`。

Agent 的构建、镜像发布、架构映射和下载校验流程见
[Agent 构建与发布](docs/docker-release.md#agent-构建与发布)。

## 接入第一个节点

### 1. 准备目标节点

目标节点应满足：

- BIRD 2 已安装并正在运行；
- BIRD 控制 Socket 已创建。常规 Linux 应使用非 `root` 控制组，OpenWrt 可以由准备脚本自动配置专用控制组；
- BIRD 主配置文件路径已确定，例如 `/etc/bird/bird.conf`。
- 管理员可以在首次接入时执行一次 root 准备脚本。

### 2. 生成准备脚本

登录 Birdbox 后进入“资源管理”中的“受管节点”，点击“添加节点”，填写节点名称、Router ID、IGP 地址和配置路径，然后点击“生成准备脚本”。新节点统一使用 Agent 主动连接，不再填写 SSH 连接地址、SSH 端口或 SSH 用户。

已有旧 SSH 节点仍可编辑 SSH 地址和端口（不会改变既有会话地址或节点 IGP 地址），并在节点编辑页面生成 Agent 升级脚本，待 Agent 注册后切换管理方式。

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

eBGP 会话预检通过后仍保留未应用标记，刷新状态不会清空草稿。Import/Export 和路由数量限制默认显示摘要，展开后分别编辑。应用先展示当前预检配置的确认；库存变化时可对比最新配置并保留草稿重新预检。完整流程及真实 Agent + BIRD 双版本测试见 [eBGP 验收记录](docs/ebgp-verification.md)。

## 用户操作手册与界面预览

iBGP 域支持独立双端配置与连接启停。先“预检并查看变更”，检查新旧成员的配置差异及逐节点结果，再确认应用；失败与冲突会保留草稿，空域也可保存。测试和适用边界见 [iBGP 验收记录](docs/ibgp-verification.md)。

完整的中文用户教程、部署步骤、eBGP/iBGP/OSPF 全流程、资源用途、故障处理和最佳实践见 [Birdbox 用户操作手册](docs/user-guide.md)。

下面的截图来自开发实例的真实前端页面，并通过 Playwright 采集：

![eBGP 管理](docs/images/ebgp-overview.png)

![iBGP 域管理](docs/images/ibgp-domain.png)

![OSPF 管理](docs/images/ospf-domain.png)

![资源管理](docs/images/resource-management.png)

## 路由策略资源

### Define

Define 可以应用于所有节点，也可以限制到一个或多个指定节点。支持 IPv4 CIDR 前缀集合、IPv6 CIDR 前缀集合和安全的 BIRD 表达式。导出策略可以选择全部路由、禁止导出或引用一个 CIDR Define。

在“资源管理 → Defines”中创建或编辑，手工前缀支持文本导入、去重和导出，表达式可从常用模板开始。编辑器显示未保存状态、影响节点和直接/间接引用；先“预检并查看变更”，核对前缀增删、逐节点配置差异和检查结果后，再“确认应用”。预检不会保存或下发配置，修改内容后需要重新预检。

并发修改时保留本地草稿，可加载最新版本进行三方对比，再采用服务端配置或保留草稿重新预检。若资源已在另一处删除，可将草稿作为新 Define 预检并确认应用。被引用资源的删除、改名、停用及节点范围调整由服务端校验保护。验收范围与复现命令见 [Define 验收记录](docs/define-verification.md)。

CIDR Define 的条目可以手工填写，也可以绑定 IRR AS-SET，由控制器使用 `bgpq4` 定期展开并同步。用户可以设置 IRR Server、Database、刷新间隔、前缀数量上限和是否匹配更具体前缀。动态前缀以独立的哈希版本文件下发，主生成配置只包含 Include；同步失败、结果为空、超过限制或节点预检失败时继续使用最近一次成功快照。官方 Docker 镜像已经内置 `bgpq4`，受管节点不需要安装。

### Static Protocol

Static 是节点级资源，支持直接添加路由和 CIDR Define 批量生成，IPv4/IPv6 分别管理。可配置单下一跳、接口、ECMP 权重、递归、blackhole/unreachable/prohibit、逐下一跳 BFD、check link、逐路由属性及自定义代码；支持选择或创建 BIRD 路由表，管理表与 Pipe 去重共享。相同前缀允许用 Preference / Metric 区分主备路由。Import 支持 all/none、Function 组合及 Filter，路由向其它协议发布仍由对应协议策略决定。

预检返回服务端候选配置、差异和节点检查结果，不修改库存或活动配置。确认后保存应用仍重新执行完整预检，校验候选与库存 revision，沿用部署锁、CAS、journal 和回滚。列表提供独立运行态和路由查询入口，显示真实协议状态、原始详情、指定协议的路由和目标 IP 查询。失败保留草稿；桌面及移动端编辑内容独立滚动、操作栏固定。

使用说明见 [Static 路由](wiki/Static%20路由.md)。真实浏览器、Agent 和 BIRD 流程可运行 `BIRD_VERSION=2.17.5 bash scripts/static-e2e.sh` 或 `BIRD_VERSION=2.19.0 bash scripts/static-e2e.sh`，测试环境和结果见 [Static 验收记录](docs/static-verification.md)。

### Pipe Protocol

进入“资源管理 → Pipe”，选择下发节点和地址族，填写主表及对端表。新建默认将 `master4`（IPv6 为 `master6`）中的路由传递到新建的对端表；**主表 → 对端表使用 Export**，默认允许，**对端表 → 主表使用 Import**，默认禁止。两方向分别支持 all/none、Function 组合和自定义 Filter；前缀筛选使用 Filter。每个地址族创建一条 Pipe，多个节点使用相同的表名和策略。

路由表可引用内置表、库存已知表或手工填写的已有表，也可由 Birdbox 创建。管理表按节点和表名去重，停用 Pipe 只移除协议，保留表；最后一个管理引用删除后移除表声明。若其它配置仍依赖该表，完整预检会拒绝变更并保留原配置。源地址出口映射内部自动生成的表只允许引用，其内部 Pipe 独立管理。

“预检配置”只检查候选配置，不保存库存或下发活动配置。“保存并应用”始终重新执行完整预检，沿用部署锁、CAS、journal 和失败回滚；修改节点范围会同步清理旧节点。保存失败时编辑内容保留。运行态独立查看每个节点的协议状态、可用统计和错误，两侧路由可按节点、路由表和目标 IP 查询；eBGP 路由明细每页最多显示 200 条，可在详情弹窗中翻页查看完整结果。路由保留原协议来源，表内路由不等于 Pipe 的传递记录；缺失的统计显示未知。

真实隔离 BIRD 与 Agent 链路验收可运行 `BIRD_VERSION=2.17.5 scripts/pipe-e2e.sh` 和 `BIRD_VERSION=2.19.0 scripts/pipe-e2e.sh`（需要 Docker）。测试环境和结果见 [Pipe 验收记录](docs/pipe-verification.md)。

### Function 和 Filter

Function 用于可复用的策略步骤，Filter 用于完整的自定义路由过滤器。两者均可应用于所有节点或多个指定节点；Birdbox 会递归检查 Define、Function、Filter、RPKI 和 Static 自定义源码的依赖链，阻止作用域不匹配、依赖停用、声明顺序错误以及自调用或循环依赖。

### RPKI

RPKI 资源支持本地 ROA 文件和 RPKI-RTR 缓存，可应用于所有节点或多个指定节点。IPv4、IPv6 ROA Table 可以分别启用，并在 Filter 中通过 `roa_check()` 使用。

新建默认当前节点与双栈 RTR；切换文件/RTR、TCP/SSH 或地址族会保留草稿。先“预检并查看变更”，核对完整配置、差异和节点结果后“确认应用”。失败或库存冲突保留编辑内容，比较最新配置后可重新预检。已有凭据掩码由服务端保留。

列表的“运行态”分节点展示 RTR 连接状态、双栈 Channel 和 ROA 数量；文件来源展示 Static 状态。可按节点、地址族查询 ROA 并搜索前缀或 ASN，最多返回 200 条。旧 ROA 数量不代表 RTR 连接正常。真实 BIRD 2.17.5/2.19.0 的 Agent、RTR 和文件验收范围见 [RPKI 验收记录](docs/rpki-verification.md)。

### 源地址出口映射

源地址出口映射将一批 IPv4 源 CIDR 按出口地址分组，并下发到指定节点。Birdbox 为每个出口组生成独立 BIRD table、recursive default 和 Kernel Protocol；出口地址通过 `master4` 动态解析。每个出口组的 Linux kernel table 默认自动分配，也可以手工指定未占用的 table ID。Agent 节点保存后会自动维护 `ip rule`，并为出口地址添加查询 `main` 表的目的地址例外，避免递归下一跳被源策略表再次接管。旧 SSH 节点仍提供 root 脚本、完整 systemd 安装/更新脚本或 OpenWrt LuCI 规则清单，并提示先升级为 Agent。

新建或修改映射时，出口地址不能落在任意源 CIDR 内；否则会提示拆分源 CIDR 或更换出口地址。为兼容升级，历史库存中的此类配置仍可读取，旧 SSH 节点升级为 Agent 时会先接管现有规则并补齐目的地址例外。

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

## 重装或迁移已有节点

在“资源管理 → 受管节点”中编辑原节点，在“重新安装”区域点击“生成重新安装脚本”，复制执行命令或完整脚本，在新主机的 root Shell 中执行。目标主机需先安装并启动 BIRD 2，并准备好原节点使用的 BIRD 主配置、Socket 路径及 ROA 文件等依赖。

脚本沿用已保存的节点 ID 和配置路径，生成时不修改库存、不下发路由配置，原有会话、策略及 OSPF 配置会保留。再次获取脚本不会让原 Agent 凭据失效，也不会断开原 Agent。迁移时应停止旧主机的 Agent，避免两台主机同时使用同一节点身份。Agent 主动回连主控，迁移后无需修改 SSH 地址。

执行成功后回到原节点编辑页，点击“测试连接”，再点击“保存节点”预检并重新下发已有配置。SSH 节点可先更新连接地址和端口；会话地址、接口名和 IGP 地址需要按新主机的实际情况核对。托管密钥和 Include 模式的 SSH 节点可以重新生成准备脚本，其它旧 SSH 节点请使用“升级为 Agent 管理”入口。

## 删除节点

在线节点的删除会先部署空的 Birdbox Include，再从库存删除节点。系统 BIRD 主配置中的 Include 行和目标用户 `authorized_keys` 中的控制器公钥仍需要人工删除。

如果节点永久离线，在节点编辑页面选择“强制删除”，并输入：

```text
强制删除 <node.id>
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

节点安装脚本实测（需要 Docker、网络访问及运行特权容器的权限，用于启动真实 systemd；只操作临时容器，不修改宿主机服务）：

```bash
bash scripts/node-installer-e2e.sh
BIRD_VERSION=2.19.0 bash scripts/node-installer-e2e.sh
```

测试从当前源码编译 Agent，在 Debian 12 容器中执行接口返回的安装脚本和复制命令，检查首次安装、重复安装后的进程凭据、旧凭据继续可用、迁移到全新主机及已有静态路由的预检和恢复下发。测试结束自动删除测试容器、网络和凭据，构建镜像保留作缓存。

更多运维说明见 [docs/README.md](docs/README.md)。
