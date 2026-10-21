<script setup lang="ts">
defineProps<{
  label: string;
  steps: { id: string; title: string; detail: string; disabled?: boolean }[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <nav class="protocol-workflow" :aria-label="label">
    <ol>
      <li v-for="(step, index) in steps" :key="step.id">
        <button type="button" :disabled="disabled || step.disabled" @click="emit('select', step.id)">
          <span class="protocol-step-number" aria-hidden="true">{{ index + 1 }}</span>
          <span><strong>{{ step.title }}</strong><small>{{ step.detail }}</small></span>
          <span class="protocol-step-arrow" aria-hidden="true">↗</span>
        </button>
      </li>
    </ol>
  </nav>
</template>
