import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'
import { MAX_PLAYLIST_NAME_LENGTH, type Playlist } from '@shared/playlists'

/**
 * The tab strip's rules, with no DOM underneath them.
 *
 * Its own module for the reason `columnLayout` and `facetWindow` are: what makes
 * a tab bar wrong is arithmetic and state machines, not markup. A drag that
 * lands one tab off, a rename that commits an empty name, a delete that skips
 * its confirmation — none of those need a browser to reproduce, and none of them
 * would be caught by looking at the component.
 *
 * The two indicators the card asks for are why the model takes `viewedId` and
 * `playingId` as separate inputs rather than deriving one from the other. §5
 * makes them different facts owned by different stores, and a tab bar that
 * computed "playing" as "viewed and playback is running" would be quietly
 * asserting the opposite.
 */

export type DropSide = 'before' | 'after'

/** The name a tab is born with, before the user types over it. */
export const NEW_PLAYLIST_NAME = 'New playlist'

/** Re-exported so the rename input can bound itself at the same value the IPC boundary does. */
export const PLAYLIST_NAME_MAX_LENGTH = MAX_PLAYLIST_NAME_LENGTH

/**
 * What a keypress turned into, so the component knows whether to swallow it and
 * whether focus has to chase the selection.
 *
 * Returned rather than handled here because moving focus is the one part of this
 * that is genuinely a DOM operation, and pushing an element reference into the
 * model to do it would put a browser back under the thing that exists not to
 * need one.
 */
export type TabKeyAction = 'none' | 'navigate' | 'rename' | 'delete'

/**
 * The parts of a keydown the strip reads.
 *
 * Structural rather than `KeyboardEvent`, matching `SelectionModifiers`: this
 * module is compiled for the unit tests under a tsconfig with no DOM lib and run
 * under plain Node, where there is no `KeyboardEvent` to name or to construct. A
 * real event satisfies the shape, so the component passes one straight through.
 */
