/**
 * Interface and behaviour keys — W8-11's domain.
 *
 * This file first spent a key per pane — `shellSidebarWidthPx`,
 * `sourcesArtistsWidthPx` — on the argument that a record's per-pane fallbacks
 * would have to live back in the pane specs. W8-3 reversed that: the fallbacks
 * were *already* in the pane specs, alongside the minimum and the neighbour
 * reserve that only the resizer can enforce, so the scalar keys were a second
 * copy of a default rather than the only one. `view.shellPaneSizes` in
 * `./view.ts` is the record that replaced them.
 *
 * ## Which half of the split each key lands in
 *
 * The scopes here are not a coin toss, and two of them are load-bearing.
 *
 * `view.trackListDensity` is view-scoped because it is *geometry the shell
 * paints with*. The view half reads synchronously; the durable half arrives on a
 * promise. A row height that hydrated a frame late would draw the whole list at
 * one size and then re-lay it out at another, which is the flash the split
 * exists to avoid — and it is the same argument that already put the album
 * header's art size here.
 *
 * `view.restoreSession` is view-scoped because of *when* it is read.
 * `usePlaylistsStore` and `usePodcastsStore` decide whether to restore their tabs
 * while they are being constructed, and at that moment the durable half may not
 * have hydrated. A gate that answered "I do not know yet" would open on an empty
 * strip and fill it a tick later, which is worse than either honest answer. It
 * also keeps the gate in the same scope as the two sessions it gates.
 *
 * The rest are durable: how long a duration reads, what a double-click does and
 * which deletions stop to ask are facts about the operator rather than about the
 * machine, so W8-13's export bundle should carry them.
 */

import { booleanValue, defineSetting, enumValue, type SettingDescriptor } from './kernel'

export type ThemeMode = 'system' | 'light' | 'dark'
export type AlbumArtSize = 'small' | 'medium' | 'large'

/** Row height tier for the song list. The pixels live in the renderer. */
export type TrackDensity = 'compact' | 'default' | 'roomy'

/**
 * How long a duration is allowed to get.
 *
 * `minutes` is what the track list did before this card and is kept because a
 * library of three-minute songs reads better without a leading `0:`. It is not
 * the default, because it renders a 94-minute mix as `94:00`.
 */
export type DurationFormat = 'auto' | 'minutes' | 'hours'

export type DateFormat = 'short' | 'medium' | 'numeric' | 'iso'

/** Powers of 1024 with the units that go with them, or powers of 1000. */
export type FileSizeFormat = 'binary' | 'decimal'

/** What double-clicking a track — or pressing Enter on it — does. */
export type TrackActivation = 'play' | 'playNext' | 'queue' | 'addToViewedPlaylist'

export const TRACK_DENSITY_KEY = 'view.trackListDensity'
export const RESTORE_SESSION_KEY = 'view.restoreSession'
export const DURATION_FORMAT_KEY = 'interface.durationFormat'
export const DATE_FORMAT_KEY = 'interface.dateFormat'
export const FILE_SIZE_FORMAT_KEY = 'interface.fileSizeFormat'
export const TRACK_ACTIVATION_KEY = 'interface.trackActivation'
export const CONFIRM_PLAYLIST_DELETE_KEY = 'interface.confirmPlaylistDelete'
export const CONFIRM_ENTRY_REMOVAL_KEY = 'interface.confirmEntryRemoval'

