// Reached relatively, and through the engine interface rather than the barrel,
// exactly as `playback/` reaches it: this module is unit-tested, the tests
// compile under `tsconfig.node.json`, and that project has no `@renderer` alias
// and no DOM lib for what the barrel re-exports.
import type { PlaybackStatus } from '../audio/AudioEngine'

/**
 * The playing mark a song row carries, or `null` for the rows that carry none.
 *
 * The rail already says which playlist is playing (§5 rule 3); this is the same
 * sentence one level down — which *song* is playing — and it has to read the
 * same wherever the song turns up, because the library list, the playlist
 * contents pane and any future pane are all views onto one library, not
 * separate lists that each happen to contain it.
 *
 * Two values rather than one because a paused track is still the loaded one and
 * a row that goes blank on pause loses the operator's place. The rail can get
 * away with a single glyph — a playlist is either the playing scope or it is
 * not — but a song row is the thing the transport is pointed at, so it says
 * what the transport is doing.
 */
export type NowPlayingMark = 'playing' | 'paused'

/**
 * Whether a row is the playing song.
 *
 * **Identity is the track id, deliberately.** A song that appears twice in a
 * playlist, or in the library list and in three playlists at once, gets the mark
 * in every one of those places — that is what "no matter where it is showing"
 * means, and it is the same identity the queue uses (§5 rule 4: the queue holds
 * track ids so that deleting a playlist cannot reach a queued row).
 *
 * The alternative — marking the exact slot in the play order — is only
 * expressible in the one pane that is showing the playing scope, in its stored
 * order, unshuffled and ungrouped. Everywhere else it degrades to this anyway,
 * and the conditions under which it does not are exactly the conditions under
 * which getting it wrong marks the wrong row. Marking both copies of a
 * duplicate is a true statement; marking the wrong copy is not.
 */
export function nowPlayingMark(params: {
  /** The row's track, or `undefined` where the page has not arrived yet. */
  readonly trackId: number | undefined
  /** What the transport has loaded, or `null` for nothing. */
  readonly playingTrackId: number | null
  readonly status: PlaybackStatus
}): NowPlayingMark | null {
  const { trackId, playingTrackId, status } = params
  if (trackId === undefined || playingTrackId === null || trackId !== playingTrackId) return null
  // `idle` and `ended` mean the transport is pointed at nothing that a row could
  // usefully claim; `loading` and `ready` are a track that is loaded and not yet
  // audible, which is what the paused glyph already says.
  if (status === 'idle' || status === 'ended') return null
  return status === 'playing' ? 'playing' : 'paused'
}

/**
 * The glyph for a mark. Filled, like the rail's, so it reads at 12px.
 *
 * Total rather than partial — `null` gives the empty string — because callers
 * are templates, where the `v-if` that proves the mark is non-null is a
 * different expression from the one that asks for the glyph and narrows nothing.
 */
export function nowPlayingIcon(mark: NowPlayingMark | null): string {
  if (mark === null) return ''
  return mark === 'playing' ? 'i-tabler-player-play-filled' : 'i-tabler-player-pause-filled'
}

/**
 * What a screen reader hears in place of the glyph.
 *
 * Parenthesised to match the rail, where "(playing)" already trails the name
 * it qualifies.
 */
export function nowPlayingLabel(mark: NowPlayingMark | null): string {
  if (mark === null) return ''
  return mark === 'playing' ? '(playing)' : '(paused)'
}
