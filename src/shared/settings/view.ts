/**
 * Workspace state: the view-scoped keys nobody sets from the settings view.
 *
 * Every key here is `internal` — it has a default, a shape and a validator,
 * and it is edited by dragging a column edge or closing a tab rather than by a
 * control on a settings row. They live in the registry anyway because the thing
 * W8-3 deleted was five private answers to "what may a stored blob contain",
 * and the registry is where that question gets one answer.
 *
 * The validators here check *shape* and nothing that depends on a catalogue the
 * renderer owns. A stored column key this build has never heard of is a string,
 * and whether it names a real column is a question only `panels/columnLayout`
 * can answer; a stored pane size is a positive integer, and whether it fits the
 * container is a question only the resizer can answer, at the moment of use.
 * That split is the one `clampPaneSize` already made — validate what the value
 * *is* on the way out of storage, reconcile what it *means* at the point of use.
 */

import type { LibraryBrowseFilters, SortDirection, TrackSortColumn } from '../library'
import {
  acceptValue,
  booleanValue,
  defineSetting,
  recordValue,
  rejectValue,
  stringValue,
  type SettingDescriptor,
  type SettingValidator
} from './kernel'

// --- shapes ------------------------------------------------------------------

/**
 * The pinned Favorites collection, as a place Curate can be — **D18**.
 *
 * A string beside the row ids because it is not one. `track_favorites` has no
 * `playlists` row to name, which is the whole of D18, and the alternative — a
 * reserved negative id — would be a number that looks like it could be looked up
 * and cannot. It is not in `openIds` either: it is pinned rather than open, the
 * way Discover is, so nothing can close it and nothing has to remember not to.
 */
export const FAVORITES_TAB = 'favorites'

/**
 * A non-numeric stop. One today; the type is what a second one would be added
 * to, and D18's revisit trigger is exactly that second one appearing.
 */
export type TabFixture = typeof FAVORITES_TAB

/**
 * Where Curate (or a tab strip) can be: a row id, a pinned fixture, or `null`.
 *
 * `null` is Discover in both surfaces that have one. Representing the fixtures
 * as values rather than as synthetic rows is what keeps them un-closeable and
 * un-renameable by *type* — every verb that could damage one takes a `number`.
 */
export type TabStop = number | TabFixture | null

/** Which entities are open as tabs, and which of them is on screen. */
export interface TabSession {
  /** Recorded playlist ids, so a restart can restore a viewed playlist. */
  openIds: number[]
  /** One of `openIds`, a pinned fixture, or null (Discover). */
  viewedId: TabStop
}

/**
 * A stored column layout, before it meets the column catalogue.
 *
 * Keys are plain strings rather than `TrackColumnKey`: the catalogue is
 * renderer presentation data — labels, pixel widths — and has no business in a
 * cross-process contract. `normalizeColumnLayout` is what turns these into
 * columns, and it is the only place that can, because it is the only place that
 * knows which columns exist.
 */
export interface StoredColumnLayout {
  order: string[]
  hidden: string[]
  widths: Record<string, number>
}

/**
 * What was playing, as the intent that produced it rather than the rows it
 * produced.
 *
 * One variant per play entry point on the controller — a library sort, a
 * playlist, My Favorites, a fixed list of episodes — because that is what
 * regenerates the queue on the far side. Storing the 5000-row session tier would
 * be storing a derivation; storing the intent lets the controller's own
 * `fillSession` rebuild it from the same three facts it was built from the first
 * time. The `list` variant carries the sort, direction and folder/search filters
 * verbatim so the restored order is the one the operator was actually traversing.
 */
export type QueueIntent =
  | {
      kind: 'list'
      sort: TrackSortColumn
      direction: SortDirection
      filters?: LibraryBrowseFilters
    }
  | { kind: 'playlist'; playlistId: number }
  | { kind: 'favorites' }
  | { kind: 'tracks'; trackIds: number[] }

