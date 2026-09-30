# Birdbox Agent

Agent 是受管节点的主动连接模式。节点上的 `birdbox-agent` 以 root 身份运行，只向主控发起 HTTPS/HTTP 长轮询连接；主控不需要能够从公网 SSH 进入节点。现有 SSH 节点仍然完全兼容。

## 新建 Agent 节点

1. 在节点管理中点击“添加节点”，填写节点名称、Router ID、BIRD 主配置、生成配置和 Socket 路径。新建节点默认且只能使用 Agent；页面不再提供 SSH 新建选项。
2. 点击“生成准备脚本”，复制页面提供的一键命令并在目标 Linux/OpenWrt 节点以 root 执行；命令会从主控短期 URL 下载脚本。目标节点无法访问主控时，也可以复制下方完整脚本离线执行。
3. 脚本会按节点架构下载并校验 SHA-256 后安装 Agent、生成 systemd unit 或 OpenWrt procd 服务、写入 `/etc/birdbox/agent.env`，并为 BIRD 增加生成配置 include。
4. 等待 Agent 注册后点击“测试连接”，确认通过后保存节点。

主控生成脚本时使用 `BIRDBOX_PUBLIC_URL` 作为节点回连地址。生产环境必须把它设置为节点可达的主控 URL，不能使用监听地址 `0.0.0.0`。当该 URL 使用 `https://` 时，生成脚本会自动写入 `BIRDBOX_AGENT_REQUIRE_HTTPS=true`，Agent 会拒绝降级到明文 HTTP。

一键命令使用 `curl` 或 `wget` 配合 POSIX `sh`，兼容默认没有 `bash` 的 OpenWrt。脚本分发 URL 使用随机令牌，15 分钟后失效且最多下载 3 次；不要把 URL 发布到工单、聊天记录或日志中，失效后从页面重新生成即可。

## 旧 SSH 节点升级

编辑旧 SSH 节点，点击“生成 Agent 升级脚本”，在节点上执行脚本。脚本不会删除旧 SSH 配置。确认 Agent 在线后点击“切换为 Agent”，主控才会把后续预检、应用、回滚和状态采集切换为 Agent 通道。

切换失败时保留原 SSH 节点配置，重新执行升级脚本或从节点管理继续使用 SSH，不会影响已有 BIRD 会话。

## Agent RPC

Agent 使用以下主控接口：

- `POST /api/agent/register`
- `POST /api/agent/heartbeat`
- `POST /api/agent/tasks/poll`
- `POST /api/agent/tasks/:taskId/result`
- `GET /api/agent/releases/latest/download?arch=<arch>`
- `GET /api/agent/releases/latest/checksum?arch=<arch>`

结构化方法包括 `system.info`、`bird.inspect`、`bird.validate`、`bird.stage`、`bird.apply`、`bird.rollback`、`bird.protocol`、`bird.routes` 和 `agent.self_upgrade`。旧功能暂时通过受限的 `legacy.exec` 兼容，命令长度、超时、输入和输出均有上限。

## 升级 Agent

在节点管理中编辑已接入的 Agent 节点，打开“Agent 版本”区域即可查看在线状态、当前版本和架构。点击“升级到当前版本”后，主控会按节点架构读取当前发布包的 SHA-256，并向 Agent 下发固定的控制器下载地址；Agent 下载到临时文件，校验摘要后原子替换二进制并重启服务。校验失败不会覆盖当前版本。升级过程中 BIRD 配置和会话不会被改动。

升级按钮只对在线 Agent 开放。旧 SSH 节点应先按上一节生成并执行 Agent 升级脚本，再切换管理方式；已切换的 Agent 节点无需再次执行脚本即可从节点管理页面升级。

## 安全要求

- Agent token 只在生成脚本和创建响应中显示一次，库存接口不返回明文 token。
- Agent 必须以 root 运行；服务文件和环境文件仅允许 root 读取。
- 生产环境建议使用 HTTPS，并限制主控发布二进制的下载地址。
- 自签名证书或私有 CA 场景，把 CA PEM 文件放到节点受 root 保护的路径，并在 `/etc/birdbox/agent.env` 增加 `BIRDBOX_CONTROLLER_CA_FILE=/etc/birdbox/controller-ca.pem`；随后重启 `birdbox-agent`。不要关闭证书校验来绕过错误。
- 旧 SSH 节点保持 SSH 管理时，不需要安装 Agent；两种模式可以在同一套 Birdbox 库存中并存。
