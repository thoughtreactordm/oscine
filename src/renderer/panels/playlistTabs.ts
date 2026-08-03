import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { createPlaylistRename } from './playlistRename'
import { createReorderDrag } from './playlistReorder'
import type { Playlist } from '@shared/playlists'
import { FAVORITES_TAB, type TabStop } from '@shared/settings'

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
 * The fixture tab at the left end of the strip, and what a null `viewedId`
 * means.
 *
 * The strip is therefore never empty. Discover is there whether or not any
 * playlist is open, it is where the view lands when the last tab closes, and it
 * is what a session with nothing restored opens on.
 *
 * Representing it as `null` rather than as a synthetic playlist row is the whole
 * of the trick, and it is why this change adds so little: `viewedId` was already
 * nullable, `commands.view` already took `number | null`, and `close` already
 * handed the view to `null` when it ran out of neighbours. Every verb that could
 * damage a fixture tab — `close`, `beginRename`, `beginDrag` — takes a `number`,
 * so "Discover cannot be closed, renamed or dragged" is a fact the type checker
 * holds rather than three branches someone has to remember to write.
 */
export const DISCOVER_TAB = null

/**
 * The pinned Favorites collection, at the strip's left end beside Discover.
 *
 * Defined with `TabSession` rather than here because it is a value the session
 * restores to, and re-exported from here because this is the module that says
 * what a stop is. It is a second fixture and nothing more: the same `TabStop`
 * union, the same absence from `openIds`, and — the part that matters — the same
 * inability to reach `close`, `beginRename` or `beginDrag`, all three of which
 * take a `number`. "My Favorites cannot be renamed, reordered or deleted" is
 * therefore a fact the type checker holds rather than three branches to write.
 */
export { FAVORITES_TAB }

/** A place the strip can be: a playlist, or one of the two fixtures. */
export type { TabStop }

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
  view(stop: TabStop): void
  rename(playlistId: number, name: string): Promise<void>
  /** Takes the tab off the strip. The playlist survives. */
  close(playlistId: number): void
  /** Moves a tab within the open set. Never touches `playlists.position`. */
  moveOpen(playlistId: number, toIndex: number): void
}

export interface PlaylistTabsDeps {
  /** The *open* playlists, in tab order. */
  tabs: MaybeRefOrGetter<readonly Playlist[]>
  viewedId: MaybeRefOrGetter<TabStop>
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

  /**
   * Every place the strip can be, left to right: the two fixtures, then the open
   * playlists. Navigation counts stops; `order` stays playlists-only because
   * that is what a reorder is an index into — which is also why a reorder drag
   * can never land against a fixture.
   *
   * My Favorites sits second rather than first because Discover is where a
   * session with nothing restored opens, and moving that would move the tab
   * every launch lands on.
   */
  const stops = computed<readonly TabStop[]>(() => [DISCOVER_TAB, FAVORITES_TAB, ...order.value])

  /** An index into `stops`, not into `tabs` — the fixture occupies zero. */
  const viewedIndex = computed(() => stops.value.indexOf(viewedId.value))

  function tab(playlistId: number): Playlist | null {
    return tabs.value.find((candidate) => candidate.id === playlistId) ?? null
  }

  const isViewed = (playlistId: number): boolean => playlistId === viewedId.value
  const isPlaying = (playlistId: number): boolean => playlistId === playingId.value

  /**
   * The fixtures' half of `isViewed`.
   *
   * There is no playing counterpart for either. Discover plays nothing, and
   * My Favorites is not a playlist — §5 rule 3 is about playing *from a
   * playlist*, so `playingPlaylistId` clears when favorites start, exactly as it
   * does for the library order.
   */
  const discoverViewed = computed(() => viewedId.value === DISCOVER_TAB)
  const favoritesViewed = computed(() => viewedId.value === FAVORITES_TAB)

  const rename = createPlaylistRename({ find: tab, commit: commands.rename })

  // -- selection ------------------------------------------------------------

  function select(stop: TabStop): void {
    if (stop === viewedId.value) return
    rename.cancel()
    commands.view(stop)
  }

  /**
   * Clamped, not wrapped: a tab bar has ends, and arrowing off one is a mistake,
   * not a cycle. `stops` is never empty, so there is always somewhere to clamp
   * to — arrowing left with no playlists open lands on Discover and stays.
   */
  function selectAt(index: number): boolean {
    const clamped = Math.max(0, Math.min(index, stops.value.length - 1))
    const target = stops.value[clamped]
    if (target === viewedId.value) return false
    select(target)
    return true
  }

  function selectRelative(delta: number): boolean {
    // An unknown viewed tab arrows in from the near end rather than from -1.
    const from =
      viewedIndex.value === -1 ? (delta < 0 ? stops.value.length : -1) : viewedIndex.value
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
   *
   * F2 and Delete on a fixture are `none` rather than special cases: both verbs
   * need a playlist id to have anything to do, and neither fixture is a number.
   * That one guard is also the whole of "My Favorites cannot be renamed or
   * closed from the keyboard".
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
        selectAt(stops.value.length - 1)
        return 'navigate'
      case 'F2':
        if (typeof viewedId.value !== 'number') return 'none'
        return rename.begin(viewedId.value) ? 'rename' : 'none'
      case 'Delete':
        if (typeof viewedId.value !== 'number') return 'none'
        close(viewedId.value)
        return 'close'
      default:
        return 'none'
    }
  }

  return {
    tabs,
    stops,
    viewedId,
    playingId,
    viewedIndex,
    isViewed,
    isPlaying,
    discoverViewed,
    favoritesViewed,
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
