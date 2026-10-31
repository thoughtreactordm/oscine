/**
 * When the stage visualizer shows, and when its loop runs — **W23-4, D35.5, D35.7**.
 *
 * Two questions, kept apart because different code answers them:
 *
 * - **Is it wanted?** ({@link visualizerWanted}) — the stage toggle, overridden by
 *   Zen. `StageView` asks this to decide whether to mount the host at all and
 *   whether to reshape the stage around it.
 * - **Does the loop run?** ({@link visualizerLoopRuns}) — D35.7's conjunction.
 *   The host asks this every time one of its inputs changes; when it is false no
 *   `requestAnimationFrame` is pending.
 *
 * **Zen is an override, not a write.** With `interface.visualizerInZen` on, Zen
 * shows the visualizer regardless of `interface.nowPlayingVisualizer`, and a
 * toggle made while Zen is active only sets a session override that ends with
 * Zen ({@link visualizerToggle}). Zen never writes the stage toggle — the same
 * way it overrides the title bar and tab row without touching their settings.
 *
 * Pure, `@renderer`-free and DOM-free, so Vitest covers it as a truth table.
 */

export interface VisualizerWantInputs {
  /** `interface.nowPlayingVisualizer`. */
  readonly stageSetting: boolean
  /** `interface.visualizerInZen`. */
  readonly inZenSetting: boolean
  /** `zen.active`. */
  readonly zenActive: boolean
  /** A toggle made inside Zen; null when there has been none this Zen session. */
  readonly zenOverride: boolean | null
}

/** Whether the operator has the visualizer on, after Zen's override. */
export function visualizerWanted(inputs: VisualizerWantInputs): boolean {
  if (!inputs.zenActive) return inputs.stageSetting
  if (inputs.zenOverride !== null) return inputs.zenOverride
  return inputs.inZenSetting || inputs.stageSetting
}

/** What the stage toggle does: write the durable setting, or set Zen's session override. */
export type VisualizerToggle =
  | { readonly kind: 'setting'; readonly value: boolean }
  | { readonly kind: 'session'; readonly value: boolean }

/** The effect of pressing the stage toggle now. Inside Zen it never writes the setting. */
export function visualizerToggle(inputs: VisualizerWantInputs): VisualizerToggle {
  const value = !visualizerWanted(inputs)
  return inputs.zenActive ? { kind: 'session', value } : { kind: 'setting', value }
}

export interface VisualizerLoopInputs {
  /** {@link visualizerWanted}, and the stage has room and a track for it. */
  readonly enabled: boolean
  /** The host is mounted (the Now Playing tab is showing). */
  readonly mounted: boolean
  /** `document.hidden`. */
  readonly hidden: boolean
  /** `prefers-reduced-motion: reduce`. */
  readonly reducedMotion: boolean
  /** Playback is playing. */
  readonly playing: boolean
  /** The analysis is still decaying or the emergence has not settled to the wash. */
  readonly decaying: boolean
}

/** D35.7: the loop costs nothing when nobody is watching. */
export function visualizerLoopRuns(inputs: VisualizerLoopInputs): boolean {
  return (
    inputs.enabled &&
    inputs.mounted &&
    !inputs.hidden &&
    !inputs.reducedMotion &&
    (inputs.playing || inputs.decaying)
  )
}

/**
 * The effect to show for a stored id (D35.5): the registry entry with that id
 * when it is available, otherwise the first available effect. The stored value
 * is never rewritten by this — that is the caller's rule to keep. Null only when
 * nothing is available at all.
 */
export function resolveEffect<Effect extends { readonly id: string }>(
  available: readonly Effect[],
  storedId: string
): Effect | null {
  for (const effect of available) if (effect.id === storedId) return effect
  return available[0] ?? null
}
