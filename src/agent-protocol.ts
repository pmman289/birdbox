import type { NodeCommandResponse } from "../packages/contracts/src/api.js";

export interface AgentRegistration {
  nodeId: string;
  token: string;
  agentVersion: string;
  protocolVersion: number;
  capabilities?: string[];
  platform?: string;
  architecture?: string;
  hostname?: string;
}

export interface AgentTask {
  taskId: string;
  nodeId: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: string;
  deadlineAt: string;
}

export interface AgentTaskResult extends NodeCommandResponse {
  taskId: string;
  nodeId: string;
  result?: unknown;
}

export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_METHODS = new Set([
  "system.info",
  "system.interfaces",
  "network.ip_rules",
  "network.ip_rules.inspect",
  "bird.ospf",
  "bird.access",
  "bird.inspect",
  "bird.validate",
  "bird.stage",
  "bird.apply",
  "bird.rollback",
  "bird.protocol",
  "bird.routes",
  "bird.protocol_state",
  "legacy.exec",
  "agent.self_upgrade",
]);