export interface TabKeyEvent {
  readonly key: string
  readonly altKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/**
 * The writes the strip performs.
 *
 * An interface rather than the store itself so the model can be driven by a
 * recorder in a test. Every one of these is a `usePlaylistsStore` method with
 * the same name; the indirection buys the test, not a second abstraction.
 */
export interface PlaylistTabCommands {
  view(playlistId: number | null): void
  create(name: string): Promise<Playlist | null>
  rename(playlistId: number, name: string): Promise<void>
  remove(playlistId: number): Promise<void>
  reorder(playlistId: number, toIndex: number): Promise<void>
}

export interface PlaylistTabsDeps {
  tabs: MaybeRefOrGetter<readonly Playlist[]>
  viewedId: MaybeRefOrGetter<number | null>
  /** From the playback controller, never from this store. See §5. */
  playingId: MaybeRefOrGetter<number | null>
  commands: PlaylistTabCommands
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

/**
 * Where a drag lands, expressed the way `playlists.reorder` reads it.
 *
 * The main-process store splices the tab out before splicing it back in
 * (`PlaylistStore.reorder`), so `toIndex` is an index into the list *without*
 * the dragged tab in it. Computing the insertion point in the visible list and
 * handing that over unadjusted is the off-by-one this function exists to stop:
 * it only bites when dragging rightwards, so it survives casual testing.
 *
 * `null` means the gesture is a no-op — dropped on itself, or dropped into the
 * gap it already occupies, which is what "after my left neighbour" is.
 */
export function destinationIndex(
  order: readonly number[],
  draggedId: number,
  targetId: number,
  side: DropSide
): number | null {
  const from = order.indexOf(draggedId)
  const target = order.indexOf(targetId)
  if (from === -1 || target === -1) return null

  const insertAt = side === 'before' ? target : target + 1
  const toIndex = insertAt - (from < insertAt ? 1 : 0)
  return toIndex === from ? null : toIndex
}

export function createPlaylistTabs(deps: PlaylistTabsDeps) {
  const { commands } = deps

  const tabs = computed(() => toValue(deps.tabs))
  const viewedId = computed(() => toValue(deps.viewedId))
  const playingId = computed(() => toValue(deps.playingId))
  const order = computed(() => tabs.value.map((tab) => tab.id))

  const renamingId = ref<number | null>(null)
  const draft = ref('')
  /** What the tab was called when the rename began, so an unchanged name costs no round trip. */
  const renameOrigin = ref('')

  const pendingDeleteId = ref<number | null>(null)

  const dragId = ref<number | null>(null)
  const dropTargetId = ref<number | null>(null)
  const dropSide = ref<DropSide | null>(null)

  const viewedIndex = computed(() => order.value.indexOf(viewedId.value ?? -1))

  function tab(playlistId: number): Playlist | null {
    return tabs.value.find((candidate) => candidate.id === playlistId) ?? null
  }

  const isViewed = (playlistId: number): boolean => playlistId === viewedId.value
  const isPlaying = (playlistId: number): boolean => playlistId === playingId.value

  // -- selection ------------------------------------------------------------

  function select(playlistId: number): void {
    if (playlistId === viewedId.value) return
    cancelRename()
    commands.view(playlistId)
  }

  /** Clamped, not wrapped: a tab bar has ends, and arrowing off one is a mistake, not a cycle. */
  function selectAt(index: number): boolean {
    if (tabs.value.length === 0) return false
    const clamped = Math.max(0, Math.min(index, tabs.value.length - 1))
    const target = tabs.value[clamped]
    if (target === undefined || target.id === viewedId.value) return false
    select(target.id)
    return true
  }

  function selectRelative(delta: number): boolean {
    // An unknown viewed tab arrows in from the near end rather than from -1.
    const from = viewedIndex.value === -1 ? (delta < 0 ? tabs.value.length : -1) : viewedIndex.value
    return selectAt(from + delta)
  }

  // -- create ---------------------------------------------------------------

  /**
   * Makes a tab and drops straight into renaming it.
   *
   * A dialog asking for a name before the tab exists is one more modal than this
   * needs, and it makes the common case — make a tab, drag things onto it, name
   * it later — cost a decision up front. The default name is already selected,
   * so typing replaces it and Escape keeps it.
   */
  async function createTab(): Promise<void> {
    const created = await commands.create(NEW_PLAYLIST_NAME)
    if (created === null) return
    beginRename(created.id)
  }

  // -- rename ---------------------------------------------------------------

  function beginRename(playlistId: number): void {
    const target = tab(playlistId)
    if (target === null) return
    pendingDeleteId.value = null
    renamingId.value = playlistId
    renameOrigin.value = target.name
    draft.value = target.name
  }

  function cancelRename(): void {
    renamingId.value = null
    renameOrigin.value = ''
    draft.value = ''
  }

  /**
   * Commits the draft, or silently keeps the old name.
   *
   * Blank is a cancel rather than an error: `assertPlaylistName` rejects an
   * empty name at the boundary, so sending one would surface a validation
   * notice for a gesture — select-all, Delete, click away — that plainly meant
   * "never mind". Trimming here matches what the main process would have stored
   * anyway, which keeps an unchanged-name commit off the wire.
   */
  async function commitRename(): Promise<void> {
    const playlistId = renamingId.value
    const name = draft.value.trim()
    const origin = renameOrigin.value.trim()
    cancelRename()
    if (playlistId === null) return
    if (name.length === 0 || name === origin) return
    await commands.rename(playlistId, name)
  }

  // -- delete ---------------------------------------------------------------

  function needsConfirmation(target: Playlist): boolean {
    return target.trackCount > 0 || isPlaying(target.id)
  }

  /** Deletes an empty, silent tab outright; anything else becomes a prompt. */
  async function requestDelete(playlistId: number): Promise<void> {
    const target = tab(playlistId)
    if (target === null) return
    cancelRename()
    if (needsConfirmation(target)) {
      pendingDeleteId.value = playlistId
      return
    }
    await commands.remove(playlistId)
  }

  const deletePrompt = computed<DeletePrompt | null>(() => {
    if (pendingDeleteId.value === null) return null
    const target = tab(pendingDeleteId.value)
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

  function beginDrag(playlistId: number): void {
    cancelRename()
    dragId.value = playlistId
    dropTargetId.value = null
    dropSide.value = null
  }

  /**
   * Tracks the drop point, and reports whether the strip is claiming this drag.
   *
   * Declining anything the strip did not start matters: a selection dragged out
   * of the track list onto a tab is W5-5's gesture, and a bar that swallowed it
   * here would make that land nowhere. The indicator is set only where a real
   * move would happen, so hovering the gap a tab already occupies shows nothing
   * rather than promising a change that will not come.
   */
  function dragOver(targetId: number, side: DropSide): boolean {
    if (dragId.value === null) return false
    if (destinationIndex(order.value, dragId.value, targetId, side) === null) {
      dropTargetId.value = null
      dropSide.value = null
      return true
    }
    dropTargetId.value = targetId
    dropSide.value = side
    return true
  }

  /** `'before' | 'after' | null` for one tab, so the component draws exactly one edge. */
  function dropIndicator(playlistId: number): DropSide | null {
    return dropTargetId.value === playlistId ? dropSide.value : null
  }

  function endDrag(): void {
    dragId.value = null
    dropTargetId.value = null
    dropSide.value = null
  }

  async function drop(): Promise<void> {
    const moved = dragId.value
    const targetId = dropTargetId.value
    const side = dropSide.value
    endDrag()
    if (moved === null || targetId === null || side === null) return

    const toIndex = destinationIndex(order.value, moved, targetId, side)
    if (toIndex === null) return
    await commands.reorder(moved, toIndex)
  }

  // -- keyboard -------------------------------------------------------------

  /**
   * The strip's keymap. Inert while renaming, because the input owns its keys —
   * Left in a text field is a caret, not a tab.
   */
  function onKeydown(event: TabKeyEvent): TabKeyAction {
    if (renamingId.value !== null) return 'none'
    if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return 'none'

    switch (event.key) {
      case 'ArrowLeft':
        selectRelative(-1)
        return 'navigate'
      case 'ArrowRight':
        selectRelative(1)
        return 'navigate'
      case 'Home':
        selectAt(0)
        return 'navigate'
      case 'End':
        selectAt(tabs.value.length - 1)
        return 'navigate'
      case 'F2':
        if (viewedId.value === null) return 'none'
        beginRename(viewedId.value)
        return 'rename'
      case 'Delete':
        if (viewedId.value === null) return 'none'
        void requestDelete(viewedId.value)
        return 'delete'
      default:
        return 'none'
    }
  }

  return {
    tabs,
    viewedId,
    playingId,
    viewedIndex,
    isViewed,
    isPlaying,
    renamingId,
    draft,
    pendingDeleteId,
    deletePrompt,
    dragId,
    select,
    selectAt,
    selectRelative,
    createTab,
    beginRename,
    commitRename,
    cancelRename,
    requestDelete,
    confirmDelete,
    cancelDelete,
    beginDrag,
    dragOver,
    dropIndicator,
    drop,
    endDrag,
    onKeydown
  }
}

export type PlaylistTabs = ReturnType<typeof createPlaylistTabs>
