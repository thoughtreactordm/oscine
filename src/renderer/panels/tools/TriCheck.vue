<script setup lang="ts">
import type { CheckState } from '@renderer/panels/tools/tagWritebackModel'

/**
 * A tri-state checkbox — **W16-6**. Its own control rather than `UCheckbox` so
 * the `some` state is first-class (a minus, not a guessed boolean) and so a
 * virtualized grid of thousands of them stays a plain button with no per-row DOM
 * property to set. `all`/`some`/`none` map to check / minus / empty.
 */
defineProps<{ state: CheckState; ariaLabel?: string; disabled?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    role="checkbox"
    :aria-checked="state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'"
    :aria-label="ariaLabel"
    :disabled="disabled"
    class="grid size-4 shrink-0 place-items-center rounded-sm border transition-colors disabled:opacity-40"
    :class="
      state === 'none'
        ? 'border-default text-transparent hover:border-primary'
        : 'border-primary bg-primary text-inverted'
    "
    @click.stop="emit('toggle')"
  >
    <UIcon v-if="state === 'all'" name="i-tabler-check" class="size-3" />
    <UIcon v-else-if="state === 'some'" name="i-tabler-minus" class="size-3" />
  </button>
</template>
