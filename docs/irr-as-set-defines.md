# IRR AS-SET 动态 Define 开发计划

## 目标

Birdbox 的 IPv4/IPv6 CIDR Define 支持两种来源：

- 手工条目；
- 通过指定 IRR AS-SET 定期展开得到的动态条目。

动态 Define 与手工 Define 使用相同的 BIRD 名称、节点作用域和依赖关系，可以直接用于会话 Import/Export、Function、Filter、Static 和源地址出口策略。AS-SET 数据属于 IRR 信息，不能替代 RPKI Origin Validation。

## 第一阶段范围

第一阶段使用 `bgpq4` 作为展开后端。Birdbox 使用参数数组启动进程，不经过 Shell，并限制执行时间和输出体积。业务层通过 Resolver 接口调用 `bgpq4`，以后可以增加 IRRd GraphQL Provider。

官方 Docker 镜像内置 `bgpq4`。直接从源码运行控制器时，需要在控制器主机安装 `bgpq4`；受管 BIRD 节点不需要安装，因为 IRR 查询和解析只在控制器执行。

动态 Define 必须使用独立文件分发，不允许把展开后的 Prefix Set 内联到主生成配置。每个受管节点的布局如下：

```text
generated.conf -> versions/generated.conf.<hash>.conf
resources/
  define_<resource-id>.conf -> versions/define_<resource-id>.<hash>.conf
  versions/
    define_<resource-id>.<hash>.conf
```

主生成配置只包含稳定的 Include：

```bird
include "/var/lib/birdbox/resources/define_<resource-id>.conf";
```

独立片段包含完整声明：

```bird
define CUSTOMER_V4 = [
  192.0.2.0/24,
  198.51.100.0/24
];
```

## 数据模型

原有 CIDR Define 没有来源字段时按手工来源读取，保证旧库存兼容。动态 Define 保存最近一次成功部署的快照：

```ts
interface IrrAsSetDefineSource {
  kind: "irr-as-set";
  asSet: string;
  server: string;
  databases: string[];
  refreshIntervalSeconds: number;
  prefixLimit: number;
  allowMoreSpecific: boolean;
}

interface CidrDefine {
  type: "cidr4" | "cidr6";
  entrySource: { kind: "manual" } | IrrAsSetDefineSource;
  entries: string[];
  sync: {
    status: "never" | "ready" | "error";
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextRefreshAt: string | null;
    error: string | null;
    contentHash: string | null;
  };
}
```

`prefixLimit` 允许用户自行设置。控制器仍设置绝对安全上限，防止错误 AS-SET 或恶意 IRR 响应耗尽内存、数据库和节点磁盘。第一阶段计划的绝对上限为 100000 条，输出体积上限为 16 MiB；实际生产建议值由节点压力测试决定。

## 展开规则

调用示意：

```text
bgpq4 -h <server> -S <databases> -4|-6 -j -l prefixes <AS-SET>
```

Birdbox 不直接采用 `bgpq4` 生成的 BIRD 源码，而是解析其结构化前缀数组，再执行：

注意：不能添加 `-t`。`bgpq4 1.12` 的 `-j -t` 输出的是 AS 号集合，而 `-j` 才输出包含 `prefix` 和 `exact` 字段的前缀数组。

1. 地址族校验；
2. CIDR 规范化；
3. 去重和稳定排序；
4. 用户上限与绝对上限校验；
5. 可选的 `+` 更具体匹配转换；
6. BIRD 片段生成。

默认保留 IRR 返回的精确前缀，不做聚合，也不允许更具体前缀。`allowMoreSpecific` 由用户显式开启。

## 同步和原子部署

抓取 IRR 数据时不持有部署锁。得到候选快照后：

1. 重新读取最新库存；
2. 确认 Define 配置没有在抓取期间变化；
3. 构造包含新快照的候选库存；
4. 递归检查资源依赖、作用域和循环；
5. 为受影响节点上传新的哈希资源片段和主候选配置；
6. 使用完整 BIRD 配置执行 `configure check`；
7. 所有节点预检通过后原子切换资源链接和主配置；
8. BIRD reload 成功后提交库存；
9. 任一节点失败则恢复旧资源链接和旧主配置。

展开失败、空结果、超限、依赖校验失败或节点预检失败时，不修改当前 `entries`，继续使用最近一次成功快照。

## API 和调度

- `POST /api/defines/irr/resolve`：测试展开，不写库存、不部署；
- `POST /api/defines/:id/sync`：立即同步并部署；
- 后台调度器按 `refreshIntervalSeconds` 到期刷新；
- 多实例通过数据库命名锁串行化同一 Define 的同步；
- 内容哈希不变时不部署，仅更新检查状态；
- 普通成功检查不写变更日志，内容变化、失败和恢复才记录。

## 界面

Define 类型仍为 IPv4 CIDR、IPv6 CIDR、表达式。CIDR 类型增加“条目来源”：

- 手工填写；
- AS-SET 自动展开。

AS-SET 表单包括名称、IRR Server、Database、刷新间隔、用户前缀上限和允许更具体。界面展示当前快照条数、最近成功时间、下次刷新、错误信息，并提供“测试展开”和“立即同步”。动态条目列表只读，可搜索和复制。

## 测试与验收

自动化测试覆盖：

- `bgpq4` 参数与输出解析；
- IPv4/IPv6 分离、去重、上限和超时；
- 旧 Define 数据迁移；
- 独立片段路径、哈希和 Include；
- 更新失败保留旧快照；
- 多节点预检、提交和回滚；
- 调度去重与内容不变跳过部署；
- UI 创建、测试展开、同步和状态展示。

实机验收使用本机和一台隔离的远端测试节点：

1. 安装并确认 `bgpq4`；
2. 创建应用于两个节点的动态 Define；
3. 从公共 IRR 展开一个测试 AS-SET；
4. 确认两个节点都生成独立片段，主配置只有 Include；
5. 确认 BIRD 成功加载且 Define 可用于会话 Filter；
6. 修改来源或触发同步，确认哈希版本切换；
7. 模拟展开失败，确认旧片段和旧快照继续生效。

仓库提供可重复的多节点调度验收脚本。目标必须是允许创建临时用户和启动隔离 BIRD 实例的测试机，脚本结束时会自动清理：

```bash
IRR_E2E_SSH_TARGET=test-router scripts/irr-multinode-e2e.sh
```
