import { ref, shallowRef } from "vue";

import type { DashboardResponse, DashboardRuntimeResponse } from "@birdbox/contracts/api";

import { api } from "../shared/api-client";
import { sessionProtocolEnabledSnapshot } from "./session-control-state";

const dashboardState = shallowRef<DashboardResponse | null>(null);
const dashboardLoading = ref(false);
const dashboardUpdatedAt = ref<number | null>(null);
const dashboardLoadGeneration = ref(0);
let dashboardRequestId = 0;
let dashboardAbortController: AbortController | null = null;
let runtimeRefreshPending = false;

function dashboardPath(nodeId: string | null, peerId: string | null): string {
  const params = new URLSearchParams();
  if (nodeId) params.set("nodeId", nodeId);
  if (peerId) params.set("peerId", peerId);
  return `/api/dashboard?${params}`;
}

function dispatchDashboardUpdated(dashboard: DashboardResponse, updatedAt: number): void {
  window.dispatchEvent(new CustomEvent("birdbox:dashboard-updated", { detail: { dashboard, updatedAt } }));
}

function dispatchDashboardLoading(loading: boolean): void {
  window.dispatchEvent(new CustomEvent("birdbox:dashboard-loading", { detail: { loading } }));
}

export function setDashboardSnapshot(dashboard: DashboardResponse, updatedAt = Date.now()): void {
  dashboardState.value = dashboard;
  dashboardUpdatedAt.value = updatedAt;
  dispatchDashboardUpdated(dashboard, updatedAt);
}

export function setDashboardLoading(loading: boolean): void {
  dashboardLoading.value = loading;
  dispatchDashboardLoading(loading);
}

export function clearDashboard(): void {
  dashboardRequestId += 1;
  dashboardAbortController?.abort();
  dashboardAbortController = null;
  dashboardState.value = null;
  dashboardUpdatedAt.value = null;
  setDashboardLoading(false);
}

export async function loadDashboard(nodeId: string | null = null, peerId: string | null = null): Promise<DashboardResponse | null> {
  const requestId = ++dashboardRequestId;
  dashboardAbortController?.abort();
  const controller = new AbortController();
  dashboardAbortController = controller;
  setDashboardLoading(true);
  try {
    const dashboard = await api<DashboardResponse>(dashboardPath(nodeId, peerId), { signal: controller.signal });
    if (requestId !== dashboardRequestId) return null;
    setDashboardSnapshot(dashboard);
    dashboardLoadGeneration.value += 1;
    return dashboard;
  } catch (error) {
    if (controller.signal.aborted || requestId !== dashboardRequestId) return null;
    throw error;
  } finally {
    if (requestId === dashboardRequestId) {
      dashboardAbortController = null;
      setDashboardLoading(false);
    }
  }
}

export async function refreshDashboardRuntime(): Promise<DashboardResponse | null> {
  const current = dashboardState.value;
  const nodeId = current?.node?.id;
  if (!current || !nodeId || runtimeRefreshPending || dashboardLoading.value) return null;
  runtimeRefreshPending = true;
  try {
    const response = await api<DashboardRuntimeResponse>(`/api/nodes/${encodeURIComponent(nodeId)}/runtime`);
    if (dashboardState.value !== current || response.nodeId !== nodeId) return null;
    const runtimeByName = new Map(response.runtime.protocols.map((protocol) => [protocol.name, protocol]));
    const sessionByPeerId = new Map(response.sessions.map((session) => [session.peerId, session]));
    const peers = current.peers.map((peer) => ({
      ...peer,
      session: sessionByPeerId.get(peer.id) ?? null,
      protocol: sessionByPeerId.has(peer.id)
        ? runtimeByName.get(sessionByPeerId.get(peer.id)!.protocolName) ?? (peer.protocol ? {
            ...peer.protocol,
            configured: false,
          } : {
            name: sessionByPeerId.get(peer.id)!.protocolName,
            configured: false,
            disabled: false,
            state: null,
            established: false,
            neighbor: null,
            neighborAs: null,
            imported: null,
            exported: null,
          })
        : null,
    }));
    const selectedPeer = peers.find((peer) => peer.id === current.selectedPeer?.id) ?? null;
    const previousSessionNames = current.inventory.sessions
      .filter((session) => session.nodeId === nodeId && session.enabled)
      .map((session) => session.protocolName);
    const nextSessionNames = response.sessions
      .filter((session) => session.enabled)
      .map((session) => session.protocolName);
    const previousRuntimeByName = new Map(current.runtime.protocols.map((protocol) => [protocol.name, protocol]));
    const previousEstablished = previousSessionNames.filter((name) => previousRuntimeByName.get(name)?.established).length;
    const nextEstablished = nextSessionNames.filter((name) => runtimeByName.get(name)?.established).length;
    const onlineNodes = Math.max(0, Math.min(
      current.health.totalNodes,
      current.health.onlineNodes
        + (response.runtime.reachable ? 1 : 0)
        - (current.runtime.reachable ? 1 : 0),
    ));
    const activeSessions = Math.max(0,
      current.health.activeSessions
        - previousSessionNames.length
        + nextSessionNames.length,
    );
    const normalSessions = Math.max(0, Math.min(
      activeSessions,
      current.health.normalSessions + nextEstablished - previousEstablished,
    ));
    const abnormalSessions = activeSessions - normalSessions;
    const next: DashboardResponse = {
      ...current,
      peers,
      selectedPeer,
      runtime: response.runtime,
      established: selectedPeer?.protocol?.established ?? false,
      inventory: {
        ...current.inventory,
        sessions: [
          ...current.inventory.sessions.filter((session) => session.nodeId !== nodeId),
          ...response.sessions,
        ],
      },
      config: response.config,
      events: response.events,
      health: {
        ...current.health,
        onlineNodes,
        activeSessions,
        normalSessions,
        abnormalSessions,
        status: onlineNodes < current.health.totalNodes
          ? "error"
          : abnormalSessions > 0 ? "warning" : "ready",
      },
    };
    setDashboardSnapshot(next);
    return next;
  } finally {
    runtimeRefreshPending = false;
  }
}

export function setSessionProtocolEnabled(sessionId: string, enabled: boolean): void {
  const current = dashboardState.value;
  if (!current) return;
  const next = sessionProtocolEnabledSnapshot(current, sessionId, enabled);
  if (next !== current) setDashboardSnapshot(next);
}

function acceptLegacyDashboard(event: CustomEvent<{ dashboard: DashboardResponse; updatedAt: number }>): void {
  dashboardState.value = event.detail.dashboard;
  dashboardUpdatedAt.value = event.detail.updatedAt;
}

function acceptLegacyLoading(event: CustomEvent<{ loading: boolean }>): void {
  dashboardLoading.value = event.detail.loading;
}

window.addEventListener("birdbox:dashboard-updated", acceptLegacyDashboard);
window.addEventListener("birdbox:dashboard-loading", acceptLegacyLoading);

export function useDashboardStore() {
  return {
    dashboard: dashboardState,
    loading: dashboardLoading,
    updatedAt: dashboardUpdatedAt,
    loadGeneration: dashboardLoadGeneration,
  };
}
