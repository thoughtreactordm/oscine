import { shallowRef, type ShallowRef } from 'vue'
import type { LyricsDocument } from '@shared/lyrics'

/**
 * The reactive face of one track's lyrics, refreshed as the transport's track
 * changes.
 *
 * Split from the store (`lyrics.ts`) so it imports neither `@renderer/ipc` nor
 * the DOM: the store wires it to the IPC bridge, but the guard against a slow
 * fetch losing to a fresh one is pure enough to unit-test under plain Node,
 * which is the shape this repo asks a testable renderer module to take.
 */
export interface LyricsLoader {
  /** The resolved document, or `null` for a track with no lyrics on disk. */
  readonly document: ShallowRef<LyricsDocument | null>
  /** Which track `document` describes — the guard the pane keys its reset on. */
  readonly trackId: ShallowRef<number | null>
  readonly loading: ShallowRef<boolean>
  /** The query rejected. Distinct from "answered with nothing" — see the pane. */
  readonly failed: ShallowRef<boolean>
  load(trackId: number | null): Promise<void>
  refresh(): Promise<void>
}

export function createLyricsLoader(
  fetch: (trackId: number) => Promise<LyricsDocument | null>
): LyricsLoader {
  const document = shallowRef<LyricsDocument | null>(null)
  const trackId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  const failed = shallowRef(false)

  /**
   * Monotonic, and the only thing standing between the pane and a stale answer
   * overwriting a fresh one. Skipping through four tracks fires four loads and
   * nothing guarantees they resolve in order; comparing against the counter
   * rather than against `trackId` also covers skipping away and back, where the
   * ids match but the older response is still the wrong one. Follows the
   * related store's `issued` guard exactly.
   */
  let issued = 0

  async function load(next: number | null): Promise<void> {
    const request = ++issued

    if (next === null) {
      document.value = null
      trackId.value = null
      loading.value = false
      failed.value = false
      return
    }

    // Clear the old document up front: a lyrics pane that showed the previous
    // track's words for the width of a fetch would be worse than showing
    // nothing. The pane defers its *loading* affordance so a fast local read
    // does not flash a spinner on every skip.
    trackId.value = next
    document.value = null
    loading.value = true
    failed.value = false
    try {
      const doc = await fetch(next)
      if (request !== issued) return
      document.value = doc
    } catch {
      if (request !== issued) return
      // Swallowed and surfaced as a flag: a lyrics query that could throw into
      // a track change would be a cosmetic pane with the power to interrupt
      // playback — the same argument the related store makes.
      document.value = null
      failed.value = true
    } finally {
      if (request === issued) loading.value = false
    }
  }

  /** Re-asks for the current track. For a rescan, or a manual retry after a failure. */
  async function refresh(): Promise<void> {
    await load(trackId.value)
  }

  return { document, trackId, loading, failed, load, refresh }
}