/**
 * The last queue, enough of it to reload paused where the operator left off.
 *
 * `baseIndex` is against the *base* (un-shuffled) order, so a session saved
 * under shuffle restores the same current track pinned to the top and reshuffles
 * the rest — the shuffle sequence is not itself persisted, which matches how the
 * controller already treats it. `trackId` is both what to show before the first
 * play and how to tell that the current track has since left the library, in
 * which case the whole session is dropped rather than resumed onto the wrong row.
 *
 * `intent: null` is the empty session — nothing was playing, or the gate is
 * shut — and is the default. Written whenever playback stops, so a shut-down on
 * an idle transport does not resurrect a queue on next launch.
 */
export interface QueueSession {
  intent: QueueIntent | null
  /** Index into the base order of the track that was current. */
  baseIndex: number
  /** Id of the track that was current, or null for the empty session. */
  trackId: number | null
  /** Milliseconds into the current track. */
  elapsedMs: number
}

export const QUEUE_SESSION_KEY = 'view.queueSession'

/** The empty session, shared by the default and every repair path. */
export const EMPTY_QUEUE_SESSION: QueueSession = {
  intent: null,
  baseIndex: 0,
  trackId: null,
  elapsedMs: 0
}

// --- validators --------------------------------------------------------------

function isRowId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((entry) => typeof entry === 'string'))] : []
}

/**
 * One pane's size in CSS pixels: positive, and whole.
 *
 * Rounds rather than rejecting a fraction, which `integerValue` would do. The
 * resizer already rounds everything it writes — a stored 320.4 that measures
 * 320 is a pane that shifts every time it is dragged — so a fractional value
 * here came from an older build or a hand edit, and losing the pane's size over
 * it would be a worse answer than the pixel it was going to be rounded to
 * anyway.
 */
function paneSizeValue(): SettingValidator<number> {
  return (raw) =>
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? acceptValue(Math.round(raw))
      : rejectValue('expected a positive number of pixels')
}

/**
 * A tab set, keeping nothing it cannot vouch for.
 *
 * Repairs rather than rejects, field by field, because this is storage an
 * operator can hand-edit and a stale `viewedId` should cost one tab rather than
 * the whole strip. Duplicates collapse — they would render one playlist as two
 * tabs that select each other.
 *
 * `viewFirstWhenMissing` is the difference between the two call sites. Curate
 * falls back to the first recorded id when a viewed playlist is not among them;
 * Podcasts falls back to Discover at null. Discover itself (`null`) is restored
 * on both, the way a named fixture is — it is pinned, not missing.
 *
 * `fixtures` are the pinned stops that surface has. They are checked against the
 * list rather than accepted as any string, so a session restored into a build
 * whose rail has since lost a fixture lands on a real stop instead of holding a
 * name nothing renders — and so a Curate session cannot restore Podcasts into a
 * favorites view it does not have.
 */
function tabSessionValue({
  viewFirstWhenMissing,
  fixtures = []
}: {
  viewFirstWhenMissing: boolean
  fixtures?: readonly TabFixture[]
}): SettingValidator<TabSession> {
  return (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return rejectValue('expected a tab session object')
    }
    const source = raw as Partial<Record<keyof TabSession, unknown>>
    const openIds = Array.isArray(source.openIds)
      ? [...new Set(source.openIds.filter(isRowId))]
      : []

    // Discover is `null`, and like a named fixture it is pinned rather than
    // recorded — so it is restored even when `openIds` still names playlists.
    // Tested before `viewFirstWhenMissing`, which would otherwise eat it.
    if (source.viewedId === null) {
      return acceptValue({ openIds, viewedId: null })
    }

    if (fixtures.includes(source.viewedId as TabFixture)) {
      return acceptValue({ openIds, viewedId: source.viewedId as TabFixture })
    }

    const viewedId =
      isRowId(source.viewedId) && openIds.includes(source.viewedId)
        ? source.viewedId
        : viewFirstWhenMissing
          ? (openIds[0] ?? null)
          : null
    return acceptValue({ openIds, viewedId })
  }
}

