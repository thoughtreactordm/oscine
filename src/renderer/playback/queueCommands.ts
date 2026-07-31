import type { Track } from '@shared/library'
import { MAX_TRACK_PAGE } from '@shared/library'
import type { QueueEntry } from './upNextQueue'

/**
 * The queue verbs, in one module, with nothing under them but their `deps`.
 *
 * "Play next" and "Add to queue" are offered from the library list, from the
 * playlist contents pane, and from any multi-select in either; the overlay adds
 * remove, clear and jump. Five verbs, three call sites, and W7-2 is about to add
 * a fourth — the Tunedeck's up-next pane, which replaces this overlay's *body*
 * and must not have to reimplement any of them. That is the whole reason this is
 * a module and not a method on a component: the pane imports it unchanged.
 *
 * No Pinia, no DOM, no `AudioEngine`. `upNextQueue.ts` is headless for the same
 * reason and this sits directly on it.
 *
 * ## Why a target rather than a `Track[]`
 *
 * A right-click on one row is holding that row already. A multi-select of four
 * thousand is holding *ids* — the list resolves a selection through main
 * precisely so it never has to keep the rows — and the queue stores display
 * snapshots (§5's `QueueEntry.track`), so somebody has to widen them. Doing it
 * here means both call sites hand over what they actually have and neither pays
 * for a round trip it did not need.
 */

/** What a queue verb is aimed at. */
export type QueueTarget =
  /** Rows the caller is already holding — a right-click on a loaded row. */
  | { readonly kind: 'rows'; readonly tracks: readonly Track[] }
  /** A selection, in its visible order, to be widened through main. */
  | { readonly kind: 'ids'; readonly trackIds: readonly number[] }

export function queueRows(tracks: readonly Track[]): QueueTarget {
  return { kind: 'rows', tracks }
}

export function queueIds(trackIds: readonly number[]): QueueTarget {
  return { kind: 'ids', trackIds }
}

/** The slice of the up-next queue these verbs drive. */
export interface QueueCommandsQueue {
  enqueue: (tracks: readonly Track[]) => unknown
  enqueueNext: (tracks: readonly Track[]) => unknown
  remove: (entryId: string) => unknown
  /** Clears the hand-queued rows only. See `clearUser` below. */
  clearUser: () => unknown
  clear: () => unknown
  /** Plays a queued entry now, out of turn (§5 rule 1's shift). */
  play: (entryId: string) => void | Promise<void>
}

export interface QueueCommandsDeps {
  /**
   * Widens an id list into rows, in the order given, dropping ids the library
   * no longer has. Never called with more than `chunkSize` at once.
   */
  fetchTracks: (trackIds: readonly number[]) => Promise<readonly Track[]>
  queue: QueueCommandsQueue
  /** Ids per request. Defaults to the row-page ceiling the contract enforces. */
  chunkSize?: number
}

export function createQueueCommands(deps: QueueCommandsDeps) {
  const chunkSize = Math.max(1, deps.chunkSize ?? MAX_TRACK_PAGE)

  /**
   * Resolves a target to rows **in the order the user saw them**.
   *
   * Sequential rather than concurrent, and concatenated in request order:
   * "queueing from a multi-select preserves the selection's visible order" is
   * the acceptance criterion, and racing the chunks would settle it by whichever
   * query finished first. The chunks exist because the response carries display
   * rows and is capped at `MAX_TRACK_PAGE` like every other row-returning
   * request — the queue itself has no such limit.
   */
  async function resolve(target: QueueTarget): Promise<readonly Track[]> {
    if (target.kind === 'rows') return target.tracks

    const rows: Track[] = []
    for (let offset = 0; offset < target.trackIds.length; offset += chunkSize) {
      rows.push(...(await deps.fetchTracks(target.trackIds.slice(offset, offset + chunkSize))))
    }
    return rows
  }

  /**
   * Both additions in one shape, because they differ only in where the rows
   * land — §5 rule 2 holds for either: neither touches `playingPlaylistId` nor
   * the current position, which is a property of the queue and not of these.
   */
  async function add(target: QueueTarget, next: boolean): Promise<number> {
    const tracks = await resolve(target)
    if (tracks.length === 0) return 0
    if (next) deps.queue.enqueueNext(tracks)
    else deps.queue.enqueue(tracks)
    return tracks.length
  }

  return {
    /** Inserts at the head, so these play before anything already queued. */
    playNext: (target: QueueTarget): Promise<number> => add(target, true),
    /** Appends, after everything already queued. */
    addToQueue: (target: QueueTarget): Promise<number> => add(target, false),
    remove: (entryId: string): void => void deps.queue.remove(entryId),
    /**
     * Clears what the operator put there, and only that.
     *
     * The verb the up-next surface actually offers, because the session tier is
     * not the operator's to lose: it is a view of the scope that is playing, it
     * comes back on the next click, and a "Clear" that wiped three hundred rows
     * nobody chose would be a button that undoes nothing it did.
     */
    clearUser: (): void => void deps.queue.clearUser(),
    /** Both tiers. The surface offers `clearUser`; this is for a full reset. */
    clear: (): void => void deps.queue.clear(),
    /** Jump-to-entry: plays it now and takes only it out of the queue. */
    jumpTo: (entryId: string): Promise<void> => Promise.resolve(deps.queue.play(entryId))
  }
}

export type QueueCommands = ReturnType<typeof createQueueCommands>

/**
 * How a verb names what it is about to do.
 *
 * Here rather than in the components that build menus, so that "Play next" and
 * "Play 4,312 tracks next" cannot drift apart between the library, the playlist
 * pane and the sidebar — and so that W7-2 gets the same wording without copying
 * it.
 *
 * `unit` is what the operator selected rather than what will be queued: the
 * facet panes hold artists and albums, and how many *tracks* three artists come
 * to is a query away and not what the menu should be waiting on. Already plural;
 * `count` of one never uses it.
 */
export function queueCommandLabel(
  verb: 'playNext' | 'addToQueue',
  count: number,
  unit = 'tracks'
): string {
  const many = count > 1 ? `${count.toLocaleString()} ${unit}` : null
  if (verb === 'playNext') return many === null ? 'Play next' : `Play ${many} next`
  return many === null ? 'Add to queue' : `Add ${many} to queue`
}

/** The overlay's row label. Exported so W7-2's deck pane reads the same. */
export function queueEntryLabel(entry: QueueEntry): string {
  return entry.track.artist === null
    ? entry.track.title
    : `${entry.track.artist} — ${entry.track.title}`
}
