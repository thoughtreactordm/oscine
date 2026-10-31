import { hasArtwork } from '@shared/ipc'
import {
  SWATCH_COUNT,
  SYNTHETIC_COVER_EDGE,
  computeSwatchesInto,
  createCoverCrossfade,
  fillSyntheticCover,
  type CoverInput,
  type CoverSlot
} from './cover'
import type { Palette } from './palette'

/**
 * The host's cover bookkeeping — **W23-3, D35.11**.
 *
 * Turns "the now-playing artwork URL is this" into a {@link CoverInput} on every
 * frame: one decode per track, the stale-decode race, the fallback to the
 * synthetic stand-in, and regenerating that stand-in as the palette moves. The
 * actual fetch and bitmap work is injected (`coverDecode.ts` supplies the
 * real one), so this stays DOM-free and the race is testable.
 *
 * The URL is `playback.nowPlaying.artwork.large` — the one the stage already
 * shows, so W16-9 artwork overrides arrive with no logic here.
 */

/** While the palette moves, the stand-in is repainted at most this often. */
export const STAND_IN_REFRESH_SEC = 0.1

export interface CoverSourceDeps<Slot extends CoverSlot> {
  /**
   * Fetch and decode one cover into a slot. Rejecting is the only failure
   * signal; every failure is answered the same way, with the stand-in.
   */
  decode(url: string, signal: AbortSignal): Promise<Slot>
  /** Wrap freshly painted stand-in pixels (RGBA, `edge²`) and their swatches in a slot. */
  standIn(pixels: Uint8ClampedArray, edge: number, swatches: Float32Array): Slot
  /** Let go of a slot. Defaults to closing its bitmap. */
  release?(slot: Slot): void
}

export interface CoverSource<Slot extends CoverSlot> {
  /** The now-playing large artwork URL, or null with nothing playing. */
  setArtwork(url: string | null): void
  /** Advance one rendered frame and return what cover effects read. */
  frame(palette: Palette, dtSec: number): CoverInput<Slot>
  /** Abort any decode and release every slot. */
  dispose(): void
}

export function createCoverSource<Slot extends CoverSlot>(
  deps: CoverSourceDeps<Slot>
): CoverSource<Slot> {
  const release = deps.release ?? ((slot: Slot) => slot.bitmap.close())
  const crossfade = createCoverCrossfade<Slot>(release)
  const pixels = new Uint8ClampedArray(SYNTHETIC_COVER_EDGE * SYNTHETIC_COVER_EDGE * 4)

  let url: string | null | undefined
  let controller: AbortController | null = null
  /** Bumped per request, so a decode that resolves after the next track is recognisably stale. */
  let generation = 0
  let wantStandIn = false
  let standInVersion = -1
  let sinceStandIn = 0
  let disposed = false

  function paintStandIn(palette: Palette): Slot {
    fillSyntheticCover(palette.oklab, pixels, SYNTHETIC_COVER_EDGE)
    const swatches = computeSwatchesInto(
      pixels,
      SYNTHETIC_COVER_EDGE,
      SYNTHETIC_COVER_EDGE,
      new Float32Array(SWATCH_COUNT * 3)
    )
    standInVersion = palette.version
    sinceStandIn = 0
    return deps.standIn(pixels, SYNTHETIC_COVER_EDGE, swatches)
  }

  return {
    setArtwork(next) {
      if (disposed || next === url) return
      url = next
      controller?.abort()
      controller = null
      const request = ++generation

      if (!next || !hasArtwork(next)) {
        wantStandIn = true
        return
      }
      wantStandIn = false
      const abort = new AbortController()
      controller = abort
      deps.decode(next, abort.signal).then(
        (slot) => {
          if (disposed || request !== generation) {
            // Lost the race to the next track: never shown, so released here.
            release(slot)
            return
          }
          controller = null
          crossfade.present(slot)
        },
        () => {
          if (disposed || request !== generation) return
          controller = null
          wantStandIn = true
        }
      )
    },

    frame(palette, dtSec) {
      if (dtSec > 0) sinceStandIn += dtSec
      const showing = crossfade.input

      if (!showing) {
        // Nothing decoded yet (the stage just opened, or the first decode is in
        // flight): the stand-in holds the slot, and the cover fades in over it.
        crossfade.present(paintStandIn(palette))
        wantStandIn = false
      } else if (wantStandIn) {
        wantStandIn = false
        if (!showing.current.synthetic) crossfade.present(paintStandIn(palette))
      } else if (
        showing.current.synthetic &&
        palette.version !== standInVersion &&
        sinceStandIn >= STAND_IN_REFRESH_SEC
      ) {
        crossfade.replaceCurrent(paintStandIn(palette))
      }

      crossfade.update(dtSec)
      // Non-null: every branch above leaves a slot showing.
      return crossfade.input as CoverInput<Slot>
    },

    dispose() {
      if (disposed) return
      disposed = true
      controller?.abort()
      controller = null
      crossfade.clear()
    }
  }
}
