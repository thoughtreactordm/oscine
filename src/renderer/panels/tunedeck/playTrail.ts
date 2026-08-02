import type { PlayEntry } from '@shared/history'

/**
 * What the play-history pane draws, derived from the trail it is handed.
 *
 * Headless and pure, like `upNextRows` beside it and for the same reason: the
 * two claims this pane makes — that consecutive replays are one row, and that
 * the head row is the track you are listening to — are decidable without Vue, a
 * DOM or an `AudioEngine`, and a component that owned them would make them
 * testable only through one.
 */

export interface TrailRow {
  readonly key: string
  /** The most recent play of this run — the one jump-back replays. */
  readonly entry: PlayEntry
  /**
   * Consecutive plays of the same track collapsed into this row.
   *
   * Repeat-one is a play per pass (see `PlaybackSchedulerEventMap.playstart`),
   * so an hour of it is fifteen identical rows. They are all in the store,
   * because the trail is append-only and the store records what happened; the
   * pane is where "the same thing, again" becomes one line. 1 for an ordinary
   * row, which is why the count is only rendered above 1.
   */
  readonly plays: number
  /** How long ago, already formatted. See `trailWhen`. */
  readonly when: string
  /**
   * The trail's head *is* the audible track — a play is recorded when the
   * transport commits to it — so without this the top row invites a jump-back
   * to what is already playing.
   */
  readonly isPlaying: boolean
}

export interface TrailRowsInput {
  readonly entries: readonly PlayEntry[]
  /** The audible track's id, or `null` when nothing is playing. */
  readonly nowPlayingId: number | null
  /** Wall-clock milliseconds, for the relative labels. */
  readonly now: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago a play was, at the resolution a trail is read at.
 *
 * Coarse on purpose, and it gets coarser with age: "4 min" is the answer to
 * "what was that?", and by the time a row is three days old the useful answer
 * is "3 d". Clamps negatives to "now" — a clock correction can put a stored
 * `playedAt` in the future, and the trail's order comes from the row id rather
 * than from this, so a row saying "in 2 h" would be the only thing in the pane
 * disagreeing with the sequence it is drawn in.
 */
export function trailWhen(playedAt: number, now: number): string {
  const ago = now - playedAt
  if (ago < MINUTE) return 'now'
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min`
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h`
  return `${Math.floor(ago / DAY)} d`
}

/**
 * Collapses consecutive plays of one track and labels each row.
 *
 * *Consecutive* rather than deduplicated outright: a track played, then three
 * others, then played again is two separate listens and the trail says so.
 * Collapsing them would turn the trail into a play-count table, which is a
 * different thing that this card deliberately does not build.
 *
 * `entries` arrives most-recent-first, and the run keeps the *first* entry it
 * sees — the newest play — because that is the id the row is keyed by and the
 * time it is labelled with.
 */
export function buildTrailRows(input: TrailRowsInput): TrailRow[] {
  const rows: TrailRow[] = []

  for (const entry of input.entries) {
    const open = rows[rows.length - 1]
    if (open && open.entry.track.id === entry.track.id) {
      rows[rows.length - 1] = { ...open, plays: open.plays + 1 }
      continue
    }
    rows.push({
      key: `play-${entry.id}`,
      entry,
      plays: 1,
      when: trailWhen(entry.playedAt, input.now),
      // Only the head can be the audible track. A track played an hour ago and
      // playing again now has a newer row of its own at the top, and marking
      // the older one too would claim two rows are the same listen.
      isPlaying: rows.length === 0 && entry.track.id === input.nowPlayingId
    })
  }

  return rows
}
