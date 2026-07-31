import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { createPlaylistRename } from './playlistRename'
import { createReorderDrag } from './playlistReorder'
import type { Playlist } from '@shared/playlists'

/**
 * The tab strip's rules, with no DOM underneath them.
 *
 * Its own module for the reason `columnLayout` and `facetWindow` are: what makes
 * a tab bar wrong is arithmetic and state machines, not markup. A drag that
 * lands one tab off, a rename that commits an empty name — neither needs a
 * browser to reproduce, and neither would be caught by looking at the component.
 *
 * **The strip shows the playlists that are *open*, not every playlist.** That is
 * the whole of W5-9 and it is worth stating here, because the first version of
 * this module took `tabs` to be `playlists.list` and the close button therefore
 * had to be a delete — there was no other thing it could mean. The rail
 * (`playlistRail`) is now where a playlist is opened, deleted and reordered;
 * this file closes tabs and never destroys anything.
 *
 * The two indicators the card asks for are why the model takes `viewedId` and
 * `playingId` as separate inputs rather than deriving one from the other. §5
 * makes them different facts owned by different stores, and a tab bar that
 * computed "playing" as "viewed and playback is running" would be quietly
 * asserting the opposite.
 */

export { PLAYLIST_NAME_MAX_LENGTH } from './playlistRename'
export { destinationIndex, type DropSide } from './playlistReorder'

/**
 * What a keypress turned into, so the component knows whether to swallow it and
 * whether focus has to chase the selection.
 *
 * Returned rather than handled here because moving focus is the one part of this
 * that is genuinely a DOM operation, and pushing an element reference into the
 * model to do it would put a browser back under the thing that exists not to
 * need one.
 */
export type TabKeyAction = 'none' | 'navigate' | 'rename' | 'close'

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
 *
 * There is no `remove` here, and its absence is the design: a strip that cannot
 * reach a delete verb cannot grow a close button that deletes.
 */
export interface PlaylistTabCommands {
  view(playlistId: number | null): void
  rename(playlistId: number, name: string): Promise<void>
  /** Takes the tab off the strip. The playlist survives. */
  close(playlistId: number): void
  /** Moves a tab within the open set. Never touches `playlists.position`. */
  moveOpen(playlistId: number, toIndex: number): void
}

export interface PlaylistTabsDeps {
  /** The *open* playlists, in tab order. */
  tabs: MaybeRefOrGetter<readonly Playlist[]>
  viewedId: MaybeRefOrGetter<number | null>
  /** From the playback controller, never from this store. See §5. */
  playingId: MaybeRefOrGetter<number | null>
  commands: PlaylistTabCommands
}

export function createPlaylistTabs(deps: PlaylistTabsDeps) {
  const { commands } = deps

  const tabs = computed(() => toValue(deps.tabs))
  const viewedId = computed(() => toValue(deps.viewedId))
  const playingId = computed(() => toValue(deps.playingId))
  const order = computed(() => tabs.value.map((tab) => tab.id))

  const viewedIndex = computed(() => order.value.indexOf(viewedId.value ?? -1))

  function tab(playlistId: number): Playlist | null {
    return tabs.value.find((candidate) => candidate.id === playlistId) ?? null
  }

  const isViewed = (playlistId: number): boolean => playlistId === viewedId.value
  const isPlaying = (playlistId: number): boolean => playlistId === playingId.value

  const rename = createPlaylistRename({ find: tab, commit: commands.rename })

  // -- selection ------------------------------------------------------------

  function select(playlistId: number): void {
    if (playlistId === viewedId.value) return
    rename.cancel()
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

  // -- close ----------------------------------------------------------------

  /**
   * Closes a tab. No confirmation, and no confirmation is *possible* — nothing
   * is lost, the playlist is still in the rail, and a dialog would train the
   * operator to dismiss the one that matters.
   *
   * Which tab is viewed afterwards is the store's business, because it is the
   * thing that knows what the neighbours are.
   */
  function close(playlistId: number): void {
    if (tab(playlistId) === null) return
    if (rename.renamingId.value === playlistId) rename.cancel()
    commands.close(playlistId)
  }

  // -- drag to reorder ------------------------------------------------------

  /**
   * Local only. The rail's drag writes `playlists.position`; this one rearranges
   * the open set and nothing else, so an operator can put the two playlists they
   * are cross-checking side by side without renumbering their library.
   */
  const drag = createReorderDrag(
    () => order.value,
    (playlistId, toIndex) => commands.moveOpen(playlistId, toIndex),
    () => rename.cancel()
  )

  // -- keyboard -------------------------------------------------------------

  /**
   * The strip's keymap. Inert while renaming, because the input owns its keys —
   * Left in a text field is a caret, not a tab.
   *
   * Delete closes rather than deletes. It used to delete, back when a tab was a
   * playlist; the destructive key now lives in the rail, where the thing under
   * the cursor is the playlist itself.
   */
  function onKeydown(event: TabKeyEvent): TabKeyAction {
    if (rename.renamingId.value !== null) return 'none'
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
        return rename.begin(viewedId.value) ? 'rename' : 'none'
      case 'Delete':
        if (viewedId.value === null) return 'none'
        close(viewedId.value)
        return 'close'
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
    renamingId: rename.renamingId,
    draft: rename.draft,
    dragId: drag.dragId,
    select,
    selectAt,
    selectRelative,
    beginRename: rename.begin,
    commitRename: rename.commit,
    cancelRename: rename.cancel,
    close,
    beginDrag: drag.begin,
    dragOver: drag.over,
    dropIndicator: drag.indicator,
    drop: drag.drop,
    endDrag: drag.end,
    onKeydown
  }
}

export type PlaylistTabs = ReturnType<typeof createPlaylistTabs>
