import type { DeploymentReport } from "@birdbox/contracts/api";

export function deploymentSummary(deployment: DeploymentReport): string {
  if (!deployment.applied) return "配置已保存，尚未同步运行节点";
  const nodeCount = deployment.nodes.length || deployment.nodeIds.length;
  const sessionCount = deployment.sessions.length;
  return `已同步 ${nodeCount} 个节点${sessionCount ? `、${sessionCount} 条现有会话` : ""}`;
}
