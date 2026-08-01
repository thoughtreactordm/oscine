<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ColorField from './ColorField.vue'
import { FONT_STACKS, FONT_STYLES, FONT_WEIGHTS, type TokenDescriptor } from '@shared/theme'

/**
 * One non-ramp token's widget, chosen by its `kind`.
 *
 * The same shape as `SettingControl` a directory up, and for the same reason:
 * the `kind` switch is the one place that knows what a token kind means, so
 * adding a kind is a case here and a descriptor in `tokens.ts`. Narrowed into a
 * ref per kind rather than switched on in the template, because a template loses
 * the narrowing the moment it crosses into an attribute binding and `vue-tsc`
 * says so.
 *
 * Value in, value out. Where the value came from — theme or override — and what
 * reverting it would mean are the row's business, not this component's.
 */
const props = defineProps<{
  descriptor: TokenDescriptor
  /** The effective value: the override if there is one, otherwise the theme's. */
  value: string
  disabled?: boolean
}>()

const emit = defineEmits<{ update: [string] }>()

const kind = computed(() => props.descriptor.kind)

/**
 * Colours commit on every keystroke that parses; everything else commits on
 * `change` — blur, or Enter.
 *
 * Not an inconsistency. A half-typed colour either parses or it does not, so
 * live commits are safe and the preview is worth having. A half-typed `1.5rem`
 * passes through `1`, which is a valid *number* and an invalid length, so the
 * property it lands on drops out and the app reflows under the operator's hands
 * on the way to a value they were always going to reach.
 */
const draft = ref(props.value)

watch(
  () => props.value,
  (next) => {
    draft.value = next
  }
)

function commitDraft(): void {
  const next = draft.value.trim()
  if (next.length > 0 && next !== props.value) emit('update', next)
}

/** The sentinel for T11's free-text escape hatch, which is not a stack. */
const CUSTOM_FAMILY = '__custom'

const matchedStack = computed(
  () => FONT_STACKS.find((stack) => stack.value === props.value)?.id ?? CUSTOM_FAMILY
)

/*
 * Choosing "Custom" is a request to see the text field, not a change of value.
 * Committing something on the way would mean the operator cannot look at what
 * the stack actually is without replacing it.
 */
const askedForCustom = ref(false)
const showCustomFamily = computed(
  () => askedForCustom.value || matchedStack.value === CUSTOM_FAMILY
)

const familyItems = computed(() => [
  ...FONT_STACKS.map((stack) => ({ label: stack.label, value: stack.id })),
  { label: 'Custom…', value: CUSTOM_FAMILY }
])

function onFamily(chosen: unknown): void {
  if (chosen === CUSTOM_FAMILY) {
    askedForCustom.value = true
    return
  }
  const stack = FONT_STACKS.find((entry) => entry.id === chosen)
  if (!stack) return
  askedForCustom.value = false
  emit('update', stack.value)
}

/*
 * Widened to `string` on purpose. `FONT_WEIGHTS` is `as const`, so the items
 * would carry a literal union and `USelect` would then refuse the token's value
 * — which is a `string`, because a theme or an override may hold a weight the
 * curated list does not name. The select showing nothing selected is the right
 * rendering of that; a type error about it is not.
 */
interface Option {
  label: string
  value: string
}

const weightItems: Option[] = FONT_WEIGHTS.map((weight) => ({
  label: weight.label,
  value: weight.value
}))
const styleItems: Option[] = FONT_STYLES.map((style) => ({
  label: style.label,
  value: style.value
}))

const asNumber = computed(() => {
  const parsed = Number.parseFloat(props.value)
  return Number.isFinite(parsed) ? parsed : 0
})

function onNumber(next: unknown): void {
  if (typeof next === 'number' && Number.isFinite(next)) emit('update', String(next))
}

/** What a bare text field should say it wants, since the kind is not on screen. */
const placeholder = computed(() => {
  if (kind.value === 'duration') return 'e.g. 150ms'
  if (kind.value === 'length') return 'e.g. 0.25rem'
  return 'e.g. cubic-bezier(0.4, 0, 0.2, 1)'
})
</script>

<template>
  <ColorField
    v-if="kind === 'color'"
    :value="value"
    :label="descriptor.label"
    :disabled="disabled"
    class="min-w-0 flex-1"
    @update="emit('update', $event)"
  />

  <div v-else-if="kind === 'fontFamily'" class="flex min-w-0 flex-1 flex-col gap-1">
    <USelect
      :model-value="showCustomFamily ? CUSTOM_FAMILY : matchedStack"
      value-key="value"
      :items="familyItems"
      :disabled="disabled"
      size="xs"
      class="w-full"
      :aria-label="descriptor.label"
      @update:model-value="onFamily($event)"
    />
    <!--
      T11's escape hatch, and its cost stated where it is paid: a font that is
      installed here may not exist on the other machine, and W8-13 exports this
      value verbatim.
    -->
    <UInput
      v-if="showCustomFamily"
      :model-value="draft"
      :disabled="disabled"
      size="xs"
      class="w-full"
      placeholder="Font family, or a stack"
      spellcheck="false"
      :aria-label="`${descriptor.label} — font family`"
      @update:model-value="draft = String($event)"
      @change="commitDraft"
    />
  </div>

  <USelect
    v-else-if="kind === 'fontWeight'"
    :model-value="value"
    value-key="value"
    :items="weightItems"
    :disabled="disabled"
    size="xs"
    class="min-w-0 flex-1"
    :aria-label="descriptor.label"
    @update:model-value="emit('update', String($event))"
  />

  <USelect
    v-else-if="kind === 'fontStyle'"
    :model-value="value"
    value-key="value"
    :items="styleItems"
    :disabled="disabled"
    size="xs"
    class="min-w-0 flex-1"
    :aria-label="descriptor.label"
    @update:model-value="emit('update', String($event))"
  />

  <UInputNumber
    v-else-if="kind === 'number'"
    :model-value="asNumber"
    :step="0.05"
    :disabled="disabled"
    size="xs"
    class="min-w-0 flex-1"
    :aria-label="descriptor.label"
    @update:model-value="onNumber($event)"
  />

  <UInput
    v-else
    :model-value="draft"
    :disabled="disabled"
    size="xs"
    class="min-w-0 flex-1"
    :placeholder="placeholder"
    spellcheck="false"
    :aria-label="descriptor.label"
    @update:model-value="draft = String($event)"
    @change="commitDraft"
  />
</template>
