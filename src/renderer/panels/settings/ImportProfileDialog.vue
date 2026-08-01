<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import {
  formatSettingValue,
  importAppliesSomething,
  importPreviewEntries,
  importSummaryLine,
  IMPORT_STATUS_META
} from '@renderer/panels/settings/profileDiff'
import { useSettings } from '@renderer/settings'
import type { SettingsImportMode, SettingsProfileFile } from '@shared/settings'

/**
 * The preview, and the only place merge and replace are chosen between.
 *
 * The card is explicit that the preview is doing real work: applying is one
 * action, and reset undoes it only in the crude sense of putting everything back
 * to what Fermata ships with — which is not what the operator had before. So
 * nothing is written until this dialog is confirmed, and what it lists is
 * computed by the same function main will run when it is.
 *
 * The mode buttons sit above the diff rather than beside the confirm, because
 * changing the mode changes the diff: switching to replace makes rows appear.
 * Putting the choice next to the button that acts on it would hide that.
 */
const props = defineProps<{ file: SettingsProfileFile }>()
const emit = defineEmits<{ close: []; applied: [count: number] }>()

const settings = useSettings()
const toast = useToast()

const mode = ref<SettingsImportMode>('merge')
const running = ref(false)

const plan = computed(() => settings.previewImport(props.file.profile, mode.value))
const entries = computed(() => importPreviewEntries(plan.value))
const summary = computed(() => importSummaryLine(plan.value))
const actionable = computed(() => importAppliesSomething(plan.value))

const ROW_PX = 56

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportPx = ref(0)

/**
 * Virtualized like every other list here.
 *
 * A diff of the shipped registry is a few dozen rows, but the file is not
 * required to hold only shipped keys: unknown ones are preserved rather than
 * dropped, and the boundary lets two thousand of them through. The rule has no
 * exception for the lists that are usually short.
 */
const rowWindow = computed(() =>
  visibleRange({
    total: entries.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => entries.value.slice(rowWindow.value.first, rowWindow.value.last + 1))

function rowTop(index: number): number {
  return (rowWindow.value.first + index) * ROW_PX
}

function measure(el: unknown): void {
  scroller.value = el instanceof HTMLElement ? el : null
  if (scroller.value) viewportPx.value = scroller.value.clientHeight
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewportPx.value = el.clientHeight
}

// Switching mode redraws a different list, and a scroll position from the old
// one means nothing in the new.
watch(mode, () => {
  if (scroller.value) scroller.value.scrollTop = 0
  scrollTop.value = 0
})

async function confirm(): Promise<void> {
  running.value = true
  try {
    const applied = await settings.importProfile(props.file.profile, mode.value)
    emit('applied', applied.apply.length + applied.clear.length)
    emit('close')
  } catch (error) {
    toast.add({
      title: 'Those settings could not be imported',
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  } finally {
    running.value = false
  }
}
</script>

<template>
  <UModal
    open
    :title="`Import settings from ${file.fileName}`"
    :description="summary"
    :ui="{ footer: 'justify-end', content: 'max-w-3xl' }"
    @update:open="(value: boolean) => !value && emit('close')"
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex items-center gap-2" role="radiogroup" aria-label="How to apply">
          <UButton
            v-for="choice in ['merge', 'replace'] as const"
            :key="choice"
            size="xs"
            :color="mode === choice ? 'primary' : 'neutral'"
            :variant="mode === choice ? 'subtle' : 'ghost'"
            role="radio"
            :aria-checked="mode === choice"
            :label="choice === 'merge' ? 'Merge' : 'Replace'"
            @click="mode = choice"
          />
          <p class="min-w-0 flex-1 text-[11px] text-dimmed">
            <template v-if="mode === 'merge'">
              Applies what the file names and leaves everything else as it is.
            </template>
            <template v-else>
              Applies what the file names and puts every other portable setting back to the built-in
              default.
            </template>
          </p>
        </div>

        <div
          :ref="measure"
          class="max-h-[45vh] min-h-40 overflow-y-auto rounded-md border border-default"
          role="list"
          aria-label="What this import would do"
          @scroll="onScroll"
        >
          <div v-if="entries.length === 0" class="px-4 py-10 text-center text-xs text-dimmed">
            This file holds no settings.
          </div>

          <div v-else :style="{ height: `${entries.length * ROW_PX}px`, position: 'relative' }">
            <div
              v-for="(entry, i) in drawn"
              :key="entry.key"
              role="listitem"
              class="absolute inset-x-0 flex items-center gap-3 border-b border-default/40 px-3"
              :style="{ top: `${rowTop(i)}px`, height: `${ROW_PX}px` }"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-medium text-highlighted">
                  {{ entry.label ?? entry.key }}
                </p>
                <p class="truncate text-[11px] text-dimmed">
                  <template v-if="entry.to !== undefined && entry.from !== undefined">
                    {{ formatSettingValue(entry.from) }} → {{ formatSettingValue(entry.to) }}
                  </template>
                  <template v-else-if="entry.reason">{{ entry.reason }}</template>
                  <template v-else>{{ entry.key }}</template>
                </p>
              </div>
              <UBadge
                size="sm"
                variant="subtle"
                :color="IMPORT_STATUS_META[entry.status].tone"
                :icon="IMPORT_STATUS_META[entry.status].icon"
                :label="IMPORT_STATUS_META[entry.status].label"
                class="shrink-0"
              />
            </div>
          </div>
        </div>

        <!--
          Said rather than implied, because it is the one thing about this
          operation that surprises people: a profile carries a configuration, not
          a library, and the folders it was scanned from stay where they are.
        -->
        <p class="text-[11px] text-dimmed">
          Music folders, the output device and anything about this window are never carried between
          machines, in either direction.
        </p>
      </div>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="running" @click="emit('close')">
        Cancel
      </UButton>
      <UButton
        color="primary"
        icon="i-tabler-file-import"
        :disabled="!actionable"
        :loading="running"
        @click="confirm"
      >
        {{ mode === 'merge' ? 'Merge settings' : 'Replace settings' }}
      </UButton>
    </template>
  </UModal>
</template>
