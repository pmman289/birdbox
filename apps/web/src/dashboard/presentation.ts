import type { DashboardPeer, DashboardResponse } from "@birdbox/contracts/api";

export interface ProtocolPresentation {
  label: string;
  className: "unconfigured" | "disabled" | "down" | "established" | "unknown";
}

export function protocolPresentation(dashboard: DashboardResponse | null, peer: DashboardPeer): ProtocolPresentation {
  if (!peer.session) return { label: "未配置", className: "unconfigured" };
  if (peer.session.enabled === false) return { label: "已停用", className: "disabled" };
  if (peer.protocol?.disabled) return { label: "手动停止", className: "disabled" };
  if (!dashboard?.runtime.reachable) return { label: "节点不可达", className: "down" };
  if (peer.protocol?.established) return { label: "Established", className: "established" };
  if (peer.protocol?.state) return { label: peer.protocol.state, className: "down" };
  if (peer.protocol?.configured === false) return { label: "未加载", className: "unknown" };
  return { label: "等待运行", className: "unknown" };
}
