<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import type { AuthStatusResponse } from "@birdbox/contracts/auth";

import AccountSessions from "../account-sessions/AccountSessions.vue";
import AuthView from "../auth/AuthView.vue";
import DashboardOverview from "../dashboard/DashboardOverview.vue";
import DashboardRuntime from "../dashboard/DashboardRuntime.vue";
import RouteDetailsDialog from "../dashboard/RouteDetailsDialog.vue";
import SessionControlButton from "../dashboard/SessionControlButton.vue";
import { clearDashboard, loadDashboard, useDashboardStore } from "../dashboard/dashboard-store";
import ResourceWorkspace from "../resources/ResourceWorkspace.vue";
import SessionEditor from "../sessions/SessionEditor.vue";
import { api } from "../shared/api-client";
import type { MutationStartEventDetail, ResourceWorkspaceTarget, ToastType } from "../shared/events";
import type { MutationWaitPresentation } from "../shared/interaction-state";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

const THEME_STORAGE_KEY = "birdbox-theme";
const authenticated = ref(false);
const activeWorkspace = ref<"sessionWorkspace" | "resourceWorkspace">("sessionWorkspace");
const accountDialog = ref<HTMLDialogElement | null>(null);
const passwordForm = ref<HTMLFormElement | null>(null);
const mutationDialog = ref<HTMLDialogElement | null>(null);
const currentPassword = ref("");
const newPassword = ref("");
const newPasswordConfirmation = ref("");
const passwordError = ref("");
const passwordPending = ref(false);
const dashboardError = ref(false);
const theme = ref<"light" | "dark">("light");
const toasts = ref<ToastItem[]>([]);
const mutations = reactive(new Map<number, MutationWaitPresentation>());
const { dashboard, loading } = useDashboardStore();
let toastSequence = 0;
let authMonitorTimer: number | null = null;
let unknownOutcomeTimer: number | null = null;
let systemThemeQuery: MediaQueryList | null = null;

const mutationPresentation = computed(() => [...mutations.values()].at(-1) ?? null);
const globalHealth = computed(() => {
  if (dashboardError.value) return { status: "error", text: "控制器异常" };
  if (!dashboard.value) return { status: "", text: "正在连接" };
  const health = dashboard.value.health;
  return { status: health.status, text: `${health.onlineNodes}个节点在线，${health.normalSessions}个会话正常` };
});
const themeActionLabel = computed(() => theme.value === "dark" ? "切换到白色模式" : "切换到暗色模式");

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function storedTheme(): "light" | "dark" | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(next: "light" | "dark", persist = false): void {
  theme.value = next;
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
  }
  void nextTick(() => {
    document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((button) => {
      const label = next === "dark" ? "切换到白色模式" : "切换到暗色模式";
      button.title = label;
      button.setAttribute("aria-label", label);
      const icon = button.querySelector("span");
      if (icon) icon.textContent = next === "dark" ? "☀" : "☾";
    });
  });
}

function toggleTheme(): void {
  applyTheme(theme.value === "dark" ? "light" : "dark", true);
}

function handleDelegatedThemeToggle(event: MouseEvent): void {
  if ((event.target as Element | null)?.closest("[data-theme-toggle]")) toggleTheme();
}

function followSystemTheme(event: MediaQueryListEvent): void {
  if (!storedTheme()) applyTheme(event.matches ? "dark" : "light");
}

function toast(message: string, type: ToastType = ""): void {
  const item = { id: ++toastSequence, message, type };
  toasts.value.push(item);
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((candidate) => candidate.id !== item.id);
  }, 4300);
}

async function refresh(nodeId = dashboard.value?.node?.id ?? null, peerId = dashboard.value?.selectedPeer?.id ?? null): Promise<void> {
  try {
    dashboardError.value = false;
    await loadDashboard(nodeId, peerId);
  } catch (error) {
    dashboardError.value = true;
    toast(errorText(error, "无法加载控制器状态"), "error");
  }
}

function stopAuthMonitor(): void {
  if (authMonitorTimer !== null) window.clearInterval(authMonitorTimer);
  authMonitorTimer = null;
}

