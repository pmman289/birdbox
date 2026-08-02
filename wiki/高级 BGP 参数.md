# 高级 BGP 参数

Birdbox 的高级配置按 BIRD 2.19.1 设计。空值或“默认”通常表示不生成该指令，由 BIRD 使用默认行为。除非网络设计、对端能力和目标版本都已确认，否则保留默认值。

## 常用会话参数

| 字段 | 用途 | 关键限制 |
| --- | --- | --- |
| Direct | 直连 eBGP | 适合同链路 Peer |
| Multihop | 非直连 eBGP | 需要 TTL；不能绑定 Interface、Check Link On、Onlink 或 `gateway direct` |
| BFD | 快速故障检测 | 对端和本地必须都配置；Custom 必须填写 BFD 参数 |
| Hold Time | BGP Hold Timer | 留空使用默认；显式值只能为 0 或 3 到 65535 |
| Keepalive | Keepalive Timer | 不能大于有效 Hold Time |
| Passive | 只等待对端连接 | 适合由对端主动建立的场景 |
| TTL Security | GTSM | 双方跳数和配置必须匹配 |

不要为了加快收敛盲目降低计时器。CPU 繁忙、链路抖动或控制面拥塞时，过短计时器会放大故障。

## 连接与套接字

### Description

写入 BGP Protocol 的说明，适合记录工单号、链路或对端用途。不要写密码、联系人隐私或其它敏感信息。

### Router ID

这是会话级 BGP `router id`，与节点资产页面中的 Router ID 不同。留空时使用系统 BIRD 的 Router ID。只有需要该 Protocol 使用不同 Router ID 时填写有效 IPv4。

### VRF

填写 `default` 或 VRF 名称。目标 BIRD 必须已具备对应 VRF 环境，Birdbox 不创建 Linux VRF 或路由表。

### Interface

把 Direct 会话绑定到指定接口。Multihop 不允许填写。IPv6 Link-local 会话必须通过 Interface 或地址 `%scope` 明确接口。

### TCP Authentication

- `none`：不生成认证；
- `md5`：必须填写不超过 80 字符的 Password；
- `ao`：必须填写完整 TCP-AO Keys Block。

`Setkey` 控制 BIRD 是否尝试配置内核密钥。TCP-AO、MD5 和 Setkey 的可用性取决于目标内核、BIRD 构建和权限。

### Strict Bind 与 Free Bind

它们影响本地 Socket 绑定方式。只有在多地址、非本地源地址或明确的内核绑定需求下修改。启用 Free Bind 前应确认内核支持和安全边界。

### Onlink 与 Check Link

Onlink 用于把邻居视为直连。主动 Onlink 会话必须指定 Interface；Multihop 不允许使用。Check Link 依赖接口链路状态，Multihop 不能强制启用。

## BFD

| 模式 | 说明 |
| --- | --- |
| 关闭 | 不生成 BFD |
| 启用 | 使用普通 BFD |
| Graceful | BFD 故障按 Graceful 行为处理 |
| Custom | 使用自定义 Session Options |

Custom 示例：

```bird
interval 300 ms;
multiplier 3;
```

实际最小间隔应根据链路、设备性能和 BFD 对端协商结果确定。

## eBGP 属性与角色

| 字段 | 说明 |
| --- | --- |
| Local Role | RFC 9234 BGP Role：provider、rs_server、rs_client、customer、peer |
| Require Roles | 要求对端支持并交换 Role；必须先设置 Local Role |
| Route Server Client | 生成 `rs client` |
| Allow Local AS | 允许本地 ASN 在 AS_PATH 出现，可填次数或 `all` |
| Allow AS_SET | 显式允许或拒绝 AS_SET |
| Confederation ASN | 配置 Confederation ASN |
| Confederation Member | 声明成员；必须先填写 Confederation ASN |
| Allow Local Pref | 允许从 eBGP 接收 `bgp_local_pref` |
| Allow MED | 允许从 eBGP 接收 `bgp_med` |
| Enforce First AS | 检查 AS_PATH 首个 ASN |

Role、Route Server、Confederation 和 AS_PATH 放宽选项会改变路由泄露防护边界。必须与对端合同和路由策略一起评审。

## 能力与重启

### Route Refresh

`Route Refresh` 和 `Enhanced Route Refresh` 可设为默认、启用或关闭。`Require` 表示如果对端没有相应能力就拒绝会话。

限制：

- 关闭 Route Refresh 时不能启用 Enhanced Route Refresh；
- Require Enhanced 需要 Route Refresh 与 Enhanced 都未关闭；
- 关闭 Capabilities 时不能要求任何远端能力。

### Graceful Restart 与 LLGR

GR、LLGR 支持默认、Aware、启用和关闭，并可设置 Restart/Stale Time 及最小最大范围。

- GR 时间最大 4095 秒；
- LLGR Stale Time 最大 16777215 秒；
- 最小值不能大于最大值；
- LLGR 依赖 GR；
- Require LLGR 需要 GR 和 LLGR 都未关闭。

