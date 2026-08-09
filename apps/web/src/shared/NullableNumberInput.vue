<script setup lang="ts">
defineOptions({ inheritAttrs: false });

const model = defineModel<number | null>({ required: true });

function update(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  model.value = input.value === "" || !Number.isFinite(input.valueAsNumber) ? null : input.valueAsNumber;
}
</script>

<template>
  <input v-bind="$attrs" type="number" :value="model ?? ''" @input="update">
</template>
