<script setup lang="ts">
import { computed } from 'vue'
import type { SettingsRow } from '@renderer/panels/settings/catalog'
import SettingField from '@renderer/panels/settings/SettingField.vue'
import { useSettings } from '@renderer/settings'
import { AUDIO_REPLAY_GAIN_MODE } from '@shared/settings'
import { replayGainIsOn, replayGainModeFromEnabled, replayGainToggleDescriptor } from './replayGain'

/**
 * The wizard's ReplayGain row: the settings view's label and help, a switch
 * instead of the three-way select, writing only `audio.replayGainMode`.
 *
 * Binding is here rather than in `SettingRow` because a toggle emits a boolean
 * and that key's validator only accepts `off` / `track` / `album`. Mapping at
 * the edge keeps the widget the ordinary `SettingField` switch.
 */
const props = defineProps<{
  row: SettingsRow
}>()

const settings = useSettings()

const fieldRow = computed<SettingsRow>(() => ({
  ...props.row,
  descriptor: replayGainToggleDescriptor(props.row.descriptor)
}))

const model = computed<boolean>({
  get: () => replayGainIsOn(settings.get(AUDIO_REPLAY_GAIN_MODE.key)),
  set: (enabled) => {
    void settings.set(AUDIO_REPLAY_GAIN_MODE.key, replayGainModeFromEnabled(enabled))
  }
})
</script>

<template>
  <SettingField v-model="model" :row="fieldRow" compact />
</template>
