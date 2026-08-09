<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import type { AuthMutationResponse, AuthStatusResponse } from "@birdbox/contracts/auth";

import { api } from "../shared/api-client";

const visible = ref(true);
const setupMode = ref(false);
const password = ref("");
const confirmation = ref("");
const errorMessage = ref("");
const pending = ref(false);
const passwordInput = ref<HTMLInputElement | null>(null);
const appVersion = __BIRDBOX_VERSION__;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "无法连接 Birdbox";
}

function focusPassword(): void {
  void nextTick(() => passwordInput.value?.focus());
}

function showAuthentication(status: Pick<AuthStatusResponse, "configured">): void {
  setupMode.value = status.configured === false;
  visible.value = true;
  password.value = "";
  confirmation.value = "";
  errorMessage.value = "";
  focusPassword();
}

function dispatchAuthenticated(): void {
  visible.value = false;
  window.dispatchEvent(new CustomEvent("birdbox:authenticated"));
}

async function initialize(): Promise<void> {
  try {
    const status = await api<AuthStatusResponse>("/api/auth/status");
    if (status.authenticated) dispatchAuthenticated();
    else showAuthentication(status);
  } catch (error) {
    showAuthentication({ configured: true });
    errorMessage.value = errorText(error);
  }
}

async function submit(): Promise<void> {
  if (pending.value) return;
  if (password.value.length < 10 || password.value.length > 128) {
    errorMessage.value = "密码长度应为 10 到 128 个字符";
    focusPassword();
    return;
  }
  if (setupMode.value && password.value !== confirmation.value) {
    errorMessage.value = "两次输入的密码不一致";
    return;
  }
  pending.value = true;
  errorMessage.value = "";
  try {
    await api<AuthMutationResponse>(setupMode.value ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        password: password.value,
        confirmation: setupMode.value ? confirmation.value : undefined,
      }),
    });
    dispatchAuthenticated();
  } catch (error) {
    errorMessage.value = errorText(error);
    focusPassword();
  } finally {
    pending.value = false;
  }
}

function handleAuthRequired(): void {
  showAuthentication({ configured: true });
}

function handleAuthShow(event: CustomEvent<{ configured: boolean }>): void {
  showAuthentication(event.detail);
}

function handleAppReady(): void {
  visible.value = false;
}

onMounted(() => {
  window.addEventListener("birdbox:auth-required", handleAuthRequired);
  window.addEventListener("birdbox:auth-show", handleAuthShow);
  window.addEventListener("birdbox:app-ready", handleAppReady);
  void initialize();
});

onBeforeUnmount(() => {
  window.removeEventListener("birdbox:auth-required", handleAuthRequired);
  window.removeEventListener("birdbox:auth-show", handleAuthShow);
  window.removeEventListener("birdbox:app-ready", handleAppReady);
});
</script>

<template>
  <section id="authView" class="auth-view" aria-labelledby="authTitle" :hidden="!visible">
    <button
      class="icon-button theme-toggle auth-theme-toggle"
      type="button"
      data-theme-toggle
      title="切换到暗色模式"
      aria-label="切换到暗色模式"
    ><span aria-hidden="true">☾</span></button>
    <div class="auth-panel">
      <div class="auth-brand">
        <div class="brand-mark" aria-hidden="true">B</div>
        <div><strong>Birdbox</strong><span>BIRD 2 控制台</span></div>
      </div>
      <div class="auth-heading">
        <p class="eyebrow">ADMIN ACCESS</p>
        <h1 id="authTitle">{{ setupMode ? "设置管理密码" : "登录 Birdbox" }}</h1>
      </div>
      <form id="authForm" :aria-busy="pending" @submit.prevent="submit">
        <div class="field">
          <label for="authUsername">账户</label>
          <input id="authUsername" value="admin" readonly>
        </div>
        <div class="field">
          <label for="authPassword">密码</label>
          <input
            id="authPassword"
            ref="passwordInput"
            v-model="password"
            type="password"
            minlength="10"
            maxlength="128"
            :autocomplete="setupMode ? 'new-password' : 'current-password'"
            required
          >
        </div>
        <div id="authConfirmationField" class="field" :hidden="!setupMode">
          <label for="authConfirmation">确认密码</label>
          <input
            id="authConfirmation"
            v-model="confirmation"
            type="password"
            minlength="10"
            maxlength="128"
            autocomplete="new-password"
            :required="setupMode"
          >
        </div>
        <p id="authError" class="auth-error" role="alert" :hidden="!errorMessage">{{ errorMessage }}</p>
        <button id="authSubmitButton" class="primary-button auth-submit" type="submit" :disabled="pending">
          {{ pending ? (setupMode ? "正在设置" : "正在登录") : (setupMode ? "设置并进入" : "登录") }}
        </button>
      </form>
    </div>
    <span class="auth-version">{{ appVersion }}</span>
  </section>
</template>
