<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { SYSTEM_DEFAULT_OUTPUT_DEVICE } from '@renderer/audio'
import type { SettingDescriptor } from '@shared/settings'

/**
 * The picker for `audio.outputDevice`, and the registry's one custom control.
 *
 * It earns the escape hatch by needing something no descriptor can hold: the
 * options are not a fixed list, they are whatever is plugged into this machine
 * right now, and they change while the settings view is open. A `select` control
 * would have to name its options at module scope, which is exactly the fact
 * about this key that makes it different from `audio.replayGainMode`.
 *
 * Value-in, value-out like every other control — it never reaches for the
 * settings store, so the same component serves the settings view and W8-8's
 * inline popover.
 */
const props = defineProps<{
  descriptor: SettingDescriptor
  modelValue: unknown
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()

interface DeviceOption {
  label: string
  value: string
}

/**
 * The select's stand-in for "no device chosen".
 *
 * `audio.outputDevice` stores the empty string, because that is what
 * `setSinkId` itself means by the system default. Reka's `SelectItem` refuses an
 * empty-string value outright — it reserves it for clearing the selection — and
 * throws in setup rather than rendering an unusable row. So the empty string
 * stops at this component's edge: it is what arrives, what is emitted, and never
 * what a `SelectItem` is given.
 */
const SYSTEM_DEFAULT_ITEM = 'system-default'

const devices = ref<DeviceOption[]>([])
/** Null while the first enumeration is in flight; a message when it failed. */
const problem = ref<string | null>(null)

const selected = computed(() =>
  typeof props.modelValue === 'string' ? props.modelValue : SYSTEM_DEFAULT_OUTPUT_DEVICE
)

/** What the select shows as chosen, with the empty string mapped out of the way. */
const selectedItem = computed(() =>
  selected.value === SYSTEM_DEFAULT_OUTPUT_DEVICE ? SYSTEM_DEFAULT_ITEM : selected.value
)

/**
 * The system default is always offered and always first.
 *
 * It is not a device — it is the absence of a choice — which is why Chromium's
 * own `default` entry is filtered out below rather than listed beside it. The
 * two mean the same thing, and offering both would be offering a choice that
 * does not exist.
 */
const items = computed<DeviceOption[]>(() => {
  const listed = [{ label: 'System default', value: SYSTEM_DEFAULT_ITEM }, ...devices.value]
  // A stored device that is not plugged in right now still has to be shown, or
  // the control would silently report the system default while the setting says
  // otherwise — and picking anything else would then be the only way to find out.
  if (selected.value && !listed.some((item) => item.value === selectedItem.value)) {
    listed.push({ label: 'Selected device (not connected)', value: selected.value })
  }
  return listed
})

function onSelect(value: unknown): void {
  emit('update:modelValue', value === SYSTEM_DEFAULT_ITEM ? SYSTEM_DEFAULT_OUTPUT_DEVICE : value)
}

/**
 * Labels are empty until permission is granted, which is the browser's rule and
 * not something to work around: an unlabelled device list is still a usable one,
 * and Electron grants media permission to the app's own origin, so in practice
 * this fills in.
 */
async function refresh(): Promise<void> {
  const media = navigator.mediaDevices
  if (!media?.enumerateDevices) {
    problem.value = 'This runtime cannot list audio devices.'
    return
  }
  try {
    const all = await media.enumerateDevices()
    devices.value = all
      .filter((device) => device.kind === 'audiooutput' && device.deviceId !== 'default')
      .map((device, index) => ({
        label: device.label || `Output ${index + 1}`,
        value: device.deviceId
      }))
    problem.value = null
  } catch (error) {
    problem.value = (error as Error).message
  }
}

function onDeviceChange(): void {
  void refresh()
}

onMounted(() => {
  void refresh()
  navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange)
})

onUnmounted(() => {
  navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
})
</script>

<template>
  <div class="flex min-w-0 items-center justify-end gap-2">
    <USelect
      :model-value="selectedItem"
      value-key="value"
      :items="items"
      :disabled="disabled"
      size="sm"
      class="w-64"
      :aria-label="descriptor.label"
      @update:model-value="onSelect($event)"
    />
    <span v-if="problem" class="shrink-0 text-[11px] text-dimmed">{{ problem }}</span>
  </div>
</template>
