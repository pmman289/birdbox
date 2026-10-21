import type { Inventory, ManagedNode } from "../packages/contracts/src/inventory.js";
import { resourceAppliesToNode } from "../packages/contracts/src/resource-scope.js";
import { sourcePolicyManagedRules, sourcePolicyManagedRulesForNode } from "./bird-source-policy.js";
import { executeNodeRpc } from "./node-executor.js";

/** Rebuild side effects from the persisted journal, without transient callbacks. */
export async function recoverSourcePolicyRules(node: ManagedNode, desired: Inventory, opposite: Inventory): Promise<void> {
  if (node.transport !== "agent") return;
  const active = desired.sourcePolicies.filter(item => item.enabled && resourceAppliesToNode(item, node.id));
  const old = opposite.sourcePolicies.filter(item => item.enabled && resourceAppliesToNode(item, node.id));
  if (!active.length && !old.length) return;
  const fields = ({ priority, source, destination, table, kind }: ReturnType<typeof sourcePolicyManagedRules>[number]) => ({ priority, source, destination, table, kind });
  const result = await executeNodeRpc(node, "network.ip_rules", {
    removeRules: sourcePolicyManagedRules([...old, ...active]).map(fields),
    rules: sourcePolicyManagedRulesForNode(active, node).map(fields),
  }, 60_000);
  if (!result.ok) throw new Error(result.stderr || result.stdout || `${node.name} 的源地址出口系统规则恢复失败`);
}
