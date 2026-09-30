<script setup lang="ts">
import { ref } from 'vue'
import type { EqualizerBand } from '@shared/audio/equalizer'
import { EQUALIZER_BAND_TYPES } from '@shared/audio/equalizer'
import { useEqualizerStore } from '@renderer/stores/equalizer'
import {
  FILTER_TYPE_LABELS,
  removeBand,
  typeUsesGain,
  updateBand
} from '@renderer/panels/tools/equalizerModel'

/**
 * The band table — **W19-4**.
 *
 * The half of the pane the plot cannot be: precision a drag cannot reach
 * ("3.20 kHz, −4.5 dB, Q 2.10"), the keyboard path for an operator with no
 * pointer, and the filter type, which has no sensible gesture. It binds to the
 * same `audio.eq.active` the curve does, so a drag moves these numbers and typing
 * moves the handle — one source, no echo.
 *
 * A number field carries a draft while it is being edited so the clamp never
 * rewrites the box mid-keystroke; the value is committed on change / Enter / blur,
 * once. A parse that is not finite is dropped, never written — a `NaN` reaching
 * the settings validator would take the whole curve down to flat.
 */
const eq = useEqualizerStore()

type NumericField = 'frequencyHz' | 'gainDb' | 'q'

const typeItems = EQUALIZER_BAND_TYPES.map((type) => ({
  label: FILTER_TYPE_LABELS[type],
  value: type
}))

// The one field being edited, if any; everything else shows the stored value.
const editing = ref<{ id: string; field: NumericField; value: string } | null>(null)

function displayValue(band: EqualizerBand, field: NumericField): string {
  if (editing.value && editing.value.id === band.id && editing.value.field === field) {
    return editing.value.value
  }
  if (field === 'frequencyHz') return String(Math.round(band.frequencyHz))
  if (field === 'gainDb') return band.gainDb.toFixed(1)
  return band.q.toFixed(2)
}

function onInput(band: EqualizerBand, field: NumericField, value: string): void {
  editing.value = { id: band.id, field, value }
}

function commit(band: EqualizerBand, field: NumericField): void {
  const draft = editing.value
  editing.value = null
  if (!draft || draft.id !== band.id || draft.field !== field) return
  const parsed = Number(draft.value)
  if (!Number.isFinite(parsed)) return
  eq.active = updateBand(eq.active, band.id, { [field]: parsed })
}

function onType(band: EqualizerBand, type: unknown): void {
  eq.active = updateBand(eq.active, band.id, { type: type as EqualizerBand['type'] })
}

function onEnabled(band: EqualizerBand, enabled: boolean): void {
  eq.active = updateBand(eq.active, band.id, { enabled })
}

function remove(band: EqualizerBand): void {
  eq.active = removeBand(eq.active, band.id)
}
</script>

<template>
  <div class="shrink-0 overflow-x-auto border-t border-default">
    <table class="w-full min-w-[36rem] text-xs">
      <thead>
        <tr class="text-left text-[11px] text-dimmed">
          <th scope="col" class="w-8 px-3 py-1.5 font-medium">#</th>
          <th scope="col" class="px-3 py-1.5 font-medium">Type</th>
          <th scope="col" class="px-3 py-1.5 font-medium">Freq (Hz)</th>
          <th scope="col" class="px-3 py-1.5 font-medium">Gain (dB)</th>
          <th scope="col" class="px-3 py-1.5 font-medium">Q</th>
          <th scope="col" class="px-3 py-1.5 text-center font-medium">On</th>
          <th scope="col" class="w-10 px-3 py-1.5"><span class="sr-only">Remove</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="eq.active.bands.length === 0">
          <td colspan="7" class="px-3 py-4 text-center text-dimmed">
            No bands yet. Double-click the curve to add one.
          </td>
        </tr>
        <tr
          v-for="(band, index) in eq.active.bands"
          :key="band.id"
          class="border-t border-default/50"
          :class="band.enabled ? '' : 'opacity-60'"
        >
          <td class="px-3 py-1 tabular-nums text-dimmed">{{ index + 1 }}</td>
          <td class="px-3 py-1">
            <USelect
              :model-value="band.type"
              value-key="value"
              :items="typeItems"
              size="xs"
              class="w-28"
              :aria-label="`Filter type, band ${index + 1}`"
              @update:model-value="onType(band, $event)"
            />
          </td>
          <td class="px-3 py-1">
            <UInput
              :model-value="displayValue(band, 'frequencyHz')"
              type="number"
              size="xs"
              class="w-24"
              :aria-label="`Frequency in hertz, band ${index + 1}`"
              @update:model-value="onInput(band, 'frequencyHz', String($event))"
              @change="commit(band, 'frequencyHz')"
              @blur="commit(band, 'frequencyHz')"
              @keydown.enter.prevent="commit(band, 'frequencyHz')"
            />
          </td>
          <td class="px-3 py-1">
            <UInput
              :model-value="typeUsesGain(band.type) ? displayValue(band, 'gainDb') : ''"
              type="number"
              size="xs"
              step="0.5"
              class="w-20"
              :disabled="!typeUsesGain(band.type)"
              :placeholder="typeUsesGain(band.type) ? '' : 'n/a'"
              :aria-label="`Gain in decibels, band ${index + 1}`"
              @update:model-value="onInput(band, 'gainDb', String($event))"
              @change="commit(band, 'gainDb')"
              @blur="commit(band, 'gainDb')"
              @keydown.enter.prevent="commit(band, 'gainDb')"
            />
          </td>
          <td class="px-3 py-1">
            <UInput
              :model-value="displayValue(band, 'q')"
              type="number"
              size="xs"
              step="0.1"
              class="w-20"
              :aria-label="`Q, band ${index + 1}`"
              @update:model-value="onInput(band, 'q', String($event))"
              @change="commit(band, 'q')"
              @blur="commit(band, 'q')"
              @keydown.enter.prevent="commit(band, 'q')"
            />
          </td>
          <td class="px-3 py-1 text-center">
            <UCheckbox
              :model-value="band.enabled"
              :aria-label="`Enable band ${index + 1}`"
              @update:model-value="onEnabled(band, $event === true)"
            />
          </td>
          <td class="px-3 py-1 text-right">
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-tabler-trash"
              :aria-label="`Remove band ${index + 1}`"
              @click="remove(band)"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