function showAuthentication(status: Pick<AuthStatusResponse, "configured"> = { configured: true }): void {
  stopAuthMonitor();
  authenticated.value = false;
  dashboardError.value = false;
  clearDashboard();
  mutations.clear();
  if (mutationDialog.value?.open) mutationDialog.value.close();
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((item) => item.close());
  document.body.classList.add("auth-active");
  window.dispatchEvent(new CustomEvent("birdbox:auth-show", {
    detail: { configured: status.configured, authenticated: false, username: "admin" },
  }));
}

function startAuthMonitor(): void {
  stopAuthMonitor();
  authMonitorTimer = window.setInterval(async () => {
    try {
      const status = await api<AuthStatusResponse>("/api/auth/status");
      if (!status.authenticated) showAuthentication(status);
    } catch {
      // Dashboard requests surface connectivity failures without ejecting the user.
    }
  }, 15_000);
}

async function showApplication(): Promise<void> {
  authenticated.value = true;
  document.body.classList.remove("auth-active");
  window.dispatchEvent(new CustomEvent("birdbox:app-ready"));
  startAuthMonitor();
  await refresh(null, null);
}

async function logout(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    toast(errorText(error, "退出失败"), "error");
  } finally {
    showAuthentication({ configured: true });
  }
}

function activateWorkspace(workspace: "sessionWorkspace" | "resourceWorkspace", resourceTarget: ResourceWorkspaceTarget | null = null): void {
  activeWorkspace.value = workspace;
  if (!resourceTarget) return;
  window.dispatchEvent(new CustomEvent("birdbox:resource-tab-select", { detail: { target: resourceTarget } }));
  void nextTick(() => {
    const section = document.querySelector<HTMLElement>(`#resource-${resourceTarget}`);
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    section?.classList.add("resource-highlight");
    window.setTimeout(() => section?.classList.remove("resource-highlight"), 1200);
  });
}

function moveWorkspaceTab(event: KeyboardEvent, current: number): void {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : current === 0 ? 1 : 0;
  const workspace = next === 0 ? "sessionWorkspace" : "resourceWorkspace";
  activateWorkspace(workspace);
  void nextTick(() => document.querySelector<HTMLButtonElement>(`[data-workspace="${workspace}"]`)?.focus());
}

function openAccountSettings(): void {
  currentPassword.value = "";
  newPassword.value = "";
  newPasswordConfirmation.value = "";
  passwordError.value = "";
  accountDialog.value?.showModal();
  window.dispatchEvent(new CustomEvent("birdbox:account-sessions-open"));
  void nextTick(() => document.querySelector<HTMLInputElement>("#currentPassword")?.focus());
}

function closeAccountSettings(): void {
  if (!passwordPending.value) accountDialog.value?.close();
}

async function changePassword(): Promise<void> {
  const form = passwordForm.value;
  if (!form || !form.reportValidity()) return;
  if (newPassword.value !== newPasswordConfirmation.value) {
    passwordError.value = "两次输入的新密码不一致";
    document.querySelector<HTMLInputElement>("#newPasswordConfirmation")?.focus();
    return;
  }
  passwordPending.value = true;
  passwordError.value = "";
  try {
    await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: currentPassword.value,
        password: newPassword.value,
        confirmation: newPasswordConfirmation.value,
      }),
    });
    accountDialog.value?.close();
    currentPassword.value = "";
    newPassword.value = "";
    newPasswordConfirmation.value = "";
    toast("管理密码已更新，其他登录会话已注销", "success");
  } catch (error) {
    passwordError.value = errorText(error, "管理密码更新失败");
  } finally {
    passwordPending.value = false;
  }
}

function handleToast(event: CustomEvent<{ message: string; type?: ToastType }>): void {
  if (typeof event.detail?.message === "string") toast(event.detail.message, event.detail.type ?? "");
}

function handleMutationStart(event: CustomEvent<MutationStartEventDetail>): void {
  mutations.set(event.detail.requestId, event.detail.presentation);
  if (!mutationDialog.value?.open) mutationDialog.value?.showModal();
}

function handleMutationEnd(event: CustomEvent<{ requestId: number }>): void {
  mutations.delete(event.detail.requestId);
  if (!mutations.size && mutationDialog.value?.open) mutationDialog.value.close();
}

function handleUnknownOutcome(): void {
  if (unknownOutcomeTimer !== null) window.clearTimeout(unknownOutcomeTimer);
  unknownOutcomeTimer = window.setTimeout(async () => {
    unknownOutcomeTimer = null;
    try {
      await refresh();
      toast("请求结果未知，已刷新库存和节点状态", "success");
    } catch {
      // The timeout error remains visible and manual refresh can retry reconciliation.
    }
  }, 0);
}

