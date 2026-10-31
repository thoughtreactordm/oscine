import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { useSettings } from '@renderer/settings'
import { useZenStore } from '@renderer/stores/zen'
import { visualizerToggle, visualizerWanted } from '@renderer/visualizer/gate'
import { availableEffects } from '@renderer/visualizer/registry'
import { cycleEffect, stepEffect } from '@renderer/visualizer/selection'
import {
  NOW_PLAYING_VISUALIZER_KEY,
  VISUALIZER_CYCLE_KEY,
  VISUALIZER_EFFECT_KEY,
  VISUALIZER_IN_ZEN_KEY,
  type VisualizerCycle
} from '@shared/settings'

/**
 * What the stage reports about its visualizer while it is mounted. The
 * shortcuts read it so they act only on the stage (D35.5): with no stage
 * mounted, or with the control unavailable there, the key is left alone.
 */
export interface VisualizerStagePresence {
  /** The stage toggle is offered and enabled (a track, room, no reduced motion). */
  readonly canToggle: boolean
  /** The visualizer is on the stage, so stepping it is visible. */
  readonly showing: boolean
}

/**
 * The visualizer's controls — W23-6, D35.5. One set of verbs the stage button,
 * the global shortcuts and the Command Palette all call, so the three cannot
 * disagree about what "toggle" means inside Zen or which effect is next.
 *
 * Holds no state of its own beyond the stage's presence: the toggle goes through
 * `gate.ts` (a durable write, or Zen's session override on the Zen store), and
 * the effect verbs write `interface.visualizerEffect`, which the host is already
 * watching — so every switch takes the host's switch path, through the wash.
 */
export const useVisualizerStore = defineStore('visualizer', () => {
  const settings = useSettings()
  const zen = useZenStore()

  const stage = shallowRef<VisualizerStagePresence | null>(null)

  const wantInputs = computed(() => ({
    stageSetting: settings.get<boolean>(NOW_PLAYING_VISUALIZER_KEY),
    inZenSetting: settings.get<boolean>(VISUALIZER_IN_ZEN_KEY),
    zenActive: zen.active,
    zenOverride: zen.visualizerOverride
  }))
  /** Wanted after Zen's override — not yet gated on the stage's room or motion. */
  const wanted = computed(() => visualizerWanted(wantInputs.value))

  function toggle(): void {
    const action = visualizerToggle(wantInputs.value)
    if (action.kind === 'session') zen.visualizerOverride = action.value
    else void settings.set<boolean>(NOW_PLAYING_VISUALIZER_KEY, action.value)
  }

  function storedId(): string {
    return settings.get<string>(VISUALIZER_EFFECT_KEY)
  }

  function write(id: string | undefined): void {
    if (id !== undefined) void settings.set<string>(VISUALIZER_EFFECT_KEY, id)
  }

  function step(direction: 1 | -1): void {
    write(stepEffect(availableEffects(), storedId(), direction)?.id)
  }

  /** Show this effect, if it can run here. */
  function select(id: string): void {
    if (id === storedId()) return
    if (availableEffects().some((effect) => effect.id === id)) write(id)
  }

  /** A track changed under a showing visualizer: advance per `interface.visualizerCycle`. */
  function cycle(): void {
    const mode = settings.get<VisualizerCycle>(VISUALIZER_CYCLE_KEY)
    write(cycleEffect(availableEffects(), storedId(), mode)?.id)
  }

  return {
    stage,
    wanted,
    toggle,
    next: () => step(1),
    previous: () => step(-1),
    select,
    cycle
  }
})
