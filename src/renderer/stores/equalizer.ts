import { defineStore } from 'pinia'
import { useSettings } from '@renderer/settings'
import { createEqualizerState } from './equalizerState'

export {
  createEqualizerState,
  type EqualizerSettings,
  type EqualizerState,
  type EqualizerStateOptions
} from './equalizerState'

/**
 * The app's equalizer pane store, built over the shared settings surface.
 *
 * All the substance lives in `createEqualizerState` (`equalizerState.ts`), which
 * imports nothing from `@renderer` so it can be unit-tested without Pinia. This
 * wrapper is the one line that binds it to the real settings store.
 */
export const useEqualizerStore = defineStore('equalizer', () => createEqualizerState(useSettings()))
