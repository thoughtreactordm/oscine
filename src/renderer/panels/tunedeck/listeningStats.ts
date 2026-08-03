import type { StatsScopeBy, StatsSummary } from '@shared/stats'
import { formatListeningTime, formatPlays } from '../displayFormat'

/**
 * What the Listening groups draw, and the decisions behind each line.
 *
 * A module beside `favoriteSongs.ts` and for its reason: the branch order and
 * the wording are the part worth holding to a test, and a `.vue` file cannot be
 * imported under a Vitest with no Vue plugin. The pane is the rendering; this is
 * what it renders.
 *
 * The relative import is `tunedeckPanes.ts`'s rule rather than a slip: `tests/`
 * compiles under `tsconfig.node.json`, which maps `@shared` but not
 * `@renderer`, so a module meant to be tested reaches its neighbours by path.
 * The `@shared` import survives because it is types only and is erased.
 *
 * `formatListeningTime` lives in `displayFormat.ts` rather than here. There is
 * one place in this app that decides how a time is written and this is not it —
 * see the card's own instruction, and that function's note for why a total and
 * a length are two shapes rather than one.
 */

/** The four things the group can be, and which one it is. */
export type ListeningState = 'standby' | 'failed' | 'loading' | 'rows'

export interface ListeningView {
  /** The seed the deck is describing, or `null` when nothing is playing. */
  seedId: number | null
  loading: boolean
  failed: boolean
  /** `true` once an answer has arrived for the seed, whatever it contained. */
  answered: boolean
}

/**
 * The order the states are tested in, which is load-bearing at two points.
 *
 * `standby` outranks everything, because a deck with no track is not describing
 * anything and has no counts to be zero. `failed` outranks `loading` because the
 * retry re-enters `loading`, and a group that said "Reading…" during its own
 * retry would hide the button the operator just needed twice.
 *
 * There is no `empty`, and that absence is the card's instruction rather than an
 * omission: **a zero is a real answer**. A freshly scanned track answers `0
 * plays` in the same shape a well-worn one answers `1,204`, and no panel
 * disappears on the way.
 */
export function listeningState(view: ListeningView): ListeningState {
  if (view.seedId === null) return 'standby'
  if (view.failed) return 'failed'
  if (view.loading || !view.answered) return 'loading'
  return 'rows'
}

/** What each scope calls itself, in the deck's own voice. */
const LABELS: Readonly<Record<StatsScopeBy, string>> = {
  track: 'This track',
  album: 'This album',
  artist: 'This artist'
}

/**
 * The sentence for a scope with no group behind it.
 *
 * Not an error and not a zero — see `StatsSummary.resolved`. Most of what these
 * say is about tagging rather than about listening, which is why they read as
 * statements about the track instead of apologies about the query.
 */
const ABSENT: Readonly<Record<StatsScopeBy, string>> = {
  track: 'No longer in the library.',
  album: 'This track names no album.',
  artist: 'This track names no artist.'
}

/**
 * One line of the group: a subject, what it adds up to, and when.
 *
 * `total` and `span` are `null` together with `absent` set, which is the shape
 * that keeps the template from having to decide anything. `span` is also `null`
 * for a resolved scope nobody has played — there are no dates to report, and a
 * row reading "0 plays · 0m" under a blank date line is a row with a hole in it.
 */
export interface ListeningRow {
  scope: StatsScopeBy
  label: string
  /** `42 plays · 2h 18m`, or `null` when there is nothing to count. */
  total: string | null
  /** UTC ms of the first and last listen, or `null` when there are none. */
  span: { first: number; last: number } | null
  /** Why there is no total, or `null` when there is one. */
  absent: string | null
}

/**
 * The rows for one group, in the order given.
 *
 * Takes the scopes rather than assuming all three, because the two groups that
 * mount this component are asking different questions: the Track tab's subject
 * is the file and the record it came on, and the Artist tab's is the person. A
 * component that always drew three would have put the artist's total under a
 * heading naming the track.
 *
 * A missing summary yields no row at all rather than an empty one. That state
 * only exists between `listeningState` returning `rows` and a partial answer,
 * which is a combination the store does not produce — it fills all three or
 * none — and drawing a placeholder for it would be inventing a fourth state to
 * cover an impossible one.
 */
export function listeningRows(
  scopes: readonly StatsScopeBy[],
  summaries: Partial<Record<StatsScopeBy, StatsSummary | null>>
): ListeningRow[] {
  const rows: ListeningRow[] = []

  for (const scope of scopes) {
    const summary = summaries[scope]
    if (summary === undefined || summary === null) continue

    if (!summary.resolved) {
      rows.push({ scope, label: LABELS[scope], total: null, span: null, absent: ABSENT[scope] })
      continue
    }

    const { firstListenAt, lastListenAt } = summary
    rows.push({
      scope,
      label: LABELS[scope],
      total: `${formatPlays(summary.listens)} · ${formatListeningTime(summary.msListened)}`,
      span:
        firstListenAt === null || lastListenAt === null
          ? null
          : { first: firstListenAt, last: lastListenAt },
      absent: null
    })
  }

  return rows
}

/**
 * The badge on a shut group: the first scope's play count.
 *
 * The first rather than a sum, because the scopes overlap — a track's listens
 * are among its album's, which are among its artist's — and adding them would
 * put a number on the header that appears nowhere inside it. The first scope is
 * the one the tab is about, which is the number the header should have been
 * showing anyway.
 *
 * `null` before an answer arrives, following `countArtistFavorites`: a badge
 * exists to say whether the group is worth opening, and a `0` that turns into
 * `1,204` a moment later has answered that question wrong once already.
 */
export function countListening(
  scope: StatsScopeBy,
  summaries: Partial<Record<StatsScopeBy, StatsSummary | null>> | null
): string | null {
  const summary = summaries?.[scope]
  if (summary === undefined || summary === null || !summary.resolved) return null
  return summary.listens.toLocaleString()
}
