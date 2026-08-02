/**
 * Getting cover pixels, and crossfading the accent between tracks.
 *
 * The DOM half of reactive colour — `applyTheme.ts`'s counterpart for a
 * different concern, and kept just as thin. All the judgement is in
 * `reactiveColor.ts`, which is where the tests are; what is here is a fetch, a
 * canvas and a `requestAnimationFrame` loop, none of which say anything about
 * what colour comes out.
 */

import { currentInputs } from './index'
import { mixSeeds, pickAccentSeed } from './reactiveColor'
import { computeTheme } from './themeController'

/**
 * The edge the cover is downscaled to before a pixel is read.
 *
 * Small on purpose. A 3000px sleeve is 9 million pixels and the answer does not
 * improve past a few thousand — the result is bucketed into 10° of hue, and no
 * amount of extra resolution changes which bucket wins. It does change whether
 * this runs inside one frame.
 */
const SAMPLE_EDGE = 64

/** Long enough to read as a transition, short enough not to lag the track change. */
const FADE_MS = 320

/**
 * Read one artwork URL and pick its accent, or null if anything at all went
 * wrong.
 *
 * `fetch` on the `fermata://` scheme is already how `browserMediaSession.ts`
 * re-addresses artwork as a blob, so this needs no new IPC surface and no new
 * privilege — and because the bytes arrive as a blob rather than as an `<img>`
 * src, the canvas is never tainted and `getImageData` is allowed.
 *
 * Every failure is the same failure. A cover that will not decode, a route that
 * 404s, an aborted track change: none of them are worth distinguishing when the
 * response to all three is to leave the theme's own primary showing.
 */
export async function readAccentSeed(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, signal ? { signal } : undefined)
    if (!response.ok) return null

    const bitmap = await createImageBitmap(await response.blob(), {
      resizeWidth: SAMPLE_EDGE,
      resizeHeight: SAMPLE_EDGE,
      resizeQuality: 'low'
    })
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return null
      context.drawImage(bitmap, 0, 0)
      return pickAccentSeed(context.getImageData(0, 0, bitmap.width, bitmap.height).data)
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

/**
 * What the primary would be with no reactive seed at all.
 *
 * Recomputed rather than read off `currentTheme()`, because while a reactive
 * seed is applied the current primary *is* the reactive one — reading it would
 * make a fade-out start from where it was already ending. This asks the same
 * pure function the same question with the seed removed, which costs one theme
 * resolve and is exact.
 */
function themeOwnAccent(): string | null {
  const state = computeTheme({ ...currentInputs(), reactiveSeed: null })
  return state.resolved.tokens.get('color.primary-500') ?? null
}

export interface AccentFader {
  /** Fade to a seed, or back to the theme's own primary when null. */
  to(seed: string | null): void
  /** Stop mid-fade without applying anything further. */
  cancel(): void
}

/**
 * A fader over the seed rather than over the CSS.
 *
 * Interpolating in JS and re-resolving each frame, rather than putting a
 * `transition` on the custom properties, because unregistered custom properties
 * do not interpolate — animating them in CSS would mean an `@property` block per
 * ramp step with an `initial-value`, which is eleven declarations fighting the
 * inline styles `applyTheme` deliberately uses to win the cascade. Tweening the
 * one seed the eleven steps derive from is both less machinery and perceptually
 * better: the intermediate ramps are real ramps, gamut-clamped like any other.
 *
 * `resolveTheme` is already called on every keystroke in the token editor, so a
 * few frames of it per track change is well inside what the layer is built for.
 */
export function createAccentFader(apply: (seed: string | null) => void): AccentFader {
  let frame: number | null = null
  let applied: string | null = null

  const cancel = (): void => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }

  const settle = (seed: string | null): void => {
    applied = seed
    apply(seed)
  }

  return {
    cancel,
    to(seed) {
      cancel()

      const origin = themeOwnAccent()
      const from = applied ?? origin
      const target = seed ?? origin

      // T12 again: an accessibility preference the OS states does not get a vote
      // from this module either. Nothing to fade between is the other cut case.
      if (currentInputs().systemReducedMotion || from === null || target === null) {
        settle(seed)
        return
      }

      const start = performance.now()
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / FADE_MS)
        if (t >= 1) {
          frame = null
          // The real value, not the tween's last frame — clearing has to leave
          // no override behind, or `reactiveSeed: null` would still be painting.
          settle(seed)
          return
        }
        // Smoothstep. A linear ramp between two colours reads as a wipe; the
        // eased one reads as the art arriving. Recorded as it goes so a track
        // change mid-fade departs from the colour on screen rather than from
        // wherever the last fade started.
        applied = mixSeeds(from, target, t * t * (3 - 2 * t))
        apply(applied)
        frame = requestAnimationFrame(step)
      }
      frame = requestAnimationFrame(step)
    }
  }
}
