import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'
import { createPlaylistRename } from './playlistRename'
import { createReorderDrag } from './playlistReorder'
import type { Playlist } from '@shared/playlists'

/**
 * The rail's rules, with no DOM underneath them.
 *
 * The rail is the list of *every* playlist; the tab strip is the few that are
 * open. Splitting them is what makes a tab closeable: before the rail existed
 * the strip drew the whole library, so closing a tab and deleting a playlist
 * were necessarily the same gesture, and the close button called `remove`.
 *
 * So the destructive verbs live here and only here. This module can delete,
 * rename and reorder the library's playlists; `playlistTabs` can do none of
 * those. That is a structural guarantee rather than a convention — the strip's
 * `PlaylistTabCommands` has no `remove` to call.
 *
 * Focus is a third thing, separate from viewed and from playing. A rail is a
 * listbox: arrowing through it moves a highlight, and Enter is what opens. If
 * the arrows opened tabs, walking a hundred playlists to find one would leave a
 * hundred tabs behind.
 */

export type { DropSide } from './playlistReorder'
export { PLAYLIST_NAME_MAX_LENGTH } from './playlistRename'

/** The name a playlist is born with, before the user types over it. */
export const NEW_PLAYLIST_NAME = 'New playlist'

/** What a keypress turned into, so the component knows whether to swallow it. */
export type RailKeyAction = 'none' | 'navigate' | 'open' | 'rename' | 'delete'

