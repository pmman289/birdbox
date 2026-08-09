import type { DashboardResponse } from "@birdbox/contracts/api";
import type { PolicyCollection } from "@birdbox/contracts/inventory";

export type ToastType = "" | "success" | "error";

export interface ToastEventDetail {
  message: string;
  type?: ToastType;
}

export interface MutationStartEventDetail {
  requestId: number;
  presentation: { title: string; detail: string };
}

export interface AuthShowEventDetail {
  configured: boolean;
  authenticated: false;
  username: "admin";
}

export interface DashboardUpdatedEventDetail {
  dashboard: DashboardResponse;
  updatedAt: number;
}

export interface DashboardSelectionEventDetail {
  nodeId: string | null;
  peerId: string | null;
}

export type ResourceWorkspaceTarget = "nodes" | "peers" | "defines" | "statics" | "functions" | "filters" | "rpki";
export type ResourceEditKind = ResourceWorkspaceTarget;

declare global {
  interface WindowEventMap {
    "birdbox:account-sessions-open": CustomEvent<void>;
    "birdbox:app-ready": CustomEvent<void>;
    "birdbox:authenticated": CustomEvent<void>;
    "birdbox:auth-required": CustomEvent<void>;
    "birdbox:auth-show": CustomEvent<AuthShowEventDetail>;
    "birdbox:dashboard-loading": CustomEvent<{ loading: boolean }>;
    "birdbox:dashboard-selection": CustomEvent<DashboardSelectionEventDetail>;
    "birdbox:dashboard-updated": CustomEvent<DashboardUpdatedEventDetail>;
    "birdbox:routes-open": CustomEvent<{ peerId: string }>;
    "birdbox:resource-edit": CustomEvent<{ kind: ResourceEditKind; id: string }>;
    "birdbox:resource-create": CustomEvent<{ kind: ResourceEditKind }>;
    "birdbox:resource-move": CustomEvent<{
      collection: PolicyCollection;
      id: string;
      direction: "up" | "down";
      button: HTMLButtonElement;
    }>;
    "birdbox:resource-tab-select": CustomEvent<{ target: ResourceWorkspaceTarget }>;
    "birdbox:mutation-start": CustomEvent<MutationStartEventDetail>;
    "birdbox:mutation-end": CustomEvent<{ requestId: number }>;
    "birdbox:unknown-mutation-outcome": CustomEvent<void>;
    "birdbox:toast": CustomEvent<ToastEventDetail>;
    "birdbox:workspace-resource-open": CustomEvent<{ target: ResourceWorkspaceTarget }>;
  }
}

export function dispatchAuthRequired(): void {
  window.dispatchEvent(new CustomEvent("birdbox:auth-required"));
}

export function dispatchToast(message: string, type: ToastType = ""): void {
  window.dispatchEvent(new CustomEvent("birdbox:toast", { detail: { message, type } }));
}
