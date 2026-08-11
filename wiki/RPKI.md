# RPKI

Birdbox 支持两类 RPKI 资源：目标节点本地 ROA 文件，以及远程 RPKI-RTR Cache。RPKI 资源负责声明 ROA Table 和数据源，实际路由验证逻辑应在 Function 或 Filter 中使用 `roa_check()` 实现。

## 通用字段

| 字段 | 说明 |
| --- | --- |
| 可用范围 | 所有节点，或多选一个及以上指定节点 |
| 显示名称 | 页面显示用途 |
| BIRD 名称 | RPKI Protocol 或本地 ROA 资源名称 |
| IPv4 ROA Table | 可选；填写后必须配置对应 IPv4 数据源 |
| IPv6 ROA Table | 可选；填写后必须配置对应 IPv6 数据源 |
| 启用资源 | 停用后不写入节点配置 |

IPv4 和 IPv6 至少启用一个 ROA Table，两个 Table 名称必须不同，并且不能与节点上其它 BIRD 标识符冲突。

## 本地 ROA 文件

选择“本地 ROA 文件”，填写目标 BIRD 节点上的绝对路径：

```text
/etc/bird/roa4.conf
/etc/bird/roa6.conf
```

路径指向目标节点，不是 Birdbox 容器。Birdbox 不上传或更新 ROA 文件，只在生成配置中引用它们。文件必须由节点上的外部同步流程维护，并允许 BIRD 进程读取。

如果填写 IPv4 ROA Table，就必须填写 IPv4 ROA 文件；未启用某地址族 Table 时不能单独填写对应文件。

## RPKI-RTR 服务器

选择“RPKI-RTR 服务器”，填写：

- 服务器 IP 或主机名；
- 端口，TCP 默认 `323`，SSH 默认 `22`；
- 可选本地源地址；
- Refresh、Retry、Expire；
- RTR 最低和最高版本；
- 是否忽略 ROA Max Length；
- TCP 或 SSH 传输。

时间字段留空时使用 BIRD 默认值。显式范围：

| 字段 | 范围 |
| --- | --- |
| Refresh | 1 到 86400 秒 |
| Retry | 1 到 7200 秒 |
| Expire | 600 到 172800 秒 |
| RTR Version | 0 到 2，最低值不能高于最高值 |

`Keep Refresh`、`Keep Retry`、`Keep Expire` 会在生成指令中保留相应状态，只有理解目标 BIRD 行为时启用。

## TCP 传输

TCP 可选择无认证或 TCP-MD5。选择 MD5 时必须填写密码，长度不超过 80 个字符。

编辑已有 MD5 资源时，密码框留空会保持现有密码；切换为无认证会清除库存中的该密码。

密码属于敏感路由凭据，会写入库存和生成配置。不要在公开截图或 Issue 中展示。

## SSH 传输

RPKI-RTR 的 SSH 传输由目标节点上的 BIRD 进程直接使用，与 Birdbox 控制器 SSH 身份无关。需要填写目标节点可访问的：

- BIRD 私钥绝对路径；
- 远端公钥或 Host Key 文件绝对路径；
- SSH 用户名。

这些文件必须存在于目标 BIRD 节点，权限应允许 BIRD 进程读取。SSH 传输不能同时配置 TCP-MD5。

## 在 Filter 中使用

示例仅展示常见结构，具体参数以目标 BIRD 版本为准：

```bird
filter rpki_import_v4
{
  case roa_check(ROA4_MAIN, net, bgp_path.last) {
    ROA_VALID: accept;
    ROA_INVALID: reject;
    else: accept;
  }
}
```

生产策略通常对 `ROA_UNKNOWN` 和无法取得 Origin ASN 的情况单独处理。不要直接复制示例到生产，先在测试 Peer 上确认路由分类和业务政策。

## 作用域和引用

全局 RPKI 会部署到所有节点，因此本地 ROA 文件路径必须在每个节点都有效，远端 Cache 也必须从每个节点可达。路径或网络环境不同的节点应选择“指定节点”，并只勾选具备相同文件和网络条件的节点。

作用域从多个节点缩小时，Birdbox 会同时预检旧、新作用域，确保被移除节点能安全撤下对应声明。指定节点列表不能为空。

Function、Filter 或 Static 自定义源码引用 ROA Table 时，其作用域必须完全包含在 RPKI 资源作用域内。Birdbox 会沿 Function 等中间资源递归检查；即使 Filter 没有直接写出 Table 名称，也不能通过间接 Function 绕过作用域限制。新增节点同样会重新检查全局策略的完整依赖链。

如果 Function、Filter、Define 或 Static 自定义源码引用 RPKI 名称或 ROA Table，Birdbox 会阻止删除或危险改名。先更新引用者，再修改 RPKI 资源。

## 保存与验证

保存 RPKI 会对所有受影响节点执行完整配置预检和部署。预检能发现 BIRD 语法、文件 Include 和标识符问题，但不能保证：

- 本地 ROA 文件会持续更新；
- RPKI Cache 长期可达；
- Cache 返回的数据符合预期；
- Filter 的业务决策正确。

部署后应在目标节点检查 RPKI Protocol 状态、ROA Table 数量和相关 BIRD 日志。

## 最佳实践

- 至少配置两个独立 RPKI Cache，并在策略设计中考虑单个 Cache 故障；
- 本地 ROA 文件使用原子替换，更新后按 BIRD 支持方式触发重载；
- 不要因为 RPKI 数据源暂时不可达就自动放行或拒绝所有路由，先定义明确的降级政策；
- 对 `ROA_INVALID` 的拒绝策略先在监控模式验证；
- 为 IPv4、IPv6 使用清晰且唯一的 Table 名称；
- 把 RPKI 凭据和真实策略视为敏感数据。
