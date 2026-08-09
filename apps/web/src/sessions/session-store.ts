import { computed, ref, watch } from "vue";

import type { SessionMutationRequest } from "@birdbox/contracts/api";

import { useDashboardStore } from "../dashboard/dashboard-store";
import { createSessionDraft, toSessionMutationRequest, type SessionDraft } from "./session-draft";

const { dashboard, loadGeneration } = useDashboardStore();
const draft = ref<SessionDraft | null>(null);
const dirty = ref(false);
const previewPending = ref(false);
const applyPending = ref(false);
const previewConfig = ref<string | null>(null);
const lastPreviewSignature = ref<string | null>(null);
const lastPreviewFailureSignature = ref<string | null>(null);

const contextKey = computed(() => {
  const value = dashboard.value;
  return value?.node && value.selectedPeer ? `${value.node.id}:${value.selectedPeer.id}` : null;
});

const draftSignature = computed(() => draft.value ? JSON.stringify(draft.value) : null);

function resetDraft(): void {
  draft.value = dashboard.value ? createSessionDraft(dashboard.value) : null;
  dirty.value = false;
  previewConfig.value = null;
  lastPreviewSignature.value = draftSignature.value;
  lastPreviewFailureSignature.value = null;
}

function replaceDraft(next: SessionDraft | null, markDirty = true): void {
  draft.value = next;
  dirty.value = markDirty;
}

function mutateDraft(mutator: (value: SessionDraft) => void): void {
  if (!draft.value) return;
  mutator(draft.value);
  dirty.value = true;
}

function sessionPayload(): SessionMutationRequest | null {
  const peer = dashboard.value?.selectedPeer;
  if (!draft.value || !peer) return null;
  return toSessionMutationRequest(draft.value, peer);
}

watch([contextKey, loadGeneration], resetDraft, { immediate: true });

export function useSessionStore() {
  return {
    draft,
    dirty,
    previewPending,
    applyPending,
    previewConfig,
    lastPreviewSignature,
    lastPreviewFailureSignature,
    draftSignature,
    contextKey,
    resetDraft,
    replaceDraft,
    mutateDraft,
    sessionPayload,
  };
}
