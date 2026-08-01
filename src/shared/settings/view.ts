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

import {
  acceptValue,
  defineSetting,
  recordValue,
  rejectValue,
  type SettingDescriptor,
  type SettingValidator
} from './kernel'

// --- shapes ------------------------------------------------------------------

/** Which entities are open as tabs, and which of them is on screen. */
export interface TabSession {
  /** Open tabs, in tab order — not the order the rail lists them in. */
  openIds: number[]
  /** Always one of `openIds`, or null. */
  viewedId: number | null
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
 * has no null tab, so a viewed id that is not open falls back to the leftmost
 * one; Podcasts has Discover sitting at null, so there it falls back to that.
 */
function tabSessionValue({
  viewFirstWhenMissing
}: {
  viewFirstWhenMissing: boolean
}): SettingValidator<TabSession> {
  return (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return rejectValue('expected a tab session object')
    }
    const source = raw as Partial<Record<keyof TabSession, unknown>>
    const openIds = Array.isArray(source.openIds)
      ? [...new Set(source.openIds.filter(isRowId))]
      : []
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
    validate: tabSessionValue({ viewFirstWhenMissing: true }),
    category: 'interface',
    label: 'Open playlist tabs',
    help: 'Which playlists are open in Curate, and which one is showing.',
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
  })
]
