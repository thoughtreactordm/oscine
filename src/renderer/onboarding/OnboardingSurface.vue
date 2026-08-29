<script setup lang="ts">
import { computed } from 'vue'
import SettingRow from '@renderer/panels/settings/SettingRow.vue'
import { AUDIO_REPLAY_GAIN_MODE } from '@shared/settings'
import OnboardingReplayGainRow from './OnboardingReplayGainRow.vue'
import { buildOnboardingSurface, type OnboardingStep } from './steps'

/**
 * One wizard step declared as `{ title, blurb, keys }`, drawn through the same
 * `SettingRow` / `SettingField` stack the settings view and W8-8's popovers
 * use. No hand-written controls; a key the registry cannot surface is named
 * rather than dropped.
 *
 * Compact, like the popovers: a modal is a column, not a virtualized row.
 * Writes go straight to `settings.set` via `SettingRow`, so navigating past an
 * untouched step writes nothing. ReplayGain is the one binding adapter
 * (D-ONB-5): same field, switch instead of select, off ↔ `track`.
 */
const props = defineProps<{
  step: OnboardingStep
}>()

const surface = computed(() => buildOnboardingSurface(props.step))
</script>

<template>
  <div class="flex flex-col">
    <div class="divide-y divide-default/60">
      <template v-for="row in surface.rows" :key="row.key">
        <OnboardingReplayGainRow v-if="row.key === AUDIO_REPLAY_GAIN_MODE.key" :row="row" />
        <SettingRow v-else :row="row" compact />
      </template>
    </div>
    <p
      v-if="surface.unknown.length > 0"
      class="border-t border-default px-3 py-2 text-xs text-warning"
    >
      {{ surface.unknown.join(', ') }}
      could not be drawn here.
    </p>
  </div>
</template>
