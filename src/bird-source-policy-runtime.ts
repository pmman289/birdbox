import type { SourcePolicyRuntimeResponse } from "../packages/contracts/src/api.js";
import type { Inventory, ManagedNode, SourcePolicyEgress } from "../packages/contracts/src/inventory.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import { sourcePolicyForNode, sourcePolicyManagedRules, sourcePolicyManagedRulesForNode, sourcePolicyNames } from "./bird-source-policy.js";
import { inspectProtocolDetails } from "./bird-runtime.js";
import { parseSystemProtocolRuntime } from "./bird-system-runtime.js";
import { executeNodeCommand, executeNodeRpc } from "./node-executor.js";

type NodeRuntime = SourcePolicyRuntimeResponse["nodes"][number];
type ActualRule = NodeRuntime["rules"]["unexpected"][number];
interface SystemSnapshot {
  rules: ActualRule[];
  rawRules: unknown[];
  tables: Array<{ table: number; routes: Array<Record<string, unknown>>; truncated: boolean; error: string | null }>;
  persistence: { state: NodeRuntime["rules"]["persistence"]; error: string | null };
}
const message = (e: unknown) => e instanceof Error ? e.message : "节点检查失败";
const key = (r: { priority: number; table: number; source?: string | null; destination?: string | null }) => `${r.priority}|${r.source ?? ""}|${r.destination ?? ""}|${r.table}`;

function manualRule(raw: Record<string, unknown>): ActualRule | null {
  if (Object.keys(raw).some(key => !["priority", "src", "dst", "table", "protocol"].includes(key))) return null;
  const table = raw.table === "main" ? 254 : Number(raw.table), priority = Number(raw.priority);
  if (!Number.isSafeInteger(table) || !Number.isSafeInteger(priority)) return null;
  const cidr = (value: unknown) => typeof value === "string" && value !== "all" && value !== "0.0.0.0/0" ? value.includes("/") ? value : `${value}/32` : undefined;
  const source = cidr(raw.src), destination = cidr(raw.dst);
  return { table, priority, ...(source ? { source } : destination || table === 254 ? {} : { source: "0.0.0.0/0" }), ...(destination ? { destination } : {}) };
}

async function inspectSystem(node: ManagedNode, tables: number[], priorities: number[]): Promise<SystemSnapshot> {
  if (node.transport === "agent") {
    const result = await executeNodeRpc(node, "network.ip_rules.inspect", { tables, priorities }, 15_000);
    if (result.code === "METHOD_NOT_ALLOWED") throw new Error("当前 Agent 不支持系统规则检查，请先升级 Agent；BIRD 协议状态仍可查看");
    if (!result.ok) throw new Error(result.stderr || "无法检查系统规则，请确认 Agent 已升级并且节点在线");
    const parsed = JSON.parse(result.stdout) as SystemSnapshot;
    if (!Array.isArray(parsed.rules) || !Array.isArray(parsed.rawRules) || !Array.isArray(parsed.tables)
      || parsed.rules.some(rule => !rule || !Number.isSafeInteger(rule.priority) || !Number.isSafeInteger(rule.table))
      || parsed.tables.some(table => !table || !Number.isSafeInteger(table.table) || !Array.isArray(table.routes) || table.routes.some(route => !route || typeof route !== 'object'))
      || !parsed.persistence || !["ready", "pending", "missing", "error"].includes(parsed.persistence.state)) throw new Error("Agent 返回的系统规则检查结果不完整，请升级 Agent");
    return parsed;
  }
  const rules = await executeNodeCommand(node, "ip -j -4 rule show", { timeout: 15_000 });
  if (!rules.ok) throw new Error(rules.stderr || rules.stdout || "无法读取 Linux 策略规则");
  const rawRules = (JSON.parse(rules.stdout) as Array<Record<string, unknown>>).filter(rule => priorities.includes(Number(rule.priority)));
  return {
    rules: rawRules.map(manualRule).filter((r): r is ActualRule => r !== null), rawRules: rawRules.slice(0, 200), persistence: { state: "manual", error: null },
    tables: await Promise.all(tables.map(async table => {
      try {
        const result = await executeNodeCommand(node, `ip -j -4 route show table ${table}`, { timeout: 15_000 });
        if (!result.ok && !/FIB table does not exist/i.test(result.stderr)) throw new Error(result.stderr || result.stdout || "内核路由查询失败");
        const routes = result.ok ? JSON.parse(result.stdout) as Array<Record<string, unknown>> : [];
        return { table, routes: routes.slice(0, 200), truncated: routes.length > 200, error: null };
      } catch (e) { return { table, routes: [], truncated: false, error: message(e) }; }
    })),
  };
}