GR 会保留失联 Peer 的路由。错误配置可能延长黑洞时间，应和数据平面转发连续性一起评估。

### AS4、Extended Messages、Hostname

每项都可启用能力，并可选择 Require。Require 必须建立在本端相应能力已启用的基础上。对未知或旧设备不要轻易启用 Require。

### Well-known Community

控制是否解释 Well-known Community。改变默认行为前应确认 NO_EXPORT、NO_ADVERTISE 等社区的运营政策。

### Disable After Error / Cease

出现协议错误或 Cease 后保持禁用，避免自动重连循环。启用后需要明确的监控和人工恢复流程。

## 计时器与选路

| 字段 | 说明 |
| --- | --- |
| Min Hold / Min Keepalive | 接受对端计时器的下限 |
| Startup Hold | 建立初期 Hold Time |
| Send Hold Time | 发送方向超时，默认通常与 Hold 相关 |
| Connect Delay / Retry | TCP 连接延迟和重试间隔 |
| Error Wait Min / Max | 错误退避范围；必须成对填写且下限不大于上限 |
| Error Forget | 错误历史遗忘时间 |
| Path Metric | 使用 AS Path Metric |
| MED Metric | 把 MED 作为度量处理 |
| Deterministic MED | 对 MED 比较使用确定性分组 |
| IGP Metric | 将 IGP Metric 纳入选路 |
| Prefer Older | 偏好较早建立的路径 |
| Default MED | 默认 `bgp_med` |
| Default Local Pref | 默认 `bgp_local_pref` |

选路参数会影响整个 Peer 的最佳路径计算。修改前应构造至少包含多上游、多路径和故障切换的测试案例。

## Channel 限制

IPv4 和 IPv6 Channel 分别支持 Import、Receive 和 Export Limit：

| Limit | 统计范围 |
| --- | --- |
| Import Limit | 通过 Import Filter 后导入的路由 |
| Receive Limit | 从协议收到的路由，可能包含被过滤路由 |
| Export Limit | 准备导出的路由 |

每个 Limit 可选择：

- `warn`：记录警告；
- `block`：阻止继续接收或导出；
- `restart`：重启协议；
- `disable`：禁用协议。

生产建议先使用 `warn` 观察正常峰值，再设定有余量的硬限制。直接使用过低的 `disable` 会在路由增长时中断会话。

## Channel 路由表

| 字段 | 说明 |
| --- | --- |
| Table | 指定 Channel 使用的 BIRD Table |
| Preference | 该 Channel 路由 Preference |
| Keep Filtered | 保留被 Import Filter 拒绝的路由用于观察 |
| RPKI Reload | RPKI 数据变化时是否重跑 Import Filter |
| Import Table | 使用独立 Import Table |
| Export Table | 使用独立 Export Table |
| Secondary | 允许尝试次优路由进行导出 |
| Mandatory | 把 Channel 能力设为强制 |

自定义 Table 必须已在主配置或其它 Include 中正确声明。Birdbox 不自动创建普通 IPv4/IPv6 Table。

## Next Hop 与 Gateway

| 字段 | 说明 |
| --- | --- |
| Next Hop Keep | 保留收到或发送的 Next Hop，可按全部、iBGP、eBGP选择 |
| Next Hop Self | 把 Next Hop 改为本机，可按全部、iBGP、eBGP选择 |
| Next Hop Address | 显式指定 Next Hop 地址 |
| Next Hop Prefer | IPv6 Global 或 Link-local 偏好 |
| Link-local Next Hop Format | IPv6 Native、Single、Double |
| Gateway | 自动、direct 或 recursive |
| IGP Table | 递归解析 Next Hop 使用的 IGP Table |

Next Hop Keep 和 Next Hop Self 不能同时以非默认、非关闭模式启用。Multihop 不能使用 `gateway direct`。

## Add Paths、Extended Next Hop 和 AIGP

- Add Paths 支持关闭、RX+TX、仅 RX、仅 TX；Require Add Paths 需要先启用 Add Paths；
- Extended Next Hop 可在 IPv4 Channel 启用和 Require；Require 需要先启用；
- AIGP 支持默认、启用、Originate 和关闭；
- Cost 必须是大于等于 1 的整数；
- Channel 级 GR、LLGR 和 Stale Time 可覆盖对应 Address Family 行为。

这些能力需要对端支持。先启用，再观察协商能力，最后才考虑 Require。

## 额外 BIRD 指令

Protocol Block 和 Channel Block 可以填写界面未覆盖的 BIRD 指令。内容会原样缩进到当前配置块中。

Birdbox 会限制源码长度、空字符、未闭合引号或花括号，并阻止跳出外层配置块，但不会理解每条自定义指令的业务含义。

最佳实践：

1. 优先使用结构化字段。
2. 每段 Raw 配置只解决一个明确需求。
3. 在代码评审中检查目标 BIRD 版本兼容性。
4. 手动预检并阅读生成配置。
5. 不在 Raw 中写入完整外层 `protocol` 或 `channel` 声明。
