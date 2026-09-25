<script setup lang="ts">
import { ref } from 'vue'

/**
 * A list tag's input — **W16-18**, Decision G. One chip per value, in the order
 * the frame holds them: add with Enter (or on leaving the field), remove with
 * the chip's ✕, and move a value earlier with its ← (order is part of the value
 * — the first composer is the one players show). Commas are allowed inside a
 * value, since names carry them; Enter is the only separator.
 */
const props = defineProps<{
  readonly modelValue: readonly string[]
  readonly id?: string
  readonly placeholder?: string
  readonly disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string[]): void
}>()

const draft = ref('')

function commit(): void {
  const entry = draft.value.trim()
  if (entry === '') return
  emit('update:modelValue', [...props.modelValue, entry])
  draft.value = ''
}

function remove(index: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, at) => at !== index)
  )
}

function moveEarlier(index: number): void {
  if (index === 0) return
  const next = [...props.modelValue]
  const [entry] = next.splice(index, 1)
  next.splice(index - 1, 0, entry)
  emit('update:modelValue', next)
}

function onBackspace(): void {
  if (draft.value === '' && props.modelValue.length > 0) remove(props.modelValue.length - 1)
}
</script>

<template>
  <div
    class="flex min-h-8 flex-wrap items-center gap-1 rounded-md bg-default px-1.5 py-1 ring ring-inset ring-accented focus-within:ring-2 focus-within:ring-primary"
    :class="disabled ? 'opacity-75' : ''"
  >
    <span
      v-for="(entry, index) in modelValue"
      :key="`${index}:${entry}`"
      class="group inline-flex max-w-full items-center gap-0.5 rounded bg-elevated px-1.5 py-0.5 text-xs text-default"
    >
      <button
        v-if="index > 0 && !disabled"
        type="button"
        class="hidden text-dimmed hover:text-default group-hover:inline-flex"
        :aria-label="`Move ${entry} earlier`"
        title="Move earlier"
        @click="moveEarlier(index)"
      >
        <UIcon name="i-tabler-chevron-left" class="size-3" />
      </button>
      <span class="truncate">{{ entry }}</span>
      <button
        v-if="!disabled"
        type="button"
        class="inline-flex text-dimmed hover:text-default"
        :aria-label="`Remove ${entry}`"
        @click="remove(index)"
      >
        <UIcon name="i-tabler-x" class="size-3" />
      </button>
    </span>
    <input
      :id="id"
      v-model="draft"
      type="text"
      class="min-w-24 flex-1 bg-transparent px-1 text-sm text-highlighted outline-none placeholder:text-dimmed"
      :placeholder="modelValue.length === 0 ? placeholder : ''"
      :disabled="disabled"
      @keydown.enter.prevent="commit"
      @keydown.backspace="onBackspace"
      @blur="commit"
    />
  </div>
</template>
