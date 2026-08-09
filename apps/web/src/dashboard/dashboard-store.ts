import { ref, shallowRef } from "vue";

import type { DashboardResponse } from "@birdbox/contracts/api";

import { api } from "../shared/api-client";

const dashboardState = shallowRef<DashboardResponse | null>(null);
const dashboardLoading = ref(false);
const dashboardUpdatedAt = ref<number | null>(null);
const dashboardLoadGeneration = ref(0);
let dashboardRequestId = 0;
let dashboardAbortController: AbortController | null = null;

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
    const params = new URLSearchParams();
    if (nodeId) params.set("nodeId", nodeId);
    if (peerId) params.set("peerId", peerId);
    const dashboard = await api<DashboardResponse>(`/api/dashboard?${params}`, { signal: controller.signal });
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
