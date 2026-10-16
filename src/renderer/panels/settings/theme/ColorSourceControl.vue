<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { theme as themeIpc } from '@renderer/ipc'
import { noctaliaStatus } from '@renderer/theme/useNoctaliaSync'
import type { SettingDescriptor } from '@shared/settings'
import type { NoctaliaVersion, ThemeColorSource } from '@shared/theme'

/**
 * `theme.colorSource` on the settings surface, and the register's fourth custom
 * entry.
 *
 * A plain `select` would carry the choice but not what makes it work: Noctalia
 * only writes our palette once our template is installed, and whether it has —
 * waiting, synced, or a bad write — is main's live status, not a stored value.
 * Setup is a command, the same kind of thing `AppUpdates` holds, and stays a
 * button rather than becoming a key.
 *
 * The row holds only the choice, a status mark and the trigger, for the reason
 * `ThemeEditorControl` gives: rows are a fixed `SETTING_ROW_PX` in a virtualized
 * list, and anything that grows the control spills over its neighbours. The
 * status message, the version choice and what setup said live in a modal.
 *
 * Only drawn on Linux (`platforms` on the descriptor).
 */
const props = defineProps<{
  descriptor: SettingDescriptor
  modelValue: unknown
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()

const SOURCES: { label: string; value: ThemeColorSource }[] = [
  { label: 'Oscine theme', value: 'oscine' },
  { label: 'Noctalia desktop', value: 'noctalia' }
]

const VERSIONS: { label: string; value: NoctaliaVersion }[] = [
  { label: 'Detect version', value: 'auto' },
  { label: 'Quickshell v4', value: 'v4' },
  { label: 'Noctalia v5+', value: 'v5' }
]

const open = ref(false)
const version = ref<NoctaliaVersion>('auto')
const busy = ref(false)
/** What the last setup or retry said, until the next one. */
const outcome = ref<{ ok: boolean; message: string } | null>(null)

const source = computed<ThemeColorSource>(() =>
  props.modelValue === 'noctalia' ? 'noctalia' : 'oscine'
)
const selected = computed(() => source.value === 'noctalia')
const status = computed(() => noctaliaStatus.value)

/** The status mark's icon and tone, by state. */
const indicator = computed(() => {
  switch (status.value?.state) {
    case 'synced':
      return { icon: 'i-tabler-circle-check', tone: 'text-success' }
    case 'error':
      return { icon: 'i-tabler-alert-triangle', tone: 'text-error' }
    default:
      return { icon: 'i-tabler-clock', tone: 'text-dimmed' }
  }
})

/**
 * Choosing Noctalia opens setup only if it turns out to be needed. The status at
 * the moment of choosing is always `disabled` — the watch has not started — so
 * the decision waits for main's first answer: already synced means setup was
 * done before, and the modal would be a box to dismiss.
 */
let openWhenNeeded = false

watch(status, (next) => {
  if (!openWhenNeeded || !selected.value || !next || next.state === 'disabled') return
  openWhenNeeded = false
  if (next.state === 'waiting' || next.state === 'error') open.value = true
})

function choose(value: unknown): void {
  if (value === 'noctalia' && !selected.value) openWhenNeeded = true
  emit('update:modelValue', value)
}

async function setUp(): Promise<void> {
  busy.value = true
  try {
    const result = await themeIpc.noctaliaSetup(version.value)
    outcome.value = { ok: true, message: result.message }
  } catch (error) {
    outcome.value = { ok: false, message: (error as Error).message }
  } finally {
    busy.value = false
  }
}

async function retry(): Promise<void> {
  busy.value = true
  outcome.value = null
  try {
    await themeIpc.noctaliaRetry()
  } catch (error) {
    outcome.value = { ok: false, message: (error as Error).message }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-w-0 items-center justify-end gap-2">
    <UTooltip v-if="selected && status?.message" :text="status.message">
      <UIcon
        :name="indicator.icon"
        class="size-4 shrink-0"
        :class="indicator.tone"
        role="status"
        :aria-label="status.message"
      />
    </UTooltip>

    <USelect
      :model-value="source"
      value-key="value"
      :items="SOURCES"
      :disabled="disabled"
      size="sm"
      class="w-40"
      :aria-label="descriptor.label"
      @update:model-value="choose($event)"
    />

    <UButton
      v-if="selected"
      color="neutral"
      variant="subtle"
      size="sm"
      icon="i-tabler-plug-connected"
      label="Set up…"
      :disabled="disabled"
      class="shrink-0"
      @click="open = true"
    />

    <UModal
      v-model:open="open"
      title="Noctalia sync"
      description="Installs Oscine’s template into Noctalia, so every color scheme change reaches Oscine. Surfaces, text and the supporting colors follow the desktop; the accent stays with your theme or the cover art."
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p v-if="status?.message" class="flex items-start gap-2 text-sm text-toned" role="status">
            <UIcon :name="indicator.icon" class="mt-0.5 size-4 shrink-0" :class="indicator.tone" />
            <span>{{ status.message }}</span>
          </p>

          <div class="flex flex-wrap items-center gap-2">
            <USelect
              v-model="version"
              value-key="value"
              :items="VERSIONS"
              :disabled="disabled || busy"
              size="sm"
              class="w-40"
              aria-label="Noctalia version"
            />
            <UButton
              size="sm"
              color="primary"
              variant="soft"
              icon="i-tabler-plug-connected"
              label="Set up Noctalia"
              :loading="busy"
              :disabled="disabled || busy"
              @click="setUp"
            />
            <UButton
              v-if="status?.state === 'error' || status?.state === 'waiting'"
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-tabler-refresh"
              label="Retry sync"
              :disabled="disabled || busy"
              @click="retry"
            />
          </div>

          <p v-if="outcome" class="text-xs" :class="outcome.ok ? 'text-muted' : 'text-error'">
            {{ outcome.message }}
          </p>
        </div>
      </template>
    </UModal>
  </div>
</template>
