# Peer 与 BGP 会话

Peer 是节点下的远端邻居定义；BGP 会话把节点、Peer、本地参数、Address Family 和路由策略组合成一个 BIRD BGP Protocol。

## 管理 Peer

进入“资源管理” > “eBGP 远端”。

| 字段 | 规则 |
| --- | --- |
| 所属节点 | 创建后不可移动到其它节点 |
| Peer 名称 | 1 到 80 个字符，仅用于显示 |
| 邻居地址 | 有效 IPv4、IPv6 或带 Scope 的 IPv6 Link-local 地址 |
| 远端 ASN | 1 到 4294967295 |
| BGP 端口 | 默认 179 |

新增 Peer 只写入库存，不部署节点，因为此时还没有 BGP 会话。编辑已被会话引用的 Peer 会重新生成并部署该节点配置。删除 Peer 前必须先移除它的会话。

## 创建或编辑会话

进入“会话与拓扑”，依次选择节点和 Peer。

### 基础字段

- “BIRD 协议名称”：同一节点内唯一，只能使用字母、数字和下划线，并以字母或下划线开头；
- “启用会话”：关闭并应用后，该 Protocol 不再出现在生成配置中；
- “本地地址”：默认留空，由 BIRD 自动选择；
- “本地 ASN”：必须与远端 ASN 不同；
- “本地端口”：默认 `179`。

只有在必须固定源地址、多地址主机、VRF 或 IPv6 Link-local 场景才显式填写本地地址。显式本地地址必须与 Peer 地址属于同一地址族且不能相同。

## Address Family

IPv4 和 IPv6 Channel 独立配置，至少启用一个。Peer 传输地址的地址族不限制可交换的 NLRI 地址族，例如 IPv6 传输上仍可按双方能力启用 IPv4 Channel。

每个 Channel 都有独立的：

- 导入策略；
- 导出策略；
- Import、Receive、Export Limit；
- Table、Preference、Next Hop、Gateway、Add Paths、GR 等高级参数。

## 导入与导出策略

每个方向有“可视化”和“自定义”两种模式。

### 可视化模式

基础动作：

| 方向 | 可选动作 |
| --- | --- |
| Import | 导入所有、不导入 |
| Export | 不导出、导出所有、导出指定 CIDR Define |

可在基础动作前插入多个 Function 步骤。每个步骤可以：

- `execute`：执行 Function 后继续；
- `accept`：Function 返回 true 时接受路由；
- `reject`：Function 返回 true 时拒绝路由。

步骤顺序会改变结果。把最终接受或拒绝动作放在最后，并在预检生成配置中核对实际 Filter。

“+ 属性动作”可以生成节点级 Function 并插入当前策略：

- Import：设置 Local Preference、修改 Standard/Large Community；
- Export：AS prepend、修改 Standard/Large Community；
- 条件可以直接引用当前节点可用的 Define；
- AS prepend 支持本地 ASN 或自定义 ASN，次数为 1 到 20。

生成 Function 会立即作为资源部署，但当前会话草稿仍需点击“预检配置”或“应用会话变更”。

### 自定义模式

自定义模式选择一个完整 Filter：

```bird
filter export_customer
{
  if net ~ CUSTOMER_PREFIXES then accept;
  reject;
}
```

Filter 必须已启用，且作用域为所有节点或当前节点。选择自定义 Filter 后，表单基础动作和 Function 步骤不参与该方向的生成配置。

## 安全的默认策略

新会话推荐：

- Import：在测试环境可临时“导入所有”，生产环境应尽快增加前缀、RPKI 和路由属性限制；
- Export：默认“不导出”，确认 Prefix Define 后改为“导出指定 CIDR Define”；
- 为 Import、Receive、Export 设置合理 Limit；
- 在对端和本端同时确认 Address Family 后再启用。

“导出所有”会把 Channel 可见路由全部交给 BIRD 导出处理，只有在明确了解路由表内容和上游策略时使用。

## Direct、Multihop 和 Link-local

Direct 适用于直连邻居。Multihop 适用于非直连邻居，必须设置合理 TTL。

Multihop 不允许：

- 启用 Check Link；
- 绑定 Interface；
- 启用 Onlink；
- 使用 Channel `gateway direct`。

IPv6 Link-local 地址只能用于 Direct 会话，并必须通过地址 Scope（例如 `%eth0`）或 Interface 指定接口。两端 Scope 与 Interface 必须一致。

## BFD、认证和计时器

- BFD 支持关闭、启用、Graceful 和 Custom；Custom 必须填写有效 BFD Session 指令；
- TCP 认证支持无认证、MD5 和 TCP-AO；只有对应模式可以填写密码或 Keys；
- Hold Time 可留空使用 BIRD 默认值，显式值只能为 0 或 3 到 65535；
- Keepalive 不能大于有效 Hold Time；
- TTL Security、Passive、Strict Bind、Free Bind 等应与对端和网络设计一致。

认证密钥会进入库存和生成配置。不要在截图、日志转发或公开 Issue 中泄露。

## 预检配置

点击“预检配置”时，Birdbox 会：

1. 把当前草稿合并到库存副本；
2. 生成该节点全部已启用资源和会话的完整 Include；
3. 通过 SSH 在目标节点执行完整主配置检查；
4. 在“节点配置”显示候选内容。

预检不会保存会话。页面也会在字段修改后进行静默自动预检，但正式应用前仍应手动预检并阅读候选配置。

## 应用会话变更

点击“应用会话变更”并确认后：

1. 再次执行预检；
2. 写入部署恢复日志并取得部署锁；
3. 切换目标节点 Include；
4. 执行 `configure check` 和 `configure`；
5. 成功后提交库存；
6. 最多等待约 25 秒观察 Protocol 状态。

在观察窗口内没有 Established 会返回“正在等待远端 Peer”，但配置已经成功应用。继续通过刷新和 BIRD 日志排查对端。

## 停止、启动、停用和移除

| 操作 | 是否改库存 | 是否改生成配置 | 用途 |
| --- | --- | --- | --- |
| 停止当前会话 | 否 | 否 | 临时执行 BIRD `disable` |
| 启动当前会话 | 否 | 否 | 临时执行 BIRD `enable` |
| 关闭“启用会话”并应用 | 是 | 是 | 持久停用 Protocol |
| 移除当前会话 | 是 | 是 | 从库存和节点配置中删除会话 |

移除会话不会删除 Peer，也不会删除节点级 Static 资源。

## 失败与回滚

候选配置失败时不会提交库存。部署已经开始但库存提交失败时，Birdbox 会尝试回滚节点。容器意外停止后，下次启动会根据持久部署日志继续完成提交或回滚。

出现失败后不要连续重复点击。等待页面恢复交互，刷新当前节点，查看变更日志、容器日志和目标 BIRD 日志，再决定下一步。