function handleWorkspaceResourceOpen(event: CustomEvent<{ target: ResourceWorkspaceTarget }>): void {
  activateWorkspace("resourceWorkspace", event.detail.target);
}

function handleDashboardSelection(event: CustomEvent<{ nodeId: string | null; peerId: string | null }>): void {
  void refresh(event.detail.nodeId, event.detail.peerId);
}

function handleAuthRequired(): void {
  showAuthentication({ configured: true });
}

onMounted(() => {
  const currentTheme = document.documentElement.dataset.theme;
  theme.value = currentTheme === "dark" ? "dark" : currentTheme === "light" ? "light" : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(theme.value);
  systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeQuery.addEventListener("change", followSystemTheme);
  document.addEventListener("click", handleDelegatedThemeToggle);
  window.addEventListener("birdbox:authenticated", showApplication);
  window.addEventListener("birdbox:auth-required", handleAuthRequired);
  window.addEventListener("birdbox:toast", handleToast);
  window.addEventListener("birdbox:mutation-start", handleMutationStart);
  window.addEventListener("birdbox:mutation-end", handleMutationEnd);
  window.addEventListener("birdbox:unknown-mutation-outcome", handleUnknownOutcome);
  window.addEventListener("birdbox:workspace-resource-open", handleWorkspaceResourceOpen);
  window.addEventListener("birdbox:dashboard-selection", handleDashboardSelection);
});

onBeforeUnmount(() => {
  stopAuthMonitor();
  if (unknownOutcomeTimer !== null) window.clearTimeout(unknownOutcomeTimer);
  systemThemeQuery?.removeEventListener("change", followSystemTheme);
  document.removeEventListener("click", handleDelegatedThemeToggle);
  window.removeEventListener("birdbox:authenticated", showApplication);
  window.removeEventListener("birdbox:auth-required", handleAuthRequired);
  window.removeEventListener("birdbox:toast", handleToast);
  window.removeEventListener("birdbox:mutation-start", handleMutationStart);
  window.removeEventListener("birdbox:mutation-end", handleMutationEnd);
  window.removeEventListener("birdbox:unknown-mutation-outcome", handleUnknownOutcome);
  window.removeEventListener("birdbox:workspace-resource-open", handleWorkspaceResourceOpen);
  window.removeEventListener("birdbox:dashboard-selection", handleDashboardSelection);
});
</script>

