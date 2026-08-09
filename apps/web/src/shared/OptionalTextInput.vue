<script setup lang="ts">
defineOptions({ inheritAttrs: false });

const model = defineModel<string | null>({ required: true });

function update(event: Event): void {
  const value = (event.currentTarget as HTMLInputElement).value;
  model.value = value || null;
}
</script>

<template>
  <input v-bind="$attrs" :value="model ?? ''" @input="update">
</template>