/** Structural rather than `KeyboardEvent`, for the reason `TabKeyEvent` is. */
export interface RailKeyEvent {
  readonly key: string
  readonly altKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/** One drawn row: the playlist, plus the three states it can be in at once. */
export interface RailRow {
  readonly playlist: Playlist
  readonly isOpen: boolean
  readonly isViewed: boolean
  readonly isPlaying: boolean
  readonly isFocused: boolean
}

export interface PlaylistRailCommands {
  /** Opens a tab if there is not one, and views it. Idempotent. */
  open(playlistId: number): void
  create(name: string): Promise<Playlist | null>
  rename(playlistId: number, name: string): Promise<void>
  remove(playlistId: number): Promise<void>
  /** Writes `playlists.position`. The rail is the only surface that does. */
  reorder(playlistId: number, toIndex: number): Promise<void>
  /** §5 rule 3: starts the playlist, making it the playing one. */
  play(playlist: Playlist): void
}

export interface PlaylistRailDeps {
  /** Every playlist, in `playlists.position` order. */
  playlists: MaybeRefOrGetter<readonly Playlist[]>
  /** The ids with a tab, so a row can say whether it is already open. */
  openIds: MaybeRefOrGetter<readonly number[]>
  viewedId: MaybeRefOrGetter<number | null>
  /** From the playback controller, never from the playlists store. See §5. */
  playingId: MaybeRefOrGetter<number | null>
  commands: PlaylistRailCommands
}

/** A delete the user has to agree to before it happens. */
export interface DeletePrompt {
  playlistId: number
  name: string
  title: string
  message: string
  /** §5 rule 4: deleting the playing playlist stops playback, and saying so is the point of the prompt. */
  stopsPlayback: boolean
}

export function createPlaylistRail(deps: PlaylistRailDeps) {
  const { commands } = deps

  const playlists = computed(() => toValue(deps.playlists))
  const openIds = computed(() => toValue(deps.openIds))
  const viewedId = computed(() => toValue(deps.viewedId))
  const playingId = computed(() => toValue(deps.playingId))
  const order = computed(() => playlists.value.map((playlist) => playlist.id))

  const focusedId = ref<number | null>(null)
  const pendingDeleteId = ref<number | null>(null)

  function find(playlistId: number): Playlist | null {
    return playlists.value.find((candidate) => candidate.id === playlistId) ?? null
  }

  const isOpen = (playlistId: number): boolean => openIds.value.includes(playlistId)
  const isViewed = (playlistId: number): boolean => playlistId === viewedId.value
  const isPlaying = (playlistId: number): boolean => playlistId === playingId.value

  /**
   * Where the roving tabindex sits.
   *
   * Falls back to the viewed row and then to the first, so tabbing into a rail
   * nobody has arrowed through yet lands somewhere meaningful rather than on row
   * zero of two hundred. The fallback is not cosmetic: a roving tabindex with no
   * resting place is a list the Tab key cannot enter at all, which is what a
   * bare `focusedId` comparison would have produced before anyone arrowed.
   */
  const focusIndex = computed(() => {
    const explicit = order.value.indexOf(focusedId.value ?? -1)
    if (explicit !== -1) return explicit
    const viewed = order.value.indexOf(viewedId.value ?? -1)
    return viewed !== -1 ? viewed : playlists.value.length > 0 ? 0 : -1
  })

  /** Exactly one row is focusable, and `focusIndex` is the only thing that says which. */
  const rows = computed<RailRow[]>(() =>
    playlists.value.map((playlist, index) => ({
      playlist,
      isOpen: isOpen(playlist.id),
      isViewed: isViewed(playlist.id),
      isPlaying: isPlaying(playlist.id),
      isFocused: index === focusIndex.value
    }))
  )

  const rename = createPlaylistRename({ find, commit: commands.rename })

  // -- opening --------------------------------------------------------------

  /**
   * A single click: open the playlist as a tab and view it.
   *
   * Opening an already-open playlist just views it, which is why the store's
   * verb is idempotent — the rail should not have to ask.
   */
  function activate(playlistId: number): void {
    if (find(playlistId) === null) return
    rename.cancel()
    focusedId.value = playlistId
    commands.open(playlistId)
  }

  /**
   * A double click: open it *and* start playing it, from the top.
   *
   * The open is not optional. §5 rule 3 makes this the playing playlist, and a
   * playlist that started playing without appearing in the strip would be one
   * the operator can hear and cannot get to.
   *
   * An empty playlist opens and does not play. There is no position 0 to start
   * at, and a transport that went through the motions on nothing would leave
   * `playingPlaylistId` naming a playlist that is not audible.
   */
  function play(playlistId: number): void {
    const playlist = find(playlistId)
    if (playlist === null) return
    activate(playlistId)
    if (playlist.trackCount === 0) return
    commands.play(playlist)
  }

  // -- focus ----------------------------------------------------------------

  function focusAt(index: number): boolean {
    if (playlists.value.length === 0) return false
    const clamped = Math.max(0, Math.min(index, playlists.value.length - 1))
    const target = playlists.value[clamped]
    if (target === undefined) return false
    focusedId.value = target.id
    return true
  }

  /** Clamped, not wrapped, matching the strip: a list has ends. */
  function focusRelative(delta: number): boolean {
    const from =
      focusIndex.value === -1 ? (delta < 0 ? playlists.value.length : -1) : focusIndex.value
    return focusAt(from + delta)
  }

  // -- create ---------------------------------------------------------------

  /**
   * Makes a playlist, opens it, and drops straight into renaming it.
   *
   * A dialog asking for a name before the playlist exists is one more modal than
   * this needs, and it makes the common case — make one, drag things onto it,
   * name it later — cost a decision up front. The default name is already
   * selected, so typing replaces it and Escape keeps it.
   */
  async function create(): Promise<void> {
    const created = await commands.create(NEW_PLAYLIST_NAME)
    if (created === null) return
    focusedId.value = created.id
    rename.begin(created.id)
  }

  // -- delete ---------------------------------------------------------------

  function needsConfirmation(target: Playlist): boolean {
    return target.trackCount > 0 || isPlaying(target.id)
  }

  /** Deletes an empty, silent playlist outright; anything else becomes a prompt. */
  async function requestDelete(playlistId: number): Promise<void> {
    const target = find(playlistId)
    if (target === null) return
    rename.cancel()
    if (needsConfirmation(target)) {
      pendingDeleteId.value = playlistId
      return
    }
    await commands.remove(playlistId)
  }

  const deletePrompt = computed<DeletePrompt | null>(() => {
    if (pendingDeleteId.value === null) return null
    const target = find(pendingDeleteId.value)
    if (target === null) return null

    const stopsPlayback = isPlaying(target.id)
    const sentences: string[] = []
    if (stopsPlayback) sentences.push('This playlist is playing. Deleting it stops playback.')
    if (target.trackCount > 0) {
      const entries = target.trackCount === 1 ? '1 entry' : `${target.trackCount} entries`
      sentences.push(`Its ${entries} go with it. The files stay on disk.`)
    }

    return {
      playlistId: target.id,
      name: target.name,
      title: `Delete “${target.name}”?`,
      message: sentences.join(' '),
      stopsPlayback
    }
  })

  async function confirmDelete(): Promise<void> {
    const playlistId = pendingDeleteId.value
    pendingDeleteId.value = null
    if (playlistId === null) return
    await commands.remove(playlistId)
  }

  function cancelDelete(): void {
    pendingDeleteId.value = null
  }

  // -- drag to reorder ------------------------------------------------------

  /**
   * The persisted order. `playlists.reorder` renumbers the whole list in one
   * transaction, and this is its only caller — the strip's drag moves a tab
   * inside the open set and never reaches here.
   */
  const drag = createReorderDrag(
    () => order.value,
    (playlistId, toIndex) => commands.reorder(playlistId, toIndex),
    () => rename.cancel()
  )

  // -- keyboard -------------------------------------------------------------

  /**
   * The rail's keymap. Inert while renaming, because the input owns its keys.
   *
   * Enter opens rather than the arrows doing it, and Delete deletes rather than
   * closing: this is the surface where the row *is* the playlist, so the
   * destructive key belongs to it and the strip's does not.
   */
  function onKeydown(event: RailKeyEvent): RailKeyAction {
    if (rename.renamingId.value !== null) return 'none'
    if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return 'none'

    const focused = focusIndex.value === -1 ? null : (order.value[focusIndex.value] ?? null)

    switch (event.key) {
      case 'ArrowUp':
        focusRelative(-1)
        return 'navigate'
      case 'ArrowDown':
        focusRelative(1)
        return 'navigate'
      case 'Home':
        focusAt(0)
        return 'navigate'
      case 'End':
        focusAt(playlists.value.length - 1)
        return 'navigate'
      case 'Enter':
      case ' ':
        if (focused === null) return 'none'
        activate(focused)
        return 'open'
      case 'F2':
        if (focused === null) return 'none'
        return rename.begin(focused) ? 'rename' : 'none'
      case 'Delete':
        if (focused === null) return 'none'
        void requestDelete(focused)
        return 'delete'
      default:
        return 'none'
    }
  }

  return {
    rows,
    playlists,
    viewedId,
    playingId,
    focusedId,
    focusIndex,
    isOpen,
    isViewed,
    isPlaying,
    renamingId: rename.renamingId,
    draft: rename.draft,
    pendingDeleteId,
    deletePrompt,
    dragId: drag.dragId,
    activate,
    play,
    focusAt,
    focusRelative,
    create,
    beginRename: rename.begin,
    commitRename: rename.commit,
    cancelRename: rename.cancel,
    requestDelete,
    confirmDelete,
    cancelDelete,
    beginDrag: drag.begin,
    dragOver: drag.over,
    dropIndicator: drag.indicator,
    drop: drag.drop,
    endDrag: drag.end,
    onKeydown
  }
}

export type PlaylistRail = ReturnType<typeof createPlaylistRail>
