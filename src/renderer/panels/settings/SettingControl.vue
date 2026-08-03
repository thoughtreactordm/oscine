<script setup lang="ts">
import { computed } from 'vue'
import { customSettingControl } from '@renderer/panels/settings/customControls'
import type { SettingDescriptor } from '@shared/settings'

/**
 * One descriptor's widget, and nothing else.
 *
 * Deliberately value-in, value-out: it takes a descriptor and a value and emits
 * a new one, and it never reaches for the settings store. That is what lets the
 * same component render a global key in the settings view, a per-playlist
 * override in an entity context, and W8-8's inline popover — three callers with
 * three ideas about where the value comes from and one idea about what the
 * control looks like. A control that fetched its own value would have to pick
 * one of them.
 *
 * The `kind` switch is the only place in the renderer that knows what a control
 * hint means. Adding a control kind is a case here and a descriptor there.
 */
const props = defineProps<{
  descriptor: SettingDescriptor
  modelValue: unknown
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()

/*
 * Narrowed into its own ref per kind rather than switched on in the template.
 * `v-if="control.kind === 'number'"` reads better and does not survive
 * `vue-tsc`: the constraints hang off the narrowed member, and the template
 * loses the narrowing the moment it crosses into an attribute binding.
 */
const control = computed(() => props.descriptor.control)

const toggle = computed(() => (control.value?.kind === 'toggle' ? control.value : null))
const number = computed(() => (control.value?.kind === 'number' ? control.value : null))
const slider = computed(() => (control.value?.kind === 'slider' ? control.value : null))
const select = computed(() => (control.value?.kind === 'select' ? control.value : null))
const path = computed(() => (control.value?.kind === 'path' ? control.value : null))
const text = computed(() => (control.value?.kind === 'text' ? control.value : null))
const custom = computed(() => (control.value?.kind === 'custom' ? control.value : null))

const customComponent = computed(() =>
  custom.value ? customSettingControl(custom.value.component) : null
)

/*
 * What a select can hold, as far as the widget is concerned.
 *
 * This component takes `unknown` because a descriptor's value type is the
 * descriptor's business, and `USelect` wants something narrower. The cast is
 * over data the registry has already spoken for — the options are the
 * descriptor's own, and the value came out of a store that validated it against
 * the same descriptor — so it is a narrowing of provenance, not a guess.
 */
type SelectValue = string | number | boolean

const selectItems = computed(() =>
  (select.value?.options ?? []).map((option) => ({
    label: option.label,
    value: option.value as SelectValue
  }))
)

const selectValue = computed(() => props.modelValue as SelectValue | undefined)

const asBoolean = computed(() => props.modelValue === true)
const asNumber = computed(() => (typeof props.modelValue === 'number' ? props.modelValue : 0))
const asString = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''))

/** What a slider shows next to itself, since a slider alone reports nothing. */
const readout = computed(() => {
  const unit = slider.value?.unit
  return unit ? `${asNumber.value} ${unit}` : String(asNumber.value)
})

function update(value: unknown): void {
  emit('update:modelValue', value)
}
</script>

<template>
  <div class="flex min-w-0 items-center justify-end gap-2">
    <USwitch
      v-if="toggle"
      :model-value="asBoolean"
      :disabled="disabled"
      :aria-label="descriptor.label"
      @update:model-value="update($event)"
    />

    <template v-else-if="number">
      <UInputNumber
        :model-value="asNumber"
        :min="number.min"
        :max="number.max"
        :step="number.step"
        :disabled="disabled"
        size="sm"
        class="w-32"
        :aria-label="descriptor.label"
        @update:model-value="update($event)"
      />
      <span v-if="number.unit" class="shrink-0 text-[11px] text-dimmed">{{ number.unit }}</span>
    </template>

    <template v-else-if="slider">
      <USlider
        :model-value="asNumber"
        :min="slider.min"
        :max="slider.max"
        :step="slider.step"
        :disabled="disabled"
        size="xs"
        class="min-w-24 flex-1"
        :aria-label="descriptor.label"
        @update:model-value="update($event)"
      />
      <span class="w-20 shrink-0 text-right text-[11px] tabular-nums text-muted">
        {{ readout }}
      </span>
    </template>

    <USelect
      v-else-if="select"
      :model-value="selectValue"
      value-key="value"
      :items="selectItems"
      :disabled="disabled"
      size="sm"
      class="w-44"
      :aria-label="descriptor.label"
      @update:model-value="update($event)"
    />

    <UInput
      v-else-if="path"
      :model-value="asString"
      :disabled="disabled"
      size="sm"
      class="w-64"
      :placeholder="path.select === 'directory' ? 'Folder path' : 'File path'"
      :aria-label="descriptor.label"
      @update:model-value="update($event)"
    />

    <UInput
      v-else-if="text"
      :model-value="asString"
      :disabled="disabled"
      size="sm"
      class="w-64"
      :placeholder="text.placeholder"
      :aria-label="descriptor.label"
      @update:model-value="update($event)"
    />

    <component
      :is="customComponent"
      v-else-if="customComponent"
      :descriptor="descriptor"
      :model-value="modelValue"
      :disabled="disabled"
      @update:model-value="update($event)"
    />

    <!--
      Two ways to get here, both worth saying out loud: a descriptor naming a
      custom component that is not registered, and — because `control` is null
      exactly when `internal` — a row that should never have been built at all.
    -->
    <span v-else class="text-[11px] text-dimmed">
      {{ custom ? `No control registered for “${custom.component}”` : 'No control' }}
    </span>
  </div>
</template>
