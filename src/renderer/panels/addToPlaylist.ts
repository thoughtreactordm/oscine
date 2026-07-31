import { ref, toValue, type MaybeRefOrGetter } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import type { Playlist } from '@shared/playlists'

/**
 * "Add these to a playlist", from wherever the operator is standing.
 *
 * The gesture started life inside `LibraryView`, aimed at track rows, and that
 * was the whole of it: one menu, one kind of thing to add, one list of targets
 * built inline. It is four surfaces now — the song list, both facet panes, the
 * playlist contents pane — and the fourth is not a track list at all: an artist
 * row is a *predicate*, and what it adds is however many tracks that predicate
 * currently matches.
 *
 * So the target is a resolver rather than a list. A right-click on one artist is
 * holding an artist id and nothing else; asking main for eight hundred track ids
 * to draw a menu the operator may not click would be a query per right-click.
 * The ids are fetched when the verb is taken, which is also the only moment they
 * are known to be current.
 *
 * ## Why the model, and not four components
 *
 * The submenu has to list every playlist and end in "New playlist…", the new one
 * has to be named in a modal, and the modal has to be somewhere that outlives
 * the pane the gesture came from — the sidebar unmounts on a tab change, and an
 * add started from it must not be cancelled by looking at Now Playing. That is
 * three things the call sites cannot each own a copy of, which is what makes
 * this a model with a store over it rather than a helper.
 *
 * Headless in the sense the rest of `panels/` is: no Pinia, no IPC, no DOM. The
 * store bolts the real playlists onto it; the tests bolt fakes.
 */

/**
 * Track ids for a gesture, resolved when the gesture is taken.
 *
 * A promise because every honest answer is one: a track multi-select resolves
 * its order through main, and a facet row has to be widened into the tracks it
 * matches. See `resolveSelection` and `browse.facetTrackIds`.
 */
export type TrackIdResolver = () => Promise<readonly number[]>

/** What an "add to playlist" gesture is aimed at. */
export interface AddTarget {
  readonly trackIds: TrackIdResolver
  /**
   * How many *things the operator selected* — tracks, artists, albums — for the
   * menu wording. Deliberately not a track count: a facet row's track count is
   * a query away, and "Add 3 artists to playlist" is what the operator did.
   */
  readonly count: number
  /** Plural noun for `count`. Defaults to tracks. */
  readonly unit?: string
  /**
   * What to put in the new-playlist field. An album or an artist names itself
   * far better than an empty box does; a track selection has no such name and
   * leaves it blank.
   */
  readonly suggestedName?: string
}

/** How an add went, published for whatever surface is drawing notifications. */
export interface AddOutcome {
  readonly kind: 'added' | 'failed'
  readonly message: string
  /** Two adds to the same playlist are two events, not one. */
  readonly seq: number
}

export interface AddToPlaylistDeps {
  /** Every playlist, in rail order — the submenu's targets. */
  playlists: MaybeRefOrGetter<readonly Playlist[]>
  /** Creates one, without opening a tab. Resolves `null` if it could not. */
  create: (name: string) => Promise<Playlist | null>
  /** Appends to an existing one. Resolves `false` if it could not. */
  addTracks: (playlistId: number, trackIds: readonly number[]) => Promise<boolean>
}

/** The submenu's label, and the modal's heading. */
export function addToPlaylistLabel(count: number, unit = 'tracks'): string {
  return count > 1 ? `Add ${count.toLocaleString()} ${unit} to playlist` : 'Add to playlist'
}