/**
 * A column layout's shape, or null for "never configured".
 *
 * Null rather than an empty layout because an empty `hidden` is a real state —
 * the operator showed every column — and it must not be confused with a fresh
 * profile, whose hidden set is the eight columns W4-1 shipped hidden.
 */
function columnLayoutValue(): SettingValidator<StoredColumnLayout | null> {
  return (raw) => {
    if (raw === null || raw === undefined) return acceptValue(null)
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return rejectValue('expected a column layout object')
    }
    const source = raw as Partial<Record<keyof StoredColumnLayout, unknown>>
    const widths: Record<string, number> = {}
    if (source.widths !== null && typeof source.widths === 'object') {
      for (const [key, width] of Object.entries(source.widths as Record<string, unknown>)) {
        if (typeof width === 'number' && Number.isFinite(width)) widths[key] = Math.round(width)
      }
    }
    return acceptValue({
      order: stringList(source.order),
      hidden: stringList(source.hidden),
      widths
    })
  }
}

/**
 * A play intent, or null for anything this build cannot vouch for.
 *
 * Shape only, per the note at the top of this file: whether `'title'` still
 * names a sort or `42` still names a playlist is a question for the point of
 * use, and the controller answers it by simply failing to resolve a row — a
 * restored order that materializes nothing is an empty queue, not a crash. What
 * this rejects is a blob that could not have come from any variant, so a
 * hand-edited or cross-branch value degrades to "no queue" rather than to a
 * half-built one.
 */
function sanitizeIntent(raw: unknown): QueueIntent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  switch (source.kind) {
    case 'list':
      if (typeof source.sort !== 'string' || typeof source.direction !== 'string') return null
      return {
        kind: 'list',
        sort: source.sort as TrackSortColumn,
        direction: source.direction as SortDirection,
        ...(source.filters !== null &&
        typeof source.filters === 'object' &&
        !Array.isArray(source.filters)
          ? { filters: source.filters as LibraryBrowseFilters }
          : {})
      }
    case 'playlist':
      return isRowId(source.playlistId) ? { kind: 'playlist', playlistId: source.playlistId } : null
    case 'favorites':
      return { kind: 'favorites' }
    case 'tracks': {
      const trackIds = Array.isArray(source.trackIds) ? source.trackIds.filter(isRowId) : []
      return trackIds.length > 0 ? { kind: 'tracks', trackIds } : null
    }
    default:
      return null
  }
}

/**
 * A queue session, repaired field by field to the empty session.
 *
 * Never rejects: an unreadable blob is a launch with no queue to restore, which
 * is exactly the default, so there is nothing a rejection would buy over the
 * repair. An intent that does not sanitize takes `trackId` and `elapsedMs` down
 * with it — a position into an order that is not being restored is meaningless.
 */
function queueSessionValue(): SettingValidator<QueueSession> {
  return (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return acceptValue({ ...EMPTY_QUEUE_SESSION })
    }
    const source = raw as Partial<Record<keyof QueueSession, unknown>>
    const intent = sanitizeIntent(source.intent)
    if (!intent) {
      return acceptValue({ ...EMPTY_QUEUE_SESSION })
    }
    const baseIndex =
      typeof source.baseIndex === 'number' &&
      Number.isInteger(source.baseIndex) &&
      source.baseIndex >= 0
        ? source.baseIndex
        : 0
    const trackId = isRowId(source.trackId) ? source.trackId : null
    const elapsedMs =
      typeof source.elapsedMs === 'number' &&
      Number.isFinite(source.elapsedMs) &&
      source.elapsedMs > 0
        ? Math.round(source.elapsedMs)
        : 0
    // An intent with no current track is a position with nothing to anchor it;
    // drop to empty rather than restore a queue with no head.
    if (trackId === null) {
      return acceptValue({ ...EMPTY_QUEUE_SESSION })
    }
    return acceptValue({ intent, baseIndex, trackId, elapsedMs })
  }
}

// --- descriptors -------------------------------------------------------------

