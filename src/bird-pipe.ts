import type { AddressFamily, ChannelPolicy, Inventory, PipeProtocol, PipeTableReference, StaticProtocol, KernelProtocol } from "../packages/contracts/src/inventory.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import { sourcePolicyNames } from "./bird-source-policy.js";
import { assertValidation, normalizeEnum, normalizeId, normalizeLabel, normalizeMultiNodeResourceScope } from "./bird-normalize-common.js";
import { normalizeChannelPolicy } from "./bird-session.js";

export function normalizeRoutingTableReference(value: unknown, family: AddressFamily, fallback?: string, label = "Pipe"): PipeTableReference {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const name = normalizeId(input.name ?? fallback, `${label} 路由表名称`);
  const source = normalizeEnum(input.source, new Set(["existing", "managed"] as const), "existing", `${label} 路由表来源`);
  assertValidation(name !== "master4" || family === "ipv4", `${label} 的 master4 只能用于 IPv4`);
  assertValidation(name !== "master6" || family === "ipv6", `${label} 的 master6 只能用于 IPv6`);
  assertValidation(source !== "managed" || !["master4", "master6"].includes(name), "内置路由表不能重复创建");
  assertValidation(source !== "managed" || !["birdbox_device", "birdbox_static", "birdbox_static4", "birdbox_static6", "birdbox_bfd"].includes(name), "路由表名称与 BIRD 内部标识符冲突");
  assertValidation(source !== "managed" || !name.startsWith("bb_spe_"), "源地址出口映射内部表只能引用，不能重复创建");
  return { name, source };
}

export function normalizePipeProtocol(value: unknown): PipeProtocol {
  assertValidation(value && typeof value === "object" && !Array.isArray(value), "Pipe 资源参数不能为空");
  const input = value as Record<string, unknown>;
  const family = normalizeEnum(input.family, new Set(["ipv4", "ipv6"] as const), "ipv4", "Pipe 地址族");
  const name = normalizeId(input.name ?? "birdbox_pipe", "Pipe 协议名称");
  assertValidation(!["birdbox_device", "birdbox_static", "birdbox_static4", "birdbox_static6", "birdbox_bfd", "master4", "master6"].includes(name) && !name.startsWith("bb_spe_"), "Pipe 协议名称与 BIRD 内部标识符冲突");
  const table = normalizeRoutingTableReference(input.table, family, family === "ipv4" ? "master4" : "master6");
  const peerTable = normalizeRoutingTableReference(input.peerTable, family);
  assertValidation(table.name !== peerTable.name, "Pipe 两侧必须使用不同路由表");
  const policy = (direction: "import" | "export"): ChannelPolicy => {
    const normalized = normalizeChannelPolicy(input[`${direction}Policy`] ?? { mode: "form", formAction: direction === "import" ? "none" : "all" }, `Pipe ${direction} 策略`, direction);
    assertValidation(normalized.formAction === "all" || normalized.formAction === "none", "Pipe 策略请选择 all/none，前缀筛选请使用 Filter");
    return normalized;
  };
  return {
    id: normalizeId(input.id, "Pipe 资源 ID"), label: normalizeLabel(input.label ?? name, "Pipe 显示名称"), name,
    nodeIds: normalizeMultiNodeResourceScope(input.nodeIds, input.nodeId), family, table, peerTable,
    importPolicy: policy("import"), exportPolicy: policy("export"), enabled: input.enabled !== false,
  };
}

/** All owners, including disabled resources, retain their shared table declarations. */
export function pipeManagedTables(pipes: readonly PipeProtocol[], statics: readonly StaticProtocol[] = [], kernels: readonly KernelProtocol[] = []): Array<{ name: string; family: AddressFamily }> {
  const references: Array<{ family: AddressFamily; ref: PipeTableReference }> = [
    ...pipes.flatMap(pipe => [pipe.table, pipe.peerTable].map(ref => ({ family: pipe.family, ref }))),
    ...statics.flatMap(item => [
      { family: item.family, ref: item.table ?? { name: item.family === "ipv4" ? "master4" : "master6", source: "existing" as const } },
      ...(item.igpTable ? [{ family: item.family, ref: { name: item.igpTable, source: "existing" as const } }] : []),
    ]),
    ...kernels.flatMap(item => (["ipv4", "ipv6"] as const).filter(family => item[family]).map(family => ({ family, ref: item.tables?.[family] ?? { name: family === "ipv4" ? "master4" : "master6", source: "existing" as const } }))),
  ];
  const tables = new Map<string, AddressFamily>();
  for (const { family, ref } of references) {
    if (ref.source !== "managed") continue;
    assertValidation(!tables.has(ref.name) || tables.get(ref.name) === family, `路由表 ${ref.name} 的地址族冲突`);
    tables.set(ref.name, family);
  }
  const known = new Map<string, AddressFamily>();
  for (const { family, ref } of references) {
    assertValidation(!known.has(ref.name) || known.get(ref.name) === family, `路由表 ${ref.name} 的地址族冲突`);
    known.set(ref.name, family);
  }
  return [...tables].map(([name, family]) => ({ name, family }));
}

/** Inventory-only suggestions; external tables are verified by the node preflight. */
export function knownPipeTables(state: Inventory): Array<{ nodeId: string; name: string; family: AddressFamily; source: "existing" | "managed" }> {
  return state.nodes.flatMap((node) => {
    const tables = new Map<string, { name: string; family: AddressFamily; source: "existing" | "managed" }>();
    for (const family of ["ipv4", "ipv6"] as const) {
      const name = family === "ipv4" ? "master4" : "master6";
      tables.set(name, { name, family, source: "existing" });
    }
    for (const table of pipeManagedTables(state.pipeProtocols.filter((pipe) => resourceAppliesToNode(pipe, node.id)), state.staticProtocols.filter(item => item.nodeId === node.id), state.kernelProtocols.filter(item => resourceAppliesToNode(item, node.id)))) tables.set(table.name, { ...table, source: "managed" });
    for (const item of state.kernelProtocols.filter(item => resourceAppliesToNode(item, node.id))) for (const family of ["ipv4", "ipv6"] as const) {
      const name = item.tables?.[family]?.name;
      if (item[family] && name && !tables.has(name)) tables.set(name, { name, family, source: "existing" });
    }
    for (const item of state.staticProtocols.filter(item => item.nodeId === node.id)) {
      for (const name of [item.table?.name, item.igpTable]) if (name && !tables.has(name)) tables.set(name, { name, family: item.family, source: "existing" });
    }
    for (const resource of state.sourcePolicies.filter((item) => item.enabled && resourceAppliesToNode(item, node.id))) for (const group of resource.groups) {
      const name = sourcePolicyNames(resource, group).table;
      tables.set(name, { name, family: "ipv4", source: "existing" });
    }
    for (const session of state.sessions.filter((item) => item.nodeId === node.id)) for (const family of ["ipv4", "ipv6"] as const) {
      const name = session.channels[family].table;
      if (name && !tables.has(name)) tables.set(name, { name, family, source: "existing" });
    }
    return [...tables.values()].map((table) => ({ ...table, nodeId: node.id }));
  });
}
