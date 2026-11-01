import type { PlaylistInsertion } from '@shared/playlists'
import { ToolInputError } from '../tools/common'
import type { OrganizeEntry } from './reads'

/**
 * Pure planning for the Organize tools — **W24-7**, `oscine-mcp` → D36.7.
 *
 * Each function takes a playlist's entries as they are and an edit, refuses an
 * edit the store would quietly half-apply (an anchor that is not there, an
 * entry from another playlist), and says what the edit does. The same plan is
 * the `dryRun` answer and the check a real call runs before it writes, so the
 * two cannot disagree. Nothing here writes; the store's own semantics are
 * mirrored, not replaced — `PlaylistStore` still does the work.
 */

/** At most this many tracks or entries per Organize call (D36.7). */
export const MAX_ORGANIZE_BATCH = 500

/** Refuses a batch over the cap with an error that says how to split it. */
export function assertWithinCap(count: number, noun: string): void {
  if (count <= MAX_ORGANIZE_BATCH) return
  const calls = Math.ceil(count / MAX_ORGANIZE_BATCH)
  throw new ToolInputError(
    `${count} ${noun} is over the limit of ${MAX_ORGANIZE_BATCH} per call. Split them into ` +
      `${calls} calls of at most ${MAX_ORGANIZE_BATCH} each; call begin_changeset first so the ` +
      'operator can revert the whole task in one step.'
  )
}

/** Up to ten ids for an error message, then a count of the rest. */
export function listIds(ids: readonly number[]): string {
  const shown = ids.slice(0, 10).join(', ')
  return ids.length > 10 ? `${shown} and ${ids.length - 10} more` : shown
}

/** Refuses entry ids that are not in this playlist, or named twice. */
export function assertEntriesInPlaylist(
  entries: readonly OrganizeEntry[],
  entryIds: readonly number[]
): void {
  const present = new Set(entries.map((entry) => entry.entryId))
  const missing = entryIds.filter((id) => !present.has(id))
  if (missing.length > 0) {
    throw new ToolInputError(
      `Entries ${listIds(missing)} are not in this playlist. Entry ids come from get_playlist ` +
        '(`entryId`), not track ids.'
    )
  }
  if (new Set(entryIds).size !== entryIds.length) {
    throw new ToolInputError('An entry id is listed twice.')
  }
}

/**
 * The index an insertion lands at, in the order that remains once `excluded`
 * (the entries being moved) are lifted out — the store resolves its gap the
 * same way.
 */
export function insertionIndex(
  order: readonly number[],
  insertion: PlaylistInsertion,
  excluded: ReadonlySet<number> = new Set()
): number {
  const rest = order.filter((id) => !excluded.has(id))
  if (insertion.at === 'start') return 0
  if (insertion.at === 'end') return rest.length
  const anchor = rest.indexOf(insertion.entryId)
  if (anchor === -1) {
    throw new ToolInputError(
      `Entry ${insertion.entryId} (the insertion anchor) is not in this playlist; see get_playlist.`
    )
  }
  return insertion.at === 'before' ? anchor : anchor + 1
}

export interface MovePlan {
  /** Entry ids in playing order after the move. */
  order: number[]
  /** Where the moved block starts, or `null` when the move is a no-op. */
  at: number | null
}

/**
 * A move as the store makes it: the moved entries keep their playlist order
 * (not the order they were listed in) and land as one block. An anchor inside
 * the moved set is the store's no-op.
 */
export function planMove(
  entries: readonly OrganizeEntry[],
  entryIds: readonly number[],
  insertion: PlaylistInsertion
): MovePlan {
  assertEntriesInPlaylist(entries, entryIds)
  const order = entries.map((entry) => entry.entryId)
  const moving = new Set(entryIds)
  if ((insertion.at === 'before' || insertion.at === 'after') && moving.has(insertion.entryId)) {
    return { order, at: null }
  }
  const at = insertionIndex(order, insertion, moving)
  const rest = order.filter((id) => !moving.has(id))
  const block = order.filter((id) => moving.has(id))
  return { order: [...rest.slice(0, at), ...block, ...rest.slice(at)], at }
}

export interface OrderMove {
  entryId: number
  insertion: PlaylistInsertion
}

/**
 * The single-entry moves that turn the playlist into `target`, which must name
 * every entry exactly once.
 *
 * The longest run of entries already in the right relative order stays put
 * (a longest increasing subsequence of their current indices), and every other
 * entry is moved, in target order, to just after its target predecessor. Each
 * placement keeps everything placed so far — and everything staying — in
 * target order, so the last move leaves the whole playlist in it. A playlist
 * already in order needs no moves.
 */
export function planOrder(
  entries: readonly OrganizeEntry[],
  target: readonly number[]
): OrderMove[] {
  if (target.length !== entries.length || new Set(target).size !== target.length) {
    throw new ToolInputError(
      `entryIds must list every entry of the playlist exactly once: it has ${entries.length} ` +
        `entries and the order names ${new Set(target).size} distinct ones.`
    )
  }
  assertEntriesInPlaylist(entries, target)

  const currentIndex = new Map(entries.map((entry, index) => [entry.entryId, index]))
  const sequence = target.map((id) => currentIndex.get(id)!)
  const keep = longestIncreasing(sequence)

  const moves: OrderMove[] = []
  target.forEach((entryId, i) => {
    if (keep.has(i)) return
    moves.push({
      entryId,
      insertion: i === 0 ? { at: 'start' } : { at: 'after', entryId: target[i - 1]! }
    })
  })
  return moves
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: readonly number[]): Set<number> {
  // tails[k]: index of the smallest tail of an increasing run of length k + 1.
  const tails: number[] = []
  const previous: number[] = new Array<number>(values.length).fill(-1)
  values.forEach((value, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (values[tails[mid]!]! < value) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tails[lo - 1]!
    tails[lo] = i
  })
  const keep = new Set<number>()
  let at = tails.length > 0 ? tails[tails.length - 1]! : -1
  while (at !== -1) {
    keep.add(at)
    at = previous[at]!
  }
  return keep
}