function tracksPhrase(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'track' : 'tracks'}`
}

export function createAddToPlaylist(deps: AddToPlaylistDeps) {
  /** Modal state. `count` and `unit` are the target's, kept for the heading. */
  const open = ref(false)
  const draft = ref('')
  const count = ref(0)
  const unit = ref('tracks')
  const outcome = ref<AddOutcome | null>(null)

  /**
   * The target the modal is about, held outside the refs above.
   *
   * Not reactive on purpose: it is a closure over whichever pane was
   * right-clicked, and nothing renders it. Putting a function in a `ref` would
   * only invite Vue to unwrap it somewhere.
   */
  let pending: AddTarget | null = null

  function report(kind: AddOutcome['kind'], message: string): void {
    outcome.value = { kind, message, seq: (outcome.value?.seq ?? 0) + 1 }
  }

  /**
   * Resolve, then add, then say so.
   *
   * Every failure is reported rather than thrown. These run detached from the
   * click that started them — the menu has closed and, for a new playlist, so
   * has the modal — so a rejection has nowhere left to surface except here.
   */
  async function addTo(playlistId: number, target: AddTarget): Promise<void> {
    const playlist = toValue(deps.playlists).find((candidate) => candidate.id === playlistId)
    const name = playlist?.name ?? 'that playlist'
    let ids: readonly number[]
    try {
      ids = await target.trackIds()
    } catch {
      report('failed', `Could not work out what to add to “${name}”.`)
      return
    }
    if (ids.length === 0) {
      report('failed', `There was nothing to add to “${name}”.`)
      return
    }
    const added = await deps.addTracks(playlistId, ids)
    if (added) report('added', `Added ${tracksPhrase(ids.length)} to “${name}”.`)
    else report('failed', `Those tracks could not be added to “${name}”.`)
  }

  /** Opens the name prompt for a target. */
  function beginNew(target: AddTarget): void {
    pending = target
    count.value = target.count
    unit.value = target.unit ?? 'tracks'
    draft.value = target.suggestedName ?? ''
    open.value = true
  }

  function cancel(): void {
    open.value = false
    pending = null
    draft.value = ''
  }

  /**
   * Names the playlist and lets go.
   *
   * The modal closes *first* and the work runs after it, which is the point of
   * the feature: an artist with eleven hundred tracks is one create, one id
   * query and one insert, and none of them are a reason to hold a dialog open
   * over a library the operator is still browsing.
   *
   * The ids are resolved before the playlist is created, so a failed resolve
   * leaves nothing behind. The other order would leave an empty playlist named
   * after an add that never happened, and the operator would have to go and
   * delete it.
   *
   * Blank is a cancel, exactly as it is in `playlistRename` — select-all,
   * Delete, Enter plainly means "never mind" and should not raise a validation
   * error from the IPC boundary.
   */
  async function confirm(): Promise<void> {
    const name = draft.value.trim()
    const target = pending
    if (target === null) return
    if (name.length === 0) {
      cancel()
      return
    }
    cancel()

    let ids: readonly number[]
    try {
      ids = await target.trackIds()
    } catch {
      report('failed', `Could not work out what to put in “${name}”.`)
      return
    }

    const created = await deps.create(name)
    if (created === null) {
      report('failed', `“${name}” could not be created.`)
      return
    }
    if (ids.length === 0) {
      report('added', `Created “${name}”, which is empty.`)
      return
    }

    const added = await deps.addTracks(created.id, ids)
    if (added) report('added', `Created “${name}” with ${tracksPhrase(ids.length)}.`)
    else report('failed', `“${name}” was created, but those tracks could not be added.`)
  }

  /**
   * The submenu, built fresh per right-click because the target is.
   *
   * "New playlist…" is last and always present — including when there are no
   * playlists at all, where the old menu offered a disabled "No playlists yet"
   * and left the operator with nothing to click.
   */
  function menuItem(target: AddTarget): ContextMenuItem {
    const create: ContextMenuItem = {
      label: 'New playlist…',
      icon: 'i-tabler-plus',
      onSelect: () => beginNew(target)
    }
    const existing: ContextMenuItem[] = toValue(deps.playlists).map((playlist) => ({
      label: playlist.name,
      onSelect: () => void addTo(playlist.id, target)
    }))
    return {
      label: addToPlaylistLabel(target.count, target.unit),
      icon: 'i-tabler-playlist-add',
      children: existing.length === 0 ? [create] : [...existing, { type: 'separator' }, create]
    }
  }

  return {
    open,
    draft,
    count,
    unit,
    outcome,
    menuItem,
    addTo,
    beginNew,
    cancel,
    confirm
  }
}

export type AddToPlaylist = ReturnType<typeof createAddToPlaylist>