export const INTERFACE_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<ThemeMode>({
    key: 'interface.theme',
    scope: 'durable',
    default: 'system',
    validate: enumValue<ThemeMode>(['system', 'light', 'dark']),
    control: {
      kind: 'select',
      options: [
        { value: 'system', label: 'Match system' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' }
      ]
    },
    category: 'interface',
    label: 'Theme',
    help: 'Follow the desktop setting, or pin one.',
    keywords: ['dark mode', 'light mode', 'appearance'],
    order: 10
  }),

  defineSetting<TrackActivation>({
    key: TRACK_ACTIVATION_KEY,
    scope: 'durable',
    default: 'play',
    validate: enumValue<TrackActivation>(['play', 'playNext', 'queue', 'addToViewedPlaylist']),
    control: {
      kind: 'select',
      options: [
        { value: 'play', label: 'Play it now' },
        { value: 'playNext', label: 'Play it next' },
        { value: 'queue', label: 'Add it to the queue' },
        { value: 'addToViewedPlaylist', label: 'Add it to the open playlist' }
      ]
    },
    category: 'interface',
    label: 'Double-clicking a song',
    help: 'Also what Enter does on the focused row. With no playlist open in Curate, adding to one plays instead.',
    keywords: ['double click', 'enter', 'activate', 'queue', 'play next'],
    order: 20
  }),

  defineSetting<TrackDensity>({
    key: TRACK_DENSITY_KEY,
    scope: 'view',
    default: 'default',
    validate: enumValue<TrackDensity>(['compact', 'default', 'roomy']),
    control: {
      kind: 'select',
      options: [
        { value: 'compact', label: 'Compact' },
        { value: 'default', label: 'Default' },
        { value: 'roomy', label: 'Roomy' }
      ]
    },
    category: 'interface',
    label: 'Song list density',
    help: 'Row height in the song list. Compact fits about a third more rows on a screen.',
    keywords: ['density', 'row height', 'compact', 'spacing', 'list'],
    order: 30
  }),

  defineSetting<boolean>({
    key: 'view.trackGroupingEnabled',
    scope: 'view',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Group tracks by album',
    help: 'Show an album header above each run of tracks in a track list.',
    keywords: ['group', 'album', 'header', 'list'],
    order: 40
  }),

  defineSetting<AlbumArtSize>({
    key: 'view.trackGroupingArtSize',
    scope: 'view',
    default: 'small',
    validate: enumValue<AlbumArtSize>(['small', 'medium', 'large']),
    control: {
      kind: 'select',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' }
      ]
    },
    category: 'interface',
    label: 'Album header artwork',
    help: 'How large the cover is in an album group header.',
    keywords: ['group', 'artwork', 'cover', 'size'],
    order: 50
  }),

  defineSetting<DurationFormat>({
    key: DURATION_FORMAT_KEY,
    scope: 'durable',
    default: 'auto',
    validate: enumValue<DurationFormat>(['auto', 'minutes', 'hours']),
    control: {
      kind: 'select',
      options: [
        { value: 'auto', label: 'Hours only when needed — 4:05, 1:04:05' },
        { value: 'minutes', label: 'Always minutes — 4:05, 64:05' },
        { value: 'hours', label: 'Always hours — 0:04:05, 1:04:05' }
      ]
    },
    category: 'interface',
    label: 'Duration format',
    help: 'How track and episode lengths are written.',
    keywords: ['duration', 'length', 'time', 'runtime', 'hours', 'minutes'],
    order: 60
  }),

  defineSetting<DateFormat>({
    key: DATE_FORMAT_KEY,
    scope: 'durable',
    default: 'medium',
    validate: enumValue<DateFormat>(['short', 'medium', 'numeric', 'iso']),
    control: {
      kind: 'select',
      options: [
        { value: 'short', label: 'Day and month — 3 Jun' },
        { value: 'medium', label: 'With the year — 3 Jun 2026' },
        { value: 'numeric', label: 'Numeric, in your locale' },
        { value: 'iso', label: 'ISO — 2026-06-03' }
      ]
    },
    category: 'interface',
    label: 'Date format',
    help: 'How dates are written. The first three follow your locale; ISO never does.',
    keywords: ['date', 'published', 'released', 'iso', 'locale'],
    order: 65
  }),

  /**
   * Binary by default, and the units say so.
   *
   * The track list divided by 1024 twice and labelled the result "MB", which is
   * a mebibyte wearing a megabyte's name. Both answers are defensible; printing
   * one and claiming the other is not, and it is the kind of thing the operator
   * this app is for notices.
   */
  defineSetting<FileSizeFormat>({
    key: FILE_SIZE_FORMAT_KEY,
    scope: 'durable',
    default: 'binary',
    validate: enumValue<FileSizeFormat>(['binary', 'decimal']),
    control: {
      kind: 'select',
      options: [
        { value: 'binary', label: 'Binary — MiB, GiB (÷1024)' },
        { value: 'decimal', label: 'Decimal — MB, GB (÷1000)' }
      ]
    },
    category: 'interface',
    label: 'File size format',
    help: 'Which kind of megabyte the size column means.',
    keywords: ['size', 'bytes', 'mib', 'megabyte', 'disk'],
    order: 70
  }),

  defineSetting<boolean>({
    key: RESTORE_SESSION_KEY,
    scope: 'view',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Reopen last session on launch',
    help: 'Reopen the playlist and podcast tabs that were open when Fermata last closed.',
    keywords: ['session', 'restore', 'tabs', 'startup', 'launch', 'reopen'],
    order: 80
  }),

  defineSetting<boolean>({
    key: CONFIRM_PLAYLIST_DELETE_KEY,
    scope: 'durable',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Confirm before deleting a playlist',
    help: 'Off: a playlist goes as soon as you ask, including one that is playing.',
    keywords: ['confirm', 'delete', 'playlist', 'prompt', 'are you sure'],
    order: 90
  }),

  defineSetting<boolean>({
    key: CONFIRM_ENTRY_REMOVAL_KEY,
    scope: 'durable',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Confirm before removing entries from a playlist',
    help: 'Removing entries never touches the files on disk either way.',
    keywords: ['confirm', 'remove', 'playlist', 'entries', 'prompt'],
    order: 100
  })
]
