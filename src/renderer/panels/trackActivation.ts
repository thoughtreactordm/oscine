import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { TRACK_ACTIVATION_KEY, type TrackActivation } from '@shared/settings'
import type { Track } from '@shared/library'
import type { SettingsReader } from '../settings/reader'

/**
 * What double-clicking a song does.
 *
 * The gesture is the list's; the verb is not. `TrackList` emits `activate` and
 * has always left the meaning to whoever mounted it — the library view plays
 * from the browse query, the playlist pane plays from the playlist — and that
 * separation is what keeps the panel an island. This module sits on the other
 * side of that emit: one place that reads the preference and picks a verb, so
 * the two surfaces cannot disagree about what "Play next" means.
 *
 * `playNow` stays a dependency for exactly that reason. It is the one verb whose
 * meaning belongs to the surface, because starting a track *in its list* is what
 * makes the rest of that list the play order.
 *
 * ## When there is nowhere to add to
 *
 * `addToViewedPlaylist` needs a playlist open in Curate, and the operator can
 * double-click a song while there is not one. Doing nothing would read as a
 * broken list — the gesture is the most-used one in the app and silence is
 * indistinguishable from a hang — so it falls back to playing, which is the verb
 * the row would have had if the setting had never been touched. `hint` says so
 * where a surface has room to.
 */

export interface TrackActivationDeps {
  settings: SettingsReader
  /** Start the track where it sits, making its list the play order. */
  playNow: (track: Track, index: number) => void
  /** Insert at the head of the queue. */
  playNext: (tracks: readonly Track[]) => Promise<number>
  /** Append to the queue. */
  addToQueue: (tracks: readonly Track[]) => Promise<number>
  /** The playlist Curate is showing, or null when none is open. */
  viewedPlaylistId: MaybeRefOrGetter<number | null>
  /** Reports its own outcome, so there is nothing here for a caller to act on. */
  addToViewedPlaylist: (playlistId: number, trackIds: readonly number[]) => Promise<void>
}

export function createTrackActivation(deps: TrackActivationDeps) {
  const { settings } = deps

  const action = computed(() => settings.get<TrackActivation>(TRACK_ACTIVATION_KEY))
  const viewedPlaylistId = computed(() => toValue(deps.viewedPlaylistId))

  /** The verb that will actually run, after the fallback above. */
  const effective = computed<TrackActivation>(() =>
    action.value === 'addToViewedPlaylist' && viewedPlaylistId.value === null
      ? 'play'
      : action.value
  )

  const hint = computed<string | null>(() =>
    action.value === 'addToViewedPlaylist' && viewedPlaylistId.value === null
      ? 'Open a playlist in Curate to add to it. Until then, double-clicking plays.'
      : null
  )

  async function activate(track: Track, index: number): Promise<void> {
    switch (effective.value) {
      case 'play':
        deps.playNow(track, index)
        return
      case 'playNext':
        await deps.playNext([track])
        return
      case 'queue':
        await deps.addToQueue([track])
        return
      case 'addToViewedPlaylist': {
        const playlistId = viewedPlaylistId.value
        // `effective` already ruled this out, but it did so through a computed
        // the compiler cannot follow. Re-checked rather than asserted with a
        // `!`, because an assertion here would also be the thing that broke
        // silently the day an `await` lands above this line.
        if (playlistId === null) {
          deps.playNow(track, index)
          return
        }
        await deps.addToViewedPlaylist(playlistId, [track.id])
      }
    }
  }

  return { action, effective, hint, activate }
}

export type TrackActivationCommands = ReturnType<typeof createTrackActivation>
