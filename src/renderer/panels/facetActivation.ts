import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { FACET_ACTIVATION_KEY, type FacetActivation } from '@shared/settings'
import type { SettingsReader } from '../settings/reader'
import { activationChoice } from './activationFallback'

/**
 * What double-clicking an artist or an album does.
 *
 * `trackActivation.ts` one level up. The song list's gesture had a verb behind
 * a setting and the sidebar's had nothing at all, which is a strange place for
 * the app to be: right-clicking an artist has meant "queue all of this" since
 * the facet menus landed, and the fastest gesture on the same row meant less
 * than the slowest one.
 *
 * ## Why the target is two closures and not a facet id
 *
 * `FacetList` is generic and knows nothing about what an artist is; the same is
 * true here, deliberately. A row is "something that can be played" and
 * "something that can be widened into track ids", and both of those are the
 * sidebar's to supply — it is the only place that knows an artist row narrows
 * by `artistIds` under the root and the search, while an album row narrows by
 * `albumIds` under the artists as well. Passing a dimension in would put that
 * rule in two files.
 *
 * ## Why playing is a closure rather than a track id list
 *
 * Because it must not be a list. Playing an artist means adopting *the library
 * order narrowed to them* — paged, indexed, resolved one position at a time
 * exactly like clicking a row in the song list — not materializing eight
 * hundred track ids into a fixed order the traversal then walks. The other
 * three verbs genuinely are lists, because a queue is one.
 */

export interface FacetActivationTarget {
  /** Adopt everything under this row as the play order and start it. */
  readonly play: () => void
  /** The tracks the row stands for, resolved only when a verb needs them. */
  readonly trackIds: () => Promise<readonly number[]>
}

export interface FacetActivationDeps {
  settings: SettingsReader
  /** Insert at the head of the queue. */
  playNext: (trackIds: readonly number[]) => Promise<number>
  /** Append to the queue. */
  addToQueue: (trackIds: readonly number[]) => Promise<number>
  /** The playlist Curate is showing, or null when none is open. */
  viewedPlaylistId: MaybeRefOrGetter<number | null>
  /** Reports its own outcome, so there is nothing here for a caller to act on. */
  addToViewedPlaylist: (playlistId: number, trackIds: readonly number[]) => Promise<void>
}

export function createFacetActivation(deps: FacetActivationDeps) {
  const { settings } = deps

  const viewedPlaylistId = computed(() => toValue(deps.viewedPlaylistId))

  const { action, effective, hint } = activationChoice<FacetActivation>(
    computed(() => settings.get<FacetActivation>(FACET_ACTIVATION_KEY)),
    viewedPlaylistId,
    'play'
  )

  async function activate(target: FacetActivationTarget): Promise<void> {
    switch (effective.value) {
      case 'none':
        return
      case 'play':
        target.play()
        return
      case 'playNext':
        await deps.playNext(await target.trackIds())
        return
      case 'queue':
        await deps.addToQueue(await target.trackIds())
        return
      case 'addToViewedPlaylist': {
        const playlistId = viewedPlaylistId.value
        // `effective` already ruled this out, but through a computed the
        // compiler cannot follow — and re-checking rather than asserting is
        // also what keeps this honest the day an `await` lands above the line.
        if (playlistId === null) {
          target.play()
          return
        }
        await deps.addToViewedPlaylist(playlistId, await target.trackIds())
      }
    }
  }

  return { action, effective, hint, activate }
}

export type FacetActivationCommands = ReturnType<typeof createFacetActivation>
