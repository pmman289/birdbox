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

Birdbox 不会自动执行 `ip rule` 或修改 OpenWrt UCI。保存映射集后，编辑器会按节点显示手工操作计划，并为 Linux 节点生成完整的 systemd unit 和安装/更新脚本。

Linux 节点提供幂等 root 脚本，脚本仅删除同一映射集上一次已知的精确规则，再添加当前规则：

```sh
ip -4 rule add priority 31504 from 162.141.136.139/32 table 200
```

需要重启后恢复时，直接以 root 执行“systemd 安装/更新脚本”。脚本会写入 `/usr/local/lib/birdbox/source-policy-<id>.sh`、`/etc/systemd/system/birdbox-source-policy-<id>.service`，执行 `daemon-reload`、`enable` 和 `restart`。更新映射后重新执行新脚本即可；删除或停用映射时执行界面提供的 systemd 卸载脚本。

OpenWrt 节点显示 LuCI 的 IPv4 Rules 参数清单：Priority、Source 和 Lookup table。更新或停用时，清单会先列出需要删除的旧规则，再列出当前规则；必须按该顺序操作。不同 LuCI 版本的菜单名称可能略有差异；如果没有对应页面，可用清单中的值配置等价的 `ip rule`。

删除或停用映射集后，先执行编辑器提供的清理脚本或在 LuCI 删除相同规则。否则会残留无主 `ip rule`。

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
