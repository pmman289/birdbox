<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type {
  AuthSession,
  AuthSessionsResponse,
  RevokeAuthSessionResponse,
  RevokeOtherAuthSessionsResponse,
} from "@birdbox/contracts/auth";

import { dispatchAuthRequired, dispatchToast } from "../shared/events";
import { api } from "../shared/api-client";

const sessions = ref<AuthSession[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const pendingAction = ref<string | null>(null);
let loadSequence = 0;

const countLabel = computed(() => {
  if (loading.value) return "正在加载";
  if (errorMessage.value) return "加载失败";
  return `${sessions.value.length} 个有效会话`;
});

const canRevokeOthers = computed(() => sessions.value.some((session) => !session.current));

function formatTime(timestamp: number): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<AuthSession>;
  return typeof session.id === "string"
    && typeof session.address === "string"
    && typeof session.userAgent === "string"
    && typeof session.createdAt === "number"
    && typeof session.expiresAt === "number"
    && typeof session.current === "boolean";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请稍后重试";
}

async function loadSessions(): Promise<void> {
  const sequence = ++loadSequence;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await api<AuthSessionsResponse>("/api/auth/sessions");
    if (sequence !== loadSequence) return;
    sessions.value = Array.isArray(result.sessions) ? result.sessions.filter(isAuthSession) : [];
  } catch (error) {
    if (sequence !== loadSequence) return;
    errorMessage.value = errorText(error);
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

async function revokeSession(session: AuthSession): Promise<void> {
  const prompt = session.current ? "退出当前登录会话？" : "注销这个登录会话？对应设备将需要重新登录。";
  if (!window.confirm(prompt)) return;

  pendingAction.value = session.id;
  errorMessage.value = "";
  try {
    const result = await api<RevokeAuthSessionResponse>(
      `/api/auth/sessions/${encodeURIComponent(session.id)}`,
      { method: "DELETE", timeoutMs: 60_000 },
    );
    if (result.current) {
      dispatchAuthRequired();
      return;
    }
    await loadSessions();
    dispatchToast("登录会话已注销", "success");
  } catch (error) {
    errorMessage.value = errorText(error);
  } finally {
    pendingAction.value = null;
  }
}

async function revokeOtherSessions(): Promise<void> {
  if (!window.confirm("注销当前会话之外的全部登录会话？")) return;

  pendingAction.value = "others";
  errorMessage.value = "";
  try {
    const result = await api<RevokeOtherAuthSessionsResponse>(
      "/api/auth/sessions",
      { method: "DELETE", timeoutMs: 60_000 },
    );
    await loadSessions();
    dispatchToast(result.revoked ? `已注销 ${result.revoked} 个登录会话` : "没有其他有效会话", "success");
  } catch (error) {
    errorMessage.value = errorText(error);
  } finally {
    pendingAction.value = null;
  }
}

function handleOpen(): void {
  void loadSessions();
}

onMounted(() => window.addEventListener("birdbox:account-sessions-open", handleOpen));
onBeforeUnmount(() => window.removeEventListener("birdbox:account-sessions-open", handleOpen));
</script>

<template>
  <section class="account-session-section" aria-labelledby="activeSessionsTitle" :aria-busy="loading || pendingAction !== null">
    <div class="account-section-heading">
      <div>
        <h3 id="activeSessionsTitle">有效登录会话</h3>
        <span>{{ countLabel }}</span>
      </div>
      <button
        class="secondary-button"
        type="button"
        :disabled="!canRevokeOthers || pendingAction !== null || loading"
        @click="revokeOtherSessions"
      >
        {{ pendingAction === "others" ? "正在注销" : "注销其他会话" }}
      </button>
    </div>

    <p v-if="errorMessage" class="auth-error" role="alert">{{ errorMessage }}</p>
    <button
      v-if="errorMessage && !loading"
      class="secondary-button account-session-retry"
      type="button"
      :disabled="pendingAction !== null"
      @click="loadSessions"
    >
      重新加载
    </button>

    <div class="account-session-list" aria-live="polite">
      <p v-if="loading" class="account-session-empty">正在加载会话...</p>
      <template v-else-if="sessions.length">
        <div v-for="session in sessions" :key="session.id" class="account-session-row">
          <div class="account-session-copy">
            <div class="account-session-title">
              <strong>{{ session.address || "来源地址未知" }}</strong>
              <span v-if="session.current" class="account-session-current">当前会话</span>
            </div>
            <span class="account-session-client">{{ session.userAgent || "客户端信息未知" }}</span>
            <span class="account-session-time">登录 {{ formatTime(session.createdAt) }} · 到期 {{ formatTime(session.expiresAt) }}</span>
          </div>
          <button
            class="text-danger-button"
            type="button"
            :disabled="pendingAction !== null"
            @click="revokeSession(session)"
          >
            {{ pendingAction === session.id ? (session.current ? "正在退出" : "正在注销") : (session.current ? "退出此会话" : "注销") }}
          </button>
        </div>
      </template>
      <p v-else class="account-session-empty">没有有效登录会话</p>
    </div>
  </section>
</template>
