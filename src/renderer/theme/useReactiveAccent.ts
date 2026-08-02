/**
 * The standing link between what is playing and what colour the app is.
 *
 * A composable rather than a store because it owns no state — the seed lives on
 * `ThemeInputs` and the toggle lives in settings, and there is nothing here for
 * a second caller to read. What it needs is an owner that outlives every route,
 * which is why `App.vue` calls it beside `useThemeStore()`.
 *
 * Deliberately *not* folded into the theme store. That store is already the seam
 * between three things that each think they own light and dark; making it also
 * reach into playback would give it a fourth job and would make the theme layer
 * depend on the audio layer existing, which it does not.
 */

import { watch } from 'vue'
import { THEME_REACTIVE_KEY } from '@shared/settings'
import { useSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import { createAccentFader, readAccentSeed } from './artworkAccent'
import { updateTheme } from './index'

export function useReactiveAccent(): void {
  const settings = useSettings()
  const playback = usePlaybackStore()
  const fader = createAccentFader((seed) => updateTheme({ reactiveSeed: seed }))

  /*
   * One in flight at a time. Skipping through five tracks starts five reads, and
   * without this the one that happens to finish last wins rather than the one
   * that is playing — the accent would settle on an album that is no longer on
   * screen. Aborting is also what stops a slow decode from repainting after the
   * operator has switched the toggle off.
   */
  let pending: AbortController | null = null

  watch(
    () =>
      [
        settings.get<boolean>(THEME_REACTIVE_KEY),
        playback.nowPlaying?.artwork.large ?? null
      ] as const,
    async ([enabled, url]) => {
      pending?.abort()
      pending = null

      if (!enabled || url === null) {
        fader.to(null)
        return
      }

      const request = new AbortController()
      pending = request
      const seed = await readAccentSeed(url, request.signal)
      if (request.signal.aborted) return
      fader.to(seed)
    },
    { immediate: true }
  )
}