export async function inspectSourcePolicyRuntime(inventory: Inventory, resource: SourcePolicyEgress): Promise<SourcePolicyRuntimeResponse> {
  const nodes = await Promise.all(inventory.nodes.filter(node => resourceAppliesToNode(resource, node.id)).map(async (node): Promise<NodeRuntime> => {
    const scoped = sourcePolicyForNode(resource, node), owned = sourcePolicyManagedRules([resource]);
    const expected = resource.enabled ? sourcePolicyManagedRulesForNode([resource], node) : [];
    const allExpected = new Set(sourcePolicyManagedRulesForNode(inventory.sourcePolicies.filter(item => item.enabled && resourceAppliesToNode(item, node.id)), node).map(key));
    const systemPromise = inspectSystem(node, resource.groups.map(g => g.kernelTable), [...new Set(owned.map(r => r.priority))])
      .then(value => ({ value, error: null }), e => ({ value: null, error: message(e) }));
    // A node has a bounded background RPC queue. Inspect one group's protocols
    // at a time while keeping independent nodes and the system snapshot parallel.
    const deadline = Date.now() + 25_000;
    const groupsPromise = (async () => {
      const groups: Array<Omit<NodeRuntime["groups"][number], "kernelRoutes" | "routesTruncated" | "routeError">> = [];
      for (const group of resource.groups) {
      const names = sourcePolicyNames(resource, group), skipped = !scoped?.groups.some(g => g.id === group.id);
      const instances = [{ name: names.staticProtocol, kind: "Static" as const }, { name: names.kernelProtocol, kind: "Kernel" as const }, ...(resource.copyInternalRoutes && resource.internalDefineIds.length ? [{ name: names.pipe, kind: "Pipe" as const }] : [])];
      const protocols = skipped ? [] : await Promise.all(instances.map(async instance => {
        if (!resource.enabled) return { ...instance, state: "disabled" as const, raw: "", error: null };
        try {
          if (Date.now() >= deadline) throw new Error("节点运行态检查超时，请刷新后重试");
          const result = await inspectProtocolDetails(node, instance.name, Math.min(10_000, Math.max(250, deadline - Date.now())));
          if (!result.ok && !/no protocols? match(?:es)?|no such protocol/i.test(`${result.error} ${result.output}`)) throw new Error(result.error ?? "无法读取协议状态");
          return { ...instance, state: parseSystemProtocolRuntime(result.output, instance.name, instance.kind).state, raw: result.output, error: null };
        } catch (e) { return { ...instance, state: "error" as const, raw: "", error: message(e) }; }
      }));
        groups.push({ groupId: group.id, egressAddress: group.egressAddress, table: names.table, kernelTable: group.kernelTable, skipped, protocols });
      }
      return groups;
    })();
    const [system, groups] = await Promise.all([systemPromise, groupsPromise]);
    const actual = system.value?.rules ?? [], actualKeys = new Set(actual.map(key));
    const missing = expected.filter(rule => !actualKeys.has(key(rule)));
    return {
      nodeId: node.id, lastCheckedAt: new Date().toISOString(),
      rules: { expected: expected.length, installed: system.error ? null : expected.length - missing.length, missing: system.error ? [] : missing,
        unexpected: actual.filter(rule => !allExpected.has(key(rule))), persistence: system.value?.persistence.state ?? "unknown",
        error: system.error ?? system.value?.persistence.error ?? null, raw: system.value ? JSON.stringify(system.value.rawRules, null, 2) : "" },
      groups: groups.map(group => {
        const table = system.value?.tables.find(t => t.table === group.kernelTable);
        return { ...group, kernelRoutes: (table?.routes ?? []).map(route => ({ prefix: String(route.dst ?? "default"), gateway: route.gateway ? String(route.gateway) : null,
          interface: route.dev ? String(route.dev) : null, type: String(route.type ?? "unicast"), raw: JSON.stringify(route, null, 2) })),
          routesTruncated: table?.truncated ?? false, routeError: system.error ?? table?.error ?? (!table ? "节点未返回此内核表的检查结果" : null) };
      }),
    };
  }));
  return { resourceId: resource.id, nodes };
}