export const VIEW_SETTINGS: readonly SettingDescriptor[] = [
  /**
   * Pane sizes in CSS pixels, keyed by `PaneSpec.key`.
   *
   * One record rather than a key per pane, which is what this file first tried.
   * A pane's default size, minimum and neighbour reserve are already stated once
   * in its `PaneSpec`, and a scalar descriptor per pane would restate the
   * default and the bounds in a second place that can — and briefly did —
   * disagree with the first. A record also keeps a pane this build has never
   * heard of, which matters the moment docking lands and pane identity stops
   * being fixed.
   */
  defineSetting<Record<string, number>>({
    key: 'view.shellPaneSizes',
    scope: 'view',
    default: {},
    // Not clamped here: the bounds depend on a container that is not measured
    // at the moment a layout is read. `clampPaneSize` clamps at the point of
    // use, where the measurement exists.
    validate: recordValue(paneSizeValue()),
    category: 'interface',
    label: 'Pane sizes',
    help: 'Widths and heights the frame has been dragged to on this machine.',
    internal: true
  }),

  /**
   * Whether the Tunedeck is showing.
   *
   * Persisted, unlike the sidebar's cover pane, which starts closed every
   * session. The distinction is the one `stores/shell.ts` already draws: an
   * expanded cover is a glance, and the deck is a layout the operator built —
   * it displaces the body, so finding it closed after a restart would be the
   * frame quietly undoing a decision.
   *
   * Its width is not here. That is one entry in `view.shellPaneSizes`, keyed
   * `tunedeck.deck`, because a pane's size is a pane's size wherever the pane
   * happens to be hosted.
   */
  defineSetting<boolean>({
    key: 'view.tunedeckOpen',
    scope: 'view',
    default: false,
    validate: booleanValue(),
    category: 'interface',
    label: 'Tunedeck open',
    help: 'Whether the Tunedeck is showing beside the library on this machine.',
    internal: true
  }),

  /**
   * Which Tunedeck tab is showing, and which groups are collapsed.
   *
   * Two keys rather than one object, because they change on different gestures
   * and the write debounce coalesces per key: clicking through four tabs should
   * not keep rewriting a record of collapsed groups that did not move.
   *
   * Both validate *shape* and not membership, per the note at the top of this
   * file. Whether `'artist'` names a tab this build still has is a question only
   * the deck's registry can answer, and it answers it at the point of use —
   * `resolveTabId` falls forward to the first tab rather than stranding the
   * operator on a blank panel, and an entry naming a retired group is simply a
   * key nothing asks about. A validator that rejected unknown ids here would
   * instead discard the setting of anyone switching between branches that name
   * their groups differently, which is exactly what the per-key storage above
   * exists to prevent.
   *
   * The tab default is empty and resolved on read for the same reason the pane
   * sizes are: naming a default tab here would restate `panes.ts`'s ordering in
   * a second place that can disagree with it.
   */
  defineSetting<string>({
    key: 'view.tunedeckTab',
    scope: 'view',
    default: '',
    validate: stringValue({ maxLength: 64, allowEmpty: true }),
    category: 'interface',
    label: 'Tunedeck tab',
    help: 'Which Tunedeck tab was last showing on this machine.',
    internal: true
  }),

  /**
   * Which Tunedeck groups have been collapsed, keyed by group id.
   *
   * An *override* record and not a state record: absent means open, because the
   * deck reveals every group in a tab by default. That is what makes a group
   * added in a later build arrive open rather than silently shut for everyone
   * who has ever touched a chevron — the alternative shape, a list of the groups
   * that are open, would have to name a group that did not exist when it was
   * written.
   *
   * Keyed by group and not by tab because the registry already forbids two
   * groups sharing an id across the whole deck. It was keyed by tab when a tab
   * had exactly one open group and the question was *which*; the question is now
   * per group and has nothing to do with which tab is showing.
   *
   * Values written by the one-open-group build are `{ [tabId]: groupId }` —
   * strings, which `booleanValue` drops entry by entry, leaving `{}`. A deck
   * that opens with everything revealed is exactly where a first-run deck opens,
   * so the shape change needs no version bump to land somewhere sensible.
   */
  defineSetting<Record<string, boolean>>({
    key: 'view.tunedeckGroups',
    scope: 'view',
    default: {},
    validate: recordValue(booleanValue()),
    category: 'interface',
    label: 'Tunedeck groups',
    help: 'Which Tunedeck groups are collapsed on this machine.',
    internal: true
  }),

  defineSetting<StoredColumnLayout | null>({
    key: 'view.trackColumns',
    scope: 'view',
    default: null,
    validate: columnLayoutValue(),
    category: 'interface',
    label: 'Track list columns',
    help: 'Which columns the track list shows, in what order, at what width.',
    internal: true
  }),

  defineSetting<TabSession>({
    key: 'view.playlistTabs',
    scope: 'view',
    default: { openIds: [], viewedId: null },
    validate: tabSessionValue({ viewFirstWhenMissing: true, fixtures: [FAVORITES_TAB] }),
    category: 'interface',
    label: 'Curate view',
    help: 'Which collection Curate was showing on this machine.',
    internal: true
  }),

  /**
   * The Listening dashboard's time range and which total ranks its lists.
   *
   * Two keys for the reason the deck's two are: they change on different
   * gestures, and the write debounce coalesces per key — flipping between plays
   * and time should not keep rewriting a range that did not move.
   *
   * Both are `''` by default and resolved on read, which is `view.tunedeckTab`'s
   * rule rather than a slip. Naming `'30d'` here would restate
   * `listeningRange.ts`'s preset table in a second place that can disagree with
   * it, and the preset list is the renderer's catalogue: main has no calendar to
   * resolve "this year" against, which is the whole of `StatsRange`.
   *
   * The sort is stored as a bare string for the same reason, even though
   * `StatsSort` is a shared union this file could import. Shape is what a
   * validator can settle; whether `'time'` still names a sort this build offers
   * is a question for the point of use, and a validator that answered it here
   * would discard the setting of anyone moving between branches.
   */
  defineSetting<string>({
    key: 'view.listeningRange',
    scope: 'view',
    default: '',
    validate: stringValue({ maxLength: 32, allowEmpty: true }),
    category: 'interface',
    label: 'Listening range',
    help: 'Which time range the Listening dashboard was last showing on this machine.',
    internal: true
  }),

  defineSetting<string>({
    key: 'view.listeningSort',
    scope: 'view',
    default: '',
    validate: stringValue({ maxLength: 32, allowEmpty: true }),
    category: 'interface',
    label: 'Listening ranking',
    help: 'Whether the Listening dashboard ranks by plays or by time on this machine.',
    internal: true
  }),

  defineSetting<TabSession>({
    key: 'view.podcastTabs',
    scope: 'view',
    default: { openIds: [], viewedId: null },
    // Falls back to null rather than the leftmost show: null is Discover, which
    // is a real tab here rather than an empty strip.
    validate: tabSessionValue({ viewFirstWhenMissing: false }),
    category: 'podcasts',
    label: 'Open show tabs',
    help: 'Which podcast shows are open as tabs, and which one is showing.',
    internal: true
  }),

  /**
   * The last queue, as an intent plus a position — G2's session-restore.
   *
   * Internal: it has no row, because the row that governs it is
   * `view.restoreQueue` over in `./interface.ts`. The gate reads *this* through
   * `restoredQueueSession`, and `usePlaybackStore` writes it whenever the
   * current track or its order changes and once more at quit, so the snapshot is
   * a track behind at worst even on a crash. `view`-scoped for the reason the
   * gate is: it is read while the playback store is being constructed.
   */
  defineSetting<QueueSession>({
    key: QUEUE_SESSION_KEY,
    scope: 'view',
    default: { ...EMPTY_QUEUE_SESSION },
    validate: queueSessionValue(),
    category: 'interface',
    label: 'Last play queue',
    help: 'The queue that was playing when Oscine last closed on this machine.',
    internal: true
  })
]