<template>
  <AuthView />

  <header id="appHeader" class="app-header" :hidden="!authenticated">
    <div class="brand-block"><div class="brand-mark" aria-hidden="true">B</div><div><h1>Birdbox</h1><p>BIRD 2 控制台</p></div></div>
    <div class="header-actions">
      <span id="globalState" class="global-state" :class="globalHealth.status" :title="globalHealth.text" :aria-label="globalHealth.text"><i></i>{{ globalHealth.text }}</span>
      <button id="themeToggle" class="icon-button theme-toggle" type="button" :title="themeActionLabel" :aria-label="themeActionLabel" @click="toggleTheme"><span aria-hidden="true">{{ theme === "dark" ? "☀" : "☾" }}</span></button>
      <button id="accountButton" class="header-command" type="button" @click="openAccountSettings">设置</button>
      <button id="logoutButton" class="header-command" type="button" @click="logout">退出</button>
      <button id="refreshButton" class="icon-button" :class="{ loading }" type="button" title="刷新状态" aria-label="刷新状态" :aria-busy="loading" :disabled="loading" @click="refresh()">↻</button>
    </div>
  </header>

  <main id="appMain" :hidden="!authenticated">
    <nav class="workspace-tabs" role="tablist" aria-label="Birdbox 工作区">
      <button id="sessionWorkspaceTab" class="workspace-tab" :class="{ active: activeWorkspace === 'sessionWorkspace' }" type="button" role="tab" :aria-selected="activeWorkspace === 'sessionWorkspace'" aria-controls="sessionWorkspace" data-workspace="sessionWorkspace" :tabindex="activeWorkspace === 'sessionWorkspace' ? 0 : -1" @click="activateWorkspace('sessionWorkspace')" @keydown="moveWorkspaceTab($event, 0)">会话与拓扑</button>
      <button id="resourceWorkspaceTab" class="workspace-tab" :class="{ active: activeWorkspace === 'resourceWorkspace' }" type="button" role="tab" :aria-selected="activeWorkspace === 'resourceWorkspace'" aria-controls="resourceWorkspace" data-workspace="resourceWorkspace" :tabindex="activeWorkspace === 'resourceWorkspace' ? 0 : -1" @click="activateWorkspace('resourceWorkspace')" @keydown="moveWorkspaceTab($event, 1)">资源管理</button>
    </nav>

    <div id="sessionWorkspace" class="workspace-panel" role="tabpanel" aria-labelledby="sessionWorkspaceTab" :hidden="activeWorkspace !== 'sessionWorkspace'">
      <div id="dashboardOverviewApp"><DashboardOverview /></div>
      <div class="workspace-grid">
        <div id="sessionEditorApp"><SessionEditor /></div>
        <section class="inspect-section" aria-labelledby="inspectTitle">
          <div class="section-heading compact"><div><p class="eyebrow">运行详情</p><h2 id="inspectTitle">节点会话</h2></div><div id="sessionControlApp"><SessionControlButton /></div></div>
          <div id="dashboardRuntimeApp"><DashboardRuntime /></div>
        </section>
      </div>
    </div>

    <section id="resourceWorkspace" class="workspace-panel resource-workspace" role="tabpanel" aria-labelledby="resourceWorkspaceTab" :hidden="activeWorkspace !== 'resourceWorkspace'">
      <div id="resourceWorkspaceApp"><ResourceWorkspace /></div>
    </section>
  </main>

  <div id="operationStatus" class="visually-hidden" role="status" aria-live="polite">{{ mutationPresentation?.title ?? "" }}</div>
  <div id="toastRegion" class="toast-region" aria-live="assertive"><div v-for="item in toasts" :key="item.id" class="toast" :class="item.type">{{ item.message }}</div></div>
  <div id="routeDetailsApp"><RouteDetailsDialog /></div>

  <dialog id="mutationWaitDialog" ref="mutationDialog" class="mutation-wait-dialog" aria-labelledby="mutationWaitTitle" aria-describedby="mutationWaitDetail" @cancel.prevent>
    <div class="mutation-wait-content" role="status" aria-live="polite" aria-atomic="true"><span class="mutation-wait-spinner" aria-hidden="true"></span><div class="mutation-wait-copy"><strong id="mutationWaitTitle">{{ mutationPresentation?.title ?? "正在处理变更" }}</strong><span id="mutationWaitDetail">{{ mutationPresentation?.detail ?? "正在变更，请等待节点返回结果" }}</span></div></div>
  </dialog>

  <dialog id="passwordDialog" ref="accountDialog" class="editor-dialog account-settings-dialog" aria-labelledby="passwordDialogTitle" @cancel.prevent="closeAccountSettings">
    <form id="passwordForm" ref="passwordForm" :aria-busy="passwordPending" @submit.prevent="changePassword">
      <div class="dialog-head"><span class="dialog-icon">A</span><div><p class="eyebrow">ADMIN</p><h2 id="passwordDialogTitle">账户设置</h2></div></div>
      <div id="accountSessionsApp"><AccountSessions /></div>
      <section class="password-settings-section" aria-labelledby="changePasswordTitle">
        <h3 id="changePasswordTitle">修改管理密码</h3>
        <div class="dialog-grid single-column-dialog account-password-fields">
          <div class="field full-width"><label for="currentPassword">当前密码</label><input id="currentPassword" v-model="currentPassword" type="password" maxlength="128" autocomplete="current-password" required></div>
          <div class="field full-width"><label for="newPassword">新密码</label><input id="newPassword" v-model="newPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></div>
          <div class="field full-width"><label for="newPasswordConfirmation">确认新密码</label><input id="newPasswordConfirmation" v-model="newPasswordConfirmation" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></div>
          <p v-if="passwordError" id="passwordError" class="auth-error full-width" role="alert">{{ passwordError }}</p>
        </div>
      </section>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-close="passwordDialog" :disabled="passwordPending" @click="closeAccountSettings">关闭</button><button id="savePasswordButton" class="primary-button" type="submit" :disabled="passwordPending">{{ passwordPending ? "正在更新密码" : "更新密码" }}</button></div>
    </form>
  </dialog>
</template>
