import type { TrackTagView } from '@shared/tags'

/**
 * What the Tags group's shut header says — **W15-3**.
 *
 * A module beside `favoriteSongs.ts` and for its reason: the branch is the part
 * worth a test, and a `.vue` file cannot be imported under a Vitest with no Vue
 * plugin. The pane is the editing; this is the one decision its badge renders.
 */

/**
 * The badge on the shut group: how many tags of the operator's own sit on the
 * playing track, or `null` for none.
 *
 * User tags only. The file's genres are the file's record and not the operator's,
 * and a shut group whose whole question is "what have I said about this" must not
 * answer it with what someone else's tagger wrote — a track carrying three ID3
 * genres and no user tag has nothing of the operator's in here, and the badge
 * says so by not appearing. `null` rather than `'0'`, exactly as every other deck
 * badge returns it: the number exists to answer "is it worth opening", and a bare
 * heading answers that in the negative at least as well as a zero does.
 */
export function countUserTags(view: TrackTagView | undefined): string | null {
  if (!view) return null
  const total = view.user.length
  return total === 0 ? null : String(total)
}
