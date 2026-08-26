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
 * `view.restoreQueue` is view-scoped for the same reason and the same moment:
 * `usePlaybackStore` decides whether to rehydrate the last queue as it is
 * constructed, and its snapshot (`view.queueSession` in `./view.ts`) is the
 * matching workspace blob the gate reads. Off by default — remembering a queue
 * is a thing the operator opts into — and the write is gated too, so a shut gate
 * stores nothing rather than recording a queue nobody asked to keep.
 *
 * The rest are durable: how long a duration reads, what a double-click does and
 * which deletions stop to ask are facts about the operator rather than about the
 * machine, so W8-13's export bundle should carry them.
 */

import { booleanValue, defineSetting, enumValue, type SettingDescriptor } from './kernel'

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

/**
 * The same gesture on an artist or an album row in the Library sidebar.
 *
 * A separate key rather than a second reading of `TrackActivation`, because the
 * two rows are not the same size of thing. A double-clicked song is one song; a
 * double-clicked artist is however many hundred tracks they recorded, and an
 * operator who is happy for the first to start playing immediately is not
 * necessarily happy for the second to. `none` exists for exactly that operator —
 * it is what the facet panes did before this setting, where a double-click was
 * only ever a second click on a row that had already been selected.
 */
export type FacetActivation = TrackActivation | 'none'

export const TRACK_DENSITY_KEY = 'view.trackListDensity'
export const RESTORE_SESSION_KEY = 'view.restoreSession'
export const RESTORE_QUEUE_KEY = 'view.restoreQueue'
export const DURATION_FORMAT_KEY = 'interface.durationFormat'
export const DATE_FORMAT_KEY = 'interface.dateFormat'
export const FILE_SIZE_FORMAT_KEY = 'interface.fileSizeFormat'
export const TRACK_ACTIVATION_KEY = 'interface.trackActivation'
export const FACET_ACTIVATION_KEY = 'interface.facetActivation'
export const CONFIRM_PLAYLIST_DELETE_KEY = 'interface.confirmPlaylistDelete'
export const CONFIRM_ENTRY_REMOVAL_KEY = 'interface.confirmEntryRemoval'
export const NOW_PLAYING_WAVEFORM_KEY = 'interface.nowPlayingWaveform'

export const INTERFACE_SETTINGS: readonly SettingDescriptor[] = [
  /*
   * `interface.theme` used to be the first entry here. It is now `theme.mode`
   * in its own category — see `./theme.ts` and migration `008-theme-keys`. The
   * token editor made Theme a section rather than a row, and the one setting
   * most obviously about theming should not be the one outside it.
   */

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

  defineSetting<FacetActivation>({
    key: FACET_ACTIVATION_KEY,
    scope: 'durable',
    default: 'play',
    validate: enumValue<FacetActivation>([
      'play',
      'playNext',
      'queue',
      'addToViewedPlaylist',
      'none'
    ]),
    control: {
      kind: 'select',
      options: [
        { value: 'play', label: 'Play all of it now' },
        { value: 'playNext', label: 'Play all of it next' },
        { value: 'queue', label: 'Add all of it to the queue' },
        { value: 'addToViewedPlaylist', label: 'Add all of it to the open playlist' },
        { value: 'none', label: 'Nothing, just select the row' }
      ]
    },
    category: 'interface',
    label: 'Double-clicking an artist or album',
    help: 'In the Library sidebar, and also what Enter does on the focused row. "All of it" means that row under the current folder and search, in the song list’s sort. With shuffle on, it starts from a random track.',
    keywords: ['double click', 'enter', 'activate', 'artist', 'album', 'facet', 'sidebar'],
    order: 25
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
        { value: 'auto', label: 'Hours only when needed: 4:05, 1:04:05' },
        { value: 'minutes', label: 'Always minutes: 4:05, 64:05' },
        { value: 'hours', label: 'Always hours: 0:04:05, 1:04:05' }
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
        { value: 'short', label: 'Day and month: 3 Jun' },
        { value: 'medium', label: 'With the year: 3 Jun 2026' },
        { value: 'numeric', label: 'Numeric, in your locale' },
        { value: 'iso', label: 'ISO: 2026-06-03' }
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
        { value: 'binary', label: 'Binary: MiB, GiB (÷1024)' },
        { value: 'decimal', label: 'Decimal: MB, GB (÷1000)' }
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
    help: 'Reopen the playlist and podcast tabs that were open when Oscine last closed.',
    keywords: ['session', 'restore', 'tabs', 'startup', 'launch', 'reopen'],
    order: 80
  }),

  defineSetting<boolean>({
    key: RESTORE_QUEUE_KEY,
    scope: 'view',
    default: false,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Keep the play queue between sessions',
    help: 'Reload the queue you were playing when Oscine last closed, paused where you left off. Off by default; the queue is remembered only while this is on.',
    keywords: ['queue', 'session', 'restore', 'resume', 'playback', 'startup', 'launch'],
    order: 85
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
  }),

  defineSetting<boolean>({
    key: NOW_PLAYING_WAVEFORM_KEY,
    scope: 'durable',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Waveform ribbon on the Now Playing view',
    help: 'A live trace of the audible track, along the bottom of the view. Off costs nothing; on costs one animation frame while a track is sounding.',
    keywords: ['waveform', 'visualizer', 'visualisation', 'now playing', 'animation', 'ribbon'],
    order: 110
  })
]
