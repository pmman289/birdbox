# 源地址出口映射

Birdbox 的“源地址出口映射”用于把一批 IPv4 源 CIDR 映射到一个或多个远端出口地址，并把同一映射集下发到指定节点。它适用于 WireGuard、OSPF 或其它动态 IGP 网络：出口地址不是必须直连的网关，BIRD 会在 `master4` 中递归解析实际下一跳。

## 资源模型

一个映射集包含：

- 下发节点范围；
- 一个或多个出口组；
- 每个出口组的出口 IPv4 地址和源 IPv4 CIDR 列表；
- 可选的内部 IPv4 CIDR Define，用于让内部目的路由优先于策略表默认路由。

例如：

```json
{
  "172.20.177.36": [
    "162.141.136.139/32",
    "162.141.136.138/32"
  ],
  "172.20.177.38": [
    "82.47.33.189/32"
  ]
}
```

Birdbox 自动分配 BIRD table 名、Protocol 名和 `ip rule` priority。每个出口组的 Linux kernel table 默认从 200–10000 中自动选择；如果节点已有路由表，可在出口组中手工填写 1–2147483647 的 table ID（不能使用 0、253、254、255，也不能与节点已有策略冲突）。

为避免递归出口地址被源策略表再次接管，Birdbox 会为每个出口地址额外生成一条优先级更高的目的地址例外规则，将该地址固定查询 Linux `main` 表：

```sh
ip -4 rule add priority 9xxx to 172.20.177.36/32 table main
ip -4 rule add priority 10xxx from 162.141.136.139/32 table 200
```

同一节点上共享出口地址的映射会合并目的地址规则。新建或修改映射时，如果新增的出口地址落在任意源 CIDR 内，Birdbox 会拒绝保存并提示拆分 CIDR 或更换出口地址；历史库存中的此类配置仍可加载，便于先升级旧 SSH 节点为 Agent，再由 Agent 接管并补齐例外规则。

## BIRD 生成方式

每个出口组生成：

```bird
ipv4 table bb_spe_t_xxx;

protocol static bb_spe_s_xxx {
  ipv4 { table bb_spe_t_xxx; };
  igp table master4;
  route 0.0.0.0/0 recursive 172.20.177.36;
}

protocol kernel bb_spe_k_xxx {
  kernel table 200;
  ipv4 {
    table bb_spe_t_xxx;
    import none;
    export all;
  };
}
```

启用“复制内部路由”后，Birdbox 还会为每个出口组生成 Filter 和 Pipe，将选中的 IPv4 CIDR Define 从 `master4` 复制到策略表。

不会生成 `persist;`。资源被删除或停用时，BIRD 应撤销它写入的内核路由，避免残留路由与 Birdbox 库存脱节。

## Linux 和 OpenWrt 操作

Agent 节点确认应用映射集后会自动执行并持久化同步 `ip rule`，不需要用户手工登录节点。规则快照保存在 `/etc/birdbox/source-policy-rules.json`（0600，适用于 OpenWrt 持久目录）；Agent 启动时无需连接控制器即可恢复。操作前先持久化恢复记录，失败时恢复上一份本地已提交快照；未完成清理会在启动时重试。读取规则优先使用 JSON，不支持 JSON 的 BusyBox `ip` 使用只读文本解析。其它工具占用同一优先级且含不同选择器时，Agent 报错保留原规则，避免误删。

旧 SSH 节点仍保留脚本/LuCI 兼容计划，但会明确提示先升级为 Agent；新建映射不能选择旧 SSH 节点。本机 local 节点提供手工脚本，不能把“本机”误认为 Agent 自动管理。升级旧节点时，Agent 会先按现有映射接管已有规则，后续修改由 Agent 自动维护。

Linux 节点提供幂等 root 脚本，脚本仅删除同一映射集上一次已知的精确规则，再添加当前规则：

```sh
ip -4 rule add priority 31504 from 162.141.136.139/32 table 200
```

需要重启后恢复时，直接以 root 执行“systemd 安装/更新脚本”。脚本会写入 `/usr/local/lib/birdbox/source-policy-<id>.sh`、`/etc/systemd/system/birdbox-source-policy-<id>.service`，执行 `daemon-reload`、`enable` 和 `restart`。更新映射后重新执行新脚本即可；删除或停用映射时执行界面提供的 systemd 卸载脚本。

只有尚未升级的旧 SSH OpenWrt 节点才显示 LuCI 的 IPv4 Rules 参数清单：Priority、Source、Destination（出口例外规则）和 Lookup table。Agent OpenWrt 节点使用结构化 RPC 自动更新规则，不需要手工操作。

删除或停用映射集后，Agent 会自动清理对应规则；旧 SSH 节点仍需按兼容计划执行清理脚本或在 LuCI 删除相同规则。

## 编辑与运行态

编辑默认只生成草稿示意；点击“预检并查看变更”才执行完整服务端预检，展示节点配置差异和系统规则计划。确认应用使用同一规范化候选、资源/出口组 ID、表和优先级分配，绑定库存 revision；编辑后预检失效。失败保留草稿，版本冲突可对比远端并明确保留或采用远端。保留旧内容后以最新远端配置为保存基线，避免错误标成已保存。

列表的“运行态”及编辑器的“查看已保存运行态”独立读取已保存配置，不替换草稿。可按节点、出口组查看：

- Static / Kernel / 内部 Pipe 的真实协议状态，缺失协议和节点错误分别显示；协议 Up 不代表默认路由已安装。
- 实际 `ip rule` 与配置的符合数量、缺失和异常残留，以及 Agent 恢复快照状态。共享网关例外仍被其它映射使用时，不误报为残留。
- Linux 已安装路由与 BIRD 策略表路由，二者单独显示；BIRD 支持目标 IPv4 查询，表名只能由已保存出口组解析，最多显示 200 条。

本机即为该出口的组明确显示跳过，使用正常底层路由；不会凭空显示已生成的协议或路由。旧 Agent 不支持只读规则检查时提示升级，仍保留 BIRD 协议结果。SSH/local 系统运行态使用系统的 JSON `ip` 查询，缺少能力时显示检查错误，不伪造成功。

原生双版本验收包含控制器断开、清空内核规则后重启已安装 Agent。它证明启动恢复路径，不代表已测试物理设备断电重启或实际出口数据包交付。完整记录见 [source-policy-verification.md](source-policy-verification.md)。

## 校验和限制

- 只接受精确 IPv4 CIDR，例如 `198.51.100.1/32` 或 `198.51.100.0/24`；不接受 BIRD 的 `+`、`-`、`{min,max}` 扩展语法。
- 同一节点上，两个启用映射集不能使用重叠源 CIDR，也不能复用 Linux table 或规则 priority 范围。
- 同一映射集内，同一出口地址只能出现一次；源 CIDR 不能重叠。
- 远端出口地址必须能在节点的 `master4` 中解析为可用路由。BIRD 语法预检能验证生成配置，运行时仍应检查递归默认路由是否存在。
- 选择内部 CIDR Define 时，Define 的作用域必须覆盖映射集的全部下发节点；这一依赖会递归参与作用域和环路校验。

## 验证步骤

在每个目标节点上检查：

```sh
birdc show route table bb_spe_t_xxx
ip -4 route show table 200
ip -4 rule show
ip -4 route get 1.1.1.1 from <source-ip>
```

预期是策略表存在递归解析后的默认路由，`ip rule` 指向正确 table，`ip route get` 命中该 table。测试时若 `<source-ip>` 尚未配置到本机接口，Linux 可能拒绝该查询；可使用已配置的业务源地址完成验证。
