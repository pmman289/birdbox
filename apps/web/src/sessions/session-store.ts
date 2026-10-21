import { computed, ref, watch } from "vue";

import type { SessionMutationRequest } from "@birdbox/contracts/api";

import { useDashboardStore } from "../dashboard/dashboard-store";
import { isEbgpDashboardPeer } from "../dashboard/peer-kind";
import { createSessionDraft, toSessionMutationRequest, type SessionDraft } from "./session-draft";

const { dashboard, loadGeneration } = useDashboardStore();
const draft = ref<SessionDraft | null>(null);
const savedSignature = ref<string | null>(null);
const savedSourceSignature = ref<string | null>(null);
const remoteChanged = ref(false);
const previewPending = ref(false);
const applyPending = ref(false);
const previewConfig = ref<string | null>(null);
const previewContext = ref<string | null>(null);
const lastPreviewSignature = ref<string | null>(null);
const lastPreviewFailureSignature = ref<string | null>(null);

const contextKey = computed(() => {
  const value = dashboard.value;
  return value?.node && isEbgpDashboardPeer(value.selectedPeer) ? `${value.node.id}:${value.selectedPeer.id}` : null;
});

const draftSignature = computed(() => draft.value ? JSON.stringify(draft.value) : null);
const dirty = computed(() => draftSignature.value !== savedSignature.value);
const sourceSignature = computed(() => dashboard.value && isEbgpDashboardPeer(dashboard.value.selectedPeer)
  ? JSON.stringify(createSessionDraft(dashboard.value)) : null);

function resetDraft(clearPreview = true): void {
  draft.value = dashboard.value && isEbgpDashboardPeer(dashboard.value.selectedPeer)
    ? createSessionDraft(dashboard.value)
    : null;
  savedSignature.value = draftSignature.value;
  savedSourceSignature.value = sourceSignature.value;
  remoteChanged.value = false;
  if (clearPreview) {
    previewConfig.value = null;
    previewContext.value = null;
  }
  lastPreviewSignature.value = null;
  lastPreviewFailureSignature.value = null;
}

function setPreviewConfig(config: string | null, context = contextKey.value): void {
  previewConfig.value = config;
  previewContext.value = config ? context : null;
}

function replaceDraft(next: SessionDraft | null, markDirty = true): void {
  draft.value = next;
  if (!markDirty) savedSignature.value = draftSignature.value;
}

function mutateDraft(mutator: (value: SessionDraft) => void): void {
  if (!draft.value) return;
  mutator(draft.value);
}

function rebaseDraft(): void {
  savedSourceSignature.value = sourceSignature.value;
  savedSignature.value = sourceSignature.value;
  remoteChanged.value = false;
  setPreviewConfig(null); lastPreviewSignature.value = null;
}

function sessionPayload(): SessionMutationRequest | null {
  const peer = dashboard.value?.selectedPeer;
  if (!draft.value || !isEbgpDashboardPeer(peer)) return null;
  return toSessionMutationRequest(draft.value, peer);
}

watch([contextKey, loadGeneration, sourceSignature], ([key], previous) => {
  if (key !== previous?.[0] || !dirty.value) resetDraft();
  else remoteChanged.value = sourceSignature.value !== savedSourceSignature.value;
}, { immediate: true });

export function confirmLeaveSession(): boolean {
  if (applyPending.value) return false;
  return !dirty.value || window.confirm("当前 eBGP 会话有未应用修改，是否放弃这些修改？");
}

export function useSessionStore() {
  return {
    draft,
    dirty,
    remoteChanged,
    previewPending,
    applyPending,
    previewConfig,
    previewContext,
    lastPreviewSignature,
    lastPreviewFailureSignature,
    draftSignature,
    contextKey,
    resetDraft,
    replaceDraft,
    mutateDraft,
    rebaseDraft,
    sessionPayload,
    setPreviewConfig,
  };
}
