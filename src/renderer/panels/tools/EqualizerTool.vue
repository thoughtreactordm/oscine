<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { parseParametricEq } from '@shared/audio/parametricEq'
import { FALLBACK_SAMPLE_RATE_HZ, suggestedPreampDb } from '@renderer/audio/eqResponse'
import { useEqualizerStore } from '@renderer/stores/equalizer'
import EqualizerCurve from '@renderer/panels/tools/EqualizerCurve.vue'
import EqualizerBandTable from '@renderer/panels/tools/EqualizerBandTable.vue'
import {
  DEFAULT_DISPLAY_GAIN_DB,
  DISPLAY_GAIN_RANGES,
  flattenedSpec,
  formatGain,
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
const toast = useToast()

/** ±12 by default; ±24 for the operator cutting a room mode. Display-only, not stored. */
const displayGainDb = ref<number>(DEFAULT_DISPLAY_GAIN_DB)
const rangeItems = DISPLAY_GAIN_RANGES.map((db) => ({ label: `±${db} dB`, value: db }))

/** Whether the curve carries the live spectrum behind it. Display-only, not stored. */
const showSpectrum = ref(false)

// ── Pre-amp, auto-gain and the clip indicator (R11) ──────────────────────────

/** The slider's range: cut deep for headroom, boost only a little, default 0. */
const PREAMP_MIN_DB = -24
const PREAMP_MAX_DB = 12
/** 0.1 dB, so the slider and stepper move in tenths rather than snapping to half-dB. */
const PREAMP_STEP_DB = 0.1

function setPreamp(value: number | number[] | null | undefined): void {
  if (value === null || value === undefined) return
  // `setPreamp` drops a non-finite value; the slider hands a number, the numeric
  // entry a number or nothing mid-edit.
  eq.setPreamp(typeof value === 'number' ? value : (value[0] ?? Number.NaN))
}

/**
 * What Auto would set, computed live off the current curve at the rate the pane
 * draws at so the button can show it before it is pressed. Independent of the
 * pre-amp already set (see `suggestedPreampDb`), so applying it and looking again
 * shows the same number rather than creeping toward silence.
 */
const autoPreampDb = computed(() => suggestedPreampDb(eq.active, FALLBACK_SAMPLE_RATE_HZ))
const autoLabel = computed(() => `Auto: ${formatGain(autoPreampDb.value)}`)
/** Already applied: pressing Auto would be a no-op, so the button rests disabled. */
const autoApplied = computed(() => Math.abs(autoPreampDb.value - eq.active.preampDb) < 0.05)

function applyAuto(): void {
  eq.setPreamp(autoPreampDb.value)
}

/**
 * Bracket a preamp *slider* drag so its stream of writes is one undo step, not
 * thirty (W19-10). The stepper and the numeric field commit discretely and need no
 * bracket. The end listener is on `window` because a slider drag can release off
 * the thumb; `once` cleans it up whichever way the pointer ends.
 */
function beginPreampDrag(): void {
  eq.beginInteractive()
  const end = (): void => eq.endInteractive()
  window.addEventListener('pointerup', end, { once: true })
  window.addEventListener('pointercancel', end, { once: true })
}

// ── Undo/redo (W19-10) ─────────────────────────────────────────────────────────
// Ctrl/⌘+Z and Ctrl/⌘+Shift+Z (plus Ctrl+Y) drive the store's curve history while
// the pane is mounted. A text field keeps its own native undo — an operator typing
// a frequency wants their keystrokes back, not the whole curve — so a keystroke
// aimed at an input is left alone.
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

function onUndoKey(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  if (isTextEntry(event.target)) return
  const key = event.key.toLowerCase()
  if (key === 'z') {
    event.preventDefault()
    if (event.shiftKey) eq.redo()
    else eq.undo()
  } else if (key === 'y' && !event.shiftKey) {
    event.preventDefault()
    eq.redo()
  }
}

// The clip indicator polls the EQ output only while this pane is mounted: the
// analyser is attached on the first frame and released on unmount, so an operator
// who never opens the pane pays nothing and a leaked frame cannot outlive the
// pane — the shape W18-7's leaked interval taught.
onMounted(() => {
  eq.startClipMonitor()
  // W19-6: the assignments list is a snapshot, refreshed on open and whenever the
  // preset set moves — deleting a preset is what makes an assignment dangle, and
  // the list is where that has to become visible.
  void eq.refreshAssignments()
  window.addEventListener('keydown', onUndoKey)
})
onUnmounted(() => {
  eq.stopClipMonitor()
  window.removeEventListener('keydown', onUndoKey)
})

watch(
  () => eq.presets,
  () => void eq.refreshAssignments()
)

/** A short label for an assignment's entity kind, for the list. */
const SCOPE_LABEL: Record<string, string> = {
  album: 'Album',
  artist: 'Artist',
  playlist: 'Playlist'
}

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

// ── AutoEq / Equalizer APO text import ───────────────────────────────────────
const importOpen = ref(false)
const importText = ref('')
const importError = ref('')

function openImport(): void {
  importText.value = ''
  importError.value = ''
  importOpen.value = true
}

function runImport(): void {
  const result = parseParametricEq(importText.value)
  if (!result) {
    importError.value =
      'No parametric filters found. Paste an AutoEq / Equalizer APO ParametricEQ.txt profile.'
    return
  }
  eq.active = result.spec
  importOpen.value = false
  toast.add({
    title: `Imported ${result.filtersRead} ${result.filtersRead === 1 ? 'filter' : 'filters'}.${
      eq.enabled ? '' : ' Turn on the EQ to hear it.'
    }`,
    description: result.warnings.length > 0 ? result.warnings.join(' ') : undefined,
    icon: 'i-tabler-file-import',
    color: result.warnings.length > 0 ? 'warning' : 'primary'
  })
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
  [
    { label: 'Import text…', icon: 'i-tabler-file-import', onSelect: openImport },
    { label: 'Reset to flat', icon: 'i-tabler-baseline', onSelect: resetFlat }
  ]
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

      <!-- Undo/redo over the curve (W19-10). Keyboard is Ctrl/⌘+Z / +Shift+Z. -->
      <UFieldGroup>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-tabler-arrow-back-up"
          :disabled="!eq.canUndo"
          aria-label="Undo equalizer change"
          title="Undo (Ctrl+Z)"
          @click="eq.undo()"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-tabler-arrow-forward-up"
          :disabled="!eq.canRedo"
          aria-label="Redo equalizer change"
          title="Redo (Ctrl+Shift+Z)"
          @click="eq.redo()"
        />
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

      <!-- In-situ override editing (W19-11): flip the editor's target from the
           global curve to the audible track's per-entity override, so it can be
           dialed in by ear and saved to the preset without touching the global.
           A persistent mode that follows tracks — the badge says whether it is
           actually on an override or falling through to the global. -->
      <UButton
        size="xs"
        :color="eq.editingOverride ? 'primary' : 'neutral'"
        :variant="eq.editingOverride ? 'soft' : 'ghost'"
        icon="i-tabler-pencil"
        label="Edit override"
        :aria-pressed="eq.editingOverride"
        @click="eq.editingOverride = !eq.editingOverride"
      />
      <span
        v-if="eq.editingOverride"
        class="shrink-0 text-xs"
        :class="eq.editingOverrideActive ? 'text-primary' : 'text-muted'"
      >
        {{
          eq.editingOverrideActive
            ? "Editing this track's override"
            : 'No override — editing global'
        }}
      </span>

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

    <!-- Headroom: the pre-amp, its auto-set, and the honest clip light (R11). -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-default px-3 py-2">
      <span class="shrink-0 text-xs font-medium text-muted">Preamp</span>
      <USlider
        :model-value="eq.active.preampDb"
        :min="PREAMP_MIN_DB"
        :max="PREAMP_MAX_DB"
        :step="PREAMP_STEP_DB"
        size="xs"
        class="min-w-32 max-w-56 flex-1"
        aria-label="Equalizer pre-amp"
        @pointerdown="beginPreampDrag"
        @update:model-value="setPreamp($event)"
      />
      <UInputNumber
        :model-value="eq.active.preampDb"
        :min="PREAMP_MIN_DB"
        :max="PREAMP_MAX_DB"
        :step="PREAMP_STEP_DB"
        :format-options="{ minimumFractionDigits: 1, maximumFractionDigits: 2 }"
        size="xs"
        class="w-24"
        aria-label="Equalizer pre-amp, dB"
        @update:model-value="setPreamp($event)"
      />
      <span class="shrink-0 text-[11px] text-dimmed">dB</span>

      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-tabler-wand"
        :label="autoLabel"
        :disabled="autoApplied"
        title="Set the pre-amp to just cancel the curve's loudest boost"
        @click="applyAuto"
      />

      <UTooltip
        text="Clipping in the EQ output — lower the pre-amp or the boost. Click to clear."
        class="ml-auto"
      >
        <UButton
          size="xs"
          :color="eq.clipping ? 'error' : 'neutral'"
          :variant="eq.clipping ? 'solid' : 'ghost'"
          :icon="eq.clipping ? 'i-tabler-alert-triangle-filled' : 'i-tabler-activity'"
          label="Clip"
          :aria-pressed="eq.clipping"
          aria-label="EQ output clipping indicator"
          @click="eq.clearClip"
        />
      </UTooltip>
    </div>

    <EqualizerCurve :max-gain-db="displayGainDb" :show-spectrum="showSpectrum" />

    <!-- Fixed height so adding or removing bands scrolls the table rather than
         resizing the plot and sliding the curve up or down. -->
    <div class="h-56 shrink-0 overflow-y-auto">
      <EqualizerBandTable />
    </div>

    <!-- W19-6: every entity assigned a preset, so an assignment is discoverable
         and revocable from one place rather than being a haunting. -->
    <div
      v-if="eq.assignments.length > 0"
      class="min-h-0 flex-1 overflow-y-auto border-t border-default px-3 py-2"
    >
      <div class="mb-1.5 flex items-center gap-2">
        <UIcon name="i-tabler-link" class="size-4 text-dimmed" />
        <span class="text-xs font-medium text-muted">Assigned to</span>
      </div>
      <ul class="flex flex-col gap-1">
        <li
          v-for="row in eq.assignments"
          :key="`${row.scope.kind}:${row.scope.id}`"
          class="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-elevated"
        >
          <span class="shrink-0 text-[11px] uppercase text-dimmed">
            {{ SCOPE_LABEL[row.scope.kind] ?? row.scope.kind }}
          </span>
          <span class="min-w-0 flex-1 truncate text-default" :title="row.entityName">
            {{ row.entityName }}
          </span>
          <span
            v-if="row.dangling"
            class="shrink-0 text-xs text-error"
            title="The assigned preset was deleted — this entity plays flat until reassigned."
          >
            preset deleted
          </span>
          <span v-else class="shrink-0 truncate text-xs text-muted" :title="row.presetName ?? ''">
            {{ row.presetName }}
          </span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-tabler-x"
            :aria-label="`Remove EQ assignment from ${row.entityName}`"
            title="Remove this assignment"
            @click="eq.assign(row.scope, null)"
          />
        </li>
      </ul>
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

    <!-- Paste an AutoEq / Equalizer APO ParametricEQ.txt profile. -->
    <UModal
      :open="importOpen"
      title="Import EQ profile"
      description="Paste an AutoEq / Equalizer APO ParametricEQ.txt — e.g. an oratory1990 profile."
      :ui="{ footer: 'justify-end' }"
      @update:open="(value: boolean) => (importOpen = value)"
    >
      <template #body>
        <textarea
          v-model="importText"
          rows="10"
          spellcheck="false"
          class="w-full resize-y rounded-md border border-default bg-elevated px-3 py-2 font-mono text-xs text-default focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="Preamp: -6.7 dB&#10;Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70&#10;Filter 2: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70"
          aria-label="Parametric EQ profile text"
        />
        <p v-if="importError" role="alert" class="mt-2 text-xs text-error">{{ importError }}</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="importOpen = false">Cancel</UButton>
        <UButton
          color="primary"
          icon="i-tabler-file-import"
          :disabled="importText.trim().length === 0"
          @click="runImport"
        >
          Import
        </UButton>
      </template>
    </UModal>
  </div>
</template>
