<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useEqualizerStore } from '@renderer/stores/equalizer'
import EqualizerCurve from '@renderer/panels/tools/EqualizerCurve.vue'
import EqualizerBandTable from '@renderer/panels/tools/EqualizerBandTable.vue'
import {
  DEFAULT_DISPLAY_GAIN_DB,
  DISPLAY_GAIN_RANGES,
  flattenedSpec,
  presetDisplayName
} from '@renderer/panels/tools/equalizerModel'

/**
 * The equalizer, the third tool in the rail — **W19-4**.
 *
 * The frame the card is judged on: the preset bar and the A/B master across the
 * top, the draggable curve, the band table beneath. It owns only the two pieces
 * of state that are the pane's and not the audio's — the displayed dB range and
 * the name prompt — and reads everything else from the equalizer store, which is
 * the sole writer of the three `audio.eq.*` keys.
 */
const eq = useEqualizerStore()

/** ±12 by default; ±24 for the operator cutting a room mode. Display-only, not stored. */
const displayGainDb = ref<number>(DEFAULT_DISPLAY_GAIN_DB)
const rangeItems = DISPLAY_GAIN_RANGES.map((db) => ({ label: `±${db} dB`, value: db }))

/** Whether the curve carries the live spectrum behind it. Display-only, not stored. */
const showSpectrum = ref(false)

const presetItems = computed(() =>
  eq.presets.map((preset) => ({
    label:
      preset.id === eq.appliedPresetId ? presetDisplayName(preset.name, eq.dirty) : preset.name,
    value: preset.id
  }))
)

const hasSelection = computed(() => eq.appliedPresetId !== null)
const appliedName = computed(() => eq.appliedPreset?.name ?? '')

function onRecall(id: unknown): void {
  if (typeof id === 'string') eq.applyPreset(id)
}

function saveOverExisting(): void {
  if (eq.appliedPresetId) eq.updatePreset(eq.appliedPresetId)
}

function deleteSelected(): void {
  if (eq.appliedPresetId) eq.deletePreset(eq.appliedPresetId)
}

function resetFlat(): void {
  eq.active = flattenedSpec(eq.active)
}

// ── The name prompt, shared by Save as… and Rename ───────────────────────────
const prompt = ref<{ mode: 'saveAs' | 'rename'; name: string } | null>(null)
const nameInput = ref<{ inputRef: HTMLInputElement | null } | null>(null)

function openSaveAs(): void {
  prompt.value = { mode: 'saveAs', name: appliedName.value || 'New preset' }
}

function openRename(): void {
  if (!hasSelection.value) return
  prompt.value = { mode: 'rename', name: appliedName.value }
}

const canConfirmPrompt = computed(() => (prompt.value?.name.trim().length ?? 0) > 0)

function confirmPrompt(): void {
  const current = prompt.value
  if (!current) return
  const name = current.name.trim()
  if (name.length === 0) return
  if (current.mode === 'saveAs') {
    eq.savePreset(name)
  } else if (eq.appliedPresetId) {
    eq.renamePreset(eq.appliedPresetId, name)
  }
  prompt.value = null
}

function cancelPrompt(): void {
  prompt.value = null
}

/**
 * The preset actions, folded into one menu beside the selector so the top bar has
 * room for the spectrum toggle. Save is offered only when a recalled preset has
 * actually drifted; the rest need a selection to act on.
 */
const presetMenu = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: 'Save',
      icon: 'i-tabler-device-floppy',
      disabled: !hasSelection.value || !eq.dirty,
      onSelect: saveOverExisting
    },
    { label: 'Save as…', icon: 'i-tabler-copy-plus', onSelect: openSaveAs },
    {
      label: 'Rename',
      icon: 'i-tabler-pencil',
      disabled: !hasSelection.value,
      onSelect: openRename
    },
    {
      label: 'Delete',
      icon: 'i-tabler-trash',
      color: 'error',
      disabled: !hasSelection.value,
      onSelect: deleteSelected
    }
  ],
  [{ label: 'Reset to flat', icon: 'i-tabler-baseline', onSelect: resetFlat }]
])

watch(prompt, async (value) => {
  if (!value) return
  await nextTick()
  const input = nameInput.value?.inputRef
  input?.focus()
  input?.select()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-default">
    <!-- Preset bar + master A/B + range. -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-default px-3 py-2">
      <USwitch
        :model-value="eq.enabled"
        :label="eq.enabled ? 'EQ on' : 'EQ off'"
        aria-label="Equalizer enabled"
        @update:model-value="eq.enabled = $event === true"
      />

      <div class="mx-1 h-5 w-px bg-default" />

      <!-- Preset selector with its actions folded into an adjoining menu. -->
      <UFieldGroup>
        <USelect
          :model-value="eq.appliedPresetId ?? undefined"
          value-key="value"
          :items="presetItems"
          size="xs"
          class="w-44"
          placeholder="Recall preset…"
          aria-label="Recall equalizer preset"
          @update:model-value="onRecall($event)"
        />
        <UDropdownMenu :items="presetMenu" :content="{ align: 'start' }">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-tabler-dots-vertical"
            aria-label="Preset actions"
          />
        </UDropdownMenu>
      </UFieldGroup>

      <UButton
        size="xs"
        :color="showSpectrum ? 'primary' : 'neutral'"
        :variant="showSpectrum ? 'soft' : 'ghost'"
        icon="i-tabler-chart-histogram"
        label="Spectrum"
        :aria-pressed="showSpectrum"
        @click="showSpectrum = !showSpectrum"
      />

      <div class="ml-auto">
        <USelect
          :model-value="displayGainDb"
          value-key="value"
          :items="rangeItems"
          size="xs"
          class="w-24"
          aria-label="Vertical scale"
          @update:model-value="displayGainDb = Number($event)"
        />
      </div>
    </div>

    <EqualizerCurve :max-gain-db="displayGainDb" :show-spectrum="showSpectrum" />

    <!-- Fixed height so adding or removing bands scrolls the table rather than
         resizing the plot and sliding the curve up or down. -->
    <div class="h-56 shrink-0 overflow-y-auto">
      <EqualizerBandTable />
    </div>

    <!-- Save as… / Rename name prompt. -->
    <UModal
      :open="prompt !== null"
      :title="prompt?.mode === 'rename' ? 'Rename preset' : 'Save preset'"
      :description="
        prompt?.mode === 'rename'
          ? 'The name changes; the preset keeps its identity.'
          : 'Saves the current curve as a new named preset.'
      "
      :ui="{ footer: 'justify-end' }"
      @update:open="(value: boolean) => !value && cancelPrompt()"
    >
      <template #body>
        <UFormField label="Preset name" :ui="{ label: 'sr-only' }">
          <UInput
            v-if="prompt"
            ref="nameInput"
            v-model="prompt.name"
            class="w-full"
            placeholder="Preset name"
            aria-label="Preset name"
            @keydown.enter.prevent="confirmPrompt()"
            @keydown.esc.prevent="cancelPrompt()"
          />
        </UFormField>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="cancelPrompt()">Cancel</UButton>
        <UButton color="primary" :disabled="!canConfirmPrompt" @click="confirmPrompt()">
          {{ prompt?.mode === 'rename' ? 'Rename' : 'Save' }}
        </UButton>
      </template>
    </UModal>
  </div>
</template>
