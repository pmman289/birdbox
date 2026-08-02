# Static 路由

Static 是节点级资源，不属于任何 BGP 会话。一个节点可以创建多个 IPv4 或 IPv6 Static Protocol，每个 Protocol 有独立的名称、Channel Import/Export 策略和自定义指令。

## 创建 Static

进入“资源管理” > “Static” > “添加 Static”。

| 字段 | 说明 |
| --- | --- |
| 所属节点 | 创建后不可移动；要换节点需删除重建 |
| 显示名称 | 页面显示用途 |
| BIRD 名称 | 节点内唯一的 Static Protocol 名称 |
| 地址族 | IPv4 或 IPv6 |
| CIDR Define | 仅显示作用域、状态和地址族兼容的 Define |
| Static Import | `all` 或 `none`，默认 `all` |
| Static Export | `all` 或 `none`，默认 `none` |
| 自定义指令 | 额外的 Static Protocol Block 内容 |
| 启用资源 | 关闭后不写入生成配置 |

Static 至少要有一种路由来源：选择 CIDR Define 生成标准路由，或者填写自定义 Static 指令。两者可以同时使用。

## 精确 CIDR 与扩展前缀

Static 标准路由只接受完整 CIDR：

```text
2a0a::/32
192.0.2.0/24
```

以下 BIRD 前缀集合语法不会生成 Static 路由：

```text
2400:cb00::/32+
2001:db8::/32{48,64}
10.0.0.0/8-
```

它们仍可保留在同一个 Define 中供 Filter 使用，Static 编辑器会自动筛选并只列出精确 CIDR。如果 Define 没有精确 CIDR，且没有自定义指令，表单会阻止保存。

## 逐前缀标准动作

选择 CIDR Define 后，页面显示精确 CIDR 列表。每个条目可以独立选择：

- `blackhole`；
- `reject`；
- `unreachable`；
- `prohibit`；
- `via <地址>`。

`via` 地址必须与 Static 地址族一致。IPv4 Static 不能使用 IPv6 Next Hop，反之亦然。

使用“统一设置动作”可以先批量设置所有条目，再逐条修改。例如：

| CIDR | 动作 |
| --- | --- |
| `192.0.2.0/24` | `blackhole` |
| `198.51.100.0/24` | `via 192.0.2.254` |
| `203.0.113.0/24` | `reject` |

生成结果类似：

```bird
protocol static birdbox_static4_customer {
  ipv4 {
    import all;
    export none;
  };
  route 192.0.2.0/24 blackhole;
  route 198.51.100.0/24 via 192.0.2.254;
  route 203.0.113.0/24 reject;
}
```

## Define 修改后的联动

Static 引用 Define，而不是复制一份 CIDR 列表。因此 Define 修改并保存后，引用它的 Static 会同步变化并部署：

- 删除的 CIDR 不再生成路由，对应逐条动作被清理；
- 保留的 CIDR 保留原逐条动作；
- 新增精确 CIDR 使用该 Static 最近一次“统一设置动作”保存的默认动作；
- 新增扩展前缀不会进入 Static；
- Define 改名不会影响基于内部 ID 的 Static 引用，但如果源码中按名称引用仍受引用保护。

修改被多个节点或 Static 引用的全局 Define 前，应先评估所有引用对象。

## 同一 CIDR 出现在多个 Static

同一节点、同一地址族内，同一 CIDR 可以被多个已启用 Static Protocol 引用，但标准路由动作必须完全一致。

允许：

```text
Static A: 192.0.2.0/24 blackhole, import all, export none
Static B: 192.0.2.0/24 blackhole, import none, export all
```

拒绝：

```text
Static A: 192.0.2.0/24 blackhole
Static B: 192.0.2.0/24 reject
```

Import/Export 策略可以不同，因为它们属于不同 Protocol 的 Channel 行为；相同前缀的路由动作不同会造成节点路由来源冲突，因此 Birdbox 在预检前阻止。

不同节点之间不比较 Static 动作，因为每个节点有独立路由表。

## Import 与 Export

Static Protocol 的 Import/Export 控制该 Protocol 与 BIRD 路由表之间的 Channel 行为，默认是：

```bird
ipv4 {
  import all;
  export none;
};
```

它不等于 BGP Peer 的导入导出策略。Static 路由是否最终发布给某个 Peer，仍由该 BGP 会话对应 Channel 的 Export Policy 决定。

通常保持 `import all`、`export none`。只有明确需要把路由表路由导入 Static Protocol 或进行特殊递归设计时才改变 Export。

## 自定义 Static 指令

可填写 BIRD Static Protocol 内部指令：

```bird
route 203.0.113.0/24 via 192.0.2.1;
```

自定义块可引用当前节点可用且已启用的 Define。不要填写外层 `protocol static` 声明或用 `}` 逃逸当前块，Birdbox 会阻止破坏外层结构的内容。

自定义指令不会进入逐前缀冲突分析，复杂场景必须依赖目标 BIRD 预检和人工评审。能用标准逐条动作表达时优先使用标准编辑器。

## 修改和删除

Static 保存会立即预检并部署所属节点。编辑时不能直接更换所属节点；删除后重新创建。

删除 Static 会从节点生成配置移除对应 Protocol，但不会删除它引用的 Define。删除 Define 前必须先删除或修改所有引用它的 Static。

## 最佳实践

- 每个 Static 按用途分组，例如 DDoS Blackhole、服务 Anycast、出口 Next Hop；
- BIRD 名称包含地址族和用途，例如 `birdbox_static6_anycast`；
- 避免在多个 Static 中重复同一 CIDR，除非确实需要不同 Channel Import/Export；
- 修改共享 Define 前导出引用清单并在维护窗口操作；
- `via` Next Hop 必须在节点上可达，Birdbox 只校验地址族和 BIRD 配置语法；
- 自定义指令应经过独立代码评审。
