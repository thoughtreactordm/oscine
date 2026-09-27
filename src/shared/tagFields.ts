import type { OverrideFieldState } from './overrides'

/**
 * The generic tag-field registry — **W16-15**, design authority
 * `oscine-tag-writeback` → "The full tag surface", Decisions D–G.
 *
 * Decision E splits the editable surface in two. The *grouped* fields — title,
 * artist, album artist, album, track, disc, year, genre — re-key the browse and
 * keep their bespoke path through `track_overrides` and {@link OverridePatch}.
 * Everything else is *generic*: none of it affects browse, so one declarative
 * entry per field drives the editor, IPC validation, the diff, the writer and
 * verify, the way the W8 settings registry drives the settings surface. This
 * registry never describes a grouped field, so it can never route one's write.
 *
 * `src/shared` because main (store, validation, writer), preload and renderer
 * (editor) all read it. Pure data: no `@renderer`, no Node, no taglib import —
 * `taglib` is the property *name* on node-taglib-sharp's portable `Tag`, and the
 * registry-integrity test proves every one exists.
 *
 * {@link TagFieldKey} values are stored verbatim as `track_tag_overrides.field`,
 * so a key is a persisted identifier: never rename one, add a new entry instead.
 *
 * @see OverridePatch for the grouped tier.
 */

/** The editor's sections for the generic surface, in display order. */
export type TagFieldGroup =
  'credits' | 'numbering' | 'release' | 'content' | 'sorting' | 'advanced' | 'readOnly'

export const TAG_FIELD_GROUPS: readonly TagFieldGroup[] = [
  'credits',
  'numbering',
  'release',
  'content',
  'sorting',
  'advanced',
  'readOnly'
]

export const TAG_FIELD_GROUP_LABELS: Readonly<Record<TagFieldGroup, string>> = {
  credits: 'Credits',
  numbering: 'Numbering',
  release: 'Release',
  content: 'Content',
  sorting: 'Sorting',
  advanced: 'Advanced',
  readOnly: 'Read-only'
}

/**
 * How a field's value is shaped. `list` is a native multi-value frame edited as
 * a list (Decision G). `real` exists only for the read-only ReplayGain values —
 * gain in dB and linear peak are fractional, and no editable field is.
 */
export type TagFieldKind = 'text' | 'int' | 'bool' | 'list' | 'real'

/** A set value per kind. `null` is never a value — it is the *clear* intent. */
export type TagFieldValue = string | number | boolean | readonly string[]

interface TagFieldBase {
  readonly key: string
  readonly label: string
  readonly group: TagFieldGroup
  /** The node-taglib-sharp `Tag` property this field reads and writes through. */
  readonly taglib: string
  /** Shown, never edited or written (Decision F — ReplayGain). */
  readonly readOnly: boolean
  /**
   * Whether the field is offered at all (Decision D): `true` only while the
   * field's W16-16 corpus row round-trips green on all five codecs. A field that
   * is not admitted is refused by IPC and hidden by the editor.
   */
  readonly admitted: boolean
}

export interface TextTagField extends TagFieldBase {
  readonly kind: 'text'
  /** Longest accepted value; free-text frames (lyrics, comment) run long. */
  readonly maxLength: number
}

export interface IntTagField extends TagFieldBase {
  readonly kind: 'int'
  readonly min: number
  readonly max: number
}

export interface BoolTagField extends TagFieldBase {
  readonly kind: 'bool'
}

export interface ListTagField extends TagFieldBase {
  readonly kind: 'list'
}

export interface RealTagField extends TagFieldBase {
  readonly kind: 'real'
}

export type TagFieldDef = TextTagField | IntTagField | BoolTagField | ListTagField | RealTagField

/** The cap for an ordinary text frame — the same one the grouped fields use. */
export const TAG_TEXT_MAX_LENGTH = 1000
/** The cap for long free-text frames: lyrics, comment, description. */
export const TAG_LONG_TEXT_MAX_LENGTH = 65_536
/** The most entries a list field may carry, and the cap on each entry. */
export const TAG_LIST_MAX_ENTRIES = 100
export const TAG_LIST_ENTRY_MAX_LENGTH = TAG_TEXT_MAX_LENGTH

/** Each helper keeps `key` literal, so {@link TagFieldKey} is a union, not `string`. */
type Keyed<T, K extends string> = T & { readonly key: K }

function text<K extends string>(
  key: K,
  label: string,
  group: TagFieldGroup,
  taglib: string,
  maxLength = TAG_TEXT_MAX_LENGTH
): Keyed<TextTagField, K> {
  return { key, label, group, taglib, kind: 'text', maxLength, readOnly: false, admitted: true }
}

function int<K extends string>(
  key: K,
  label: string,
  group: TagFieldGroup,
  taglib: string,
  max: number
): Keyed<IntTagField, K> {
  return { key, label, group, taglib, kind: 'int', min: 1, max, readOnly: false, admitted: true }
}

function list<K extends string>(
  key: K,
  label: string,
  group: TagFieldGroup,
  taglib: string
): Keyed<ListTagField, K> {
  return { key, label, group, taglib, kind: 'list', readOnly: false, admitted: true }
}

function bool<K extends string>(
  key: K,
  label: string,
  group: TagFieldGroup,
  taglib: string
): Keyed<BoolTagField, K> {
  return { key, label, group, taglib, kind: 'bool', readOnly: false, admitted: true }
}

function replayGain<K extends string>(
  key: K,
  label: string,
  taglib: string
): Keyed<RealTagField, K> {
  return { key, label, group: 'readOnly', taglib, kind: 'real', readOnly: true, admitted: true }
}

/**
 * Holds a field out of the editor and IPC because one of its W16-16 corpus cells
 * is red (Decision D). Each use names the triage card that owns the red cell;
 * lift the hold only once that card's fix turns the whole row green.
 */
function held<F extends TagFieldDef>(field: F): F {
  return { ...field, admitted: false }
}

/**
 * Every generic field, in editor order within its group — the design's registry
 * table. Excluded outright (Decision F): `amazonId`, `musicIpId`, `dateTagged`,
 * `performersRole`, the derived `first*` / `joined*` accessors, and `pictures`
 * (the artwork path, Decisions A–C).
 *
 * Admission follows W16-16's corpus gate (`npm run probe:writeback-corpus`), per
 * field: every entry is admitted unless wrapped in {@link held}.
 */
export const TAG_FIELDS = [
  // Credits
  list('composers', 'Composers', 'credits', 'composers'),
  text('conductor', 'Conductor', 'credits', 'conductor'),
  text('remixedBy', 'Remixed by', 'credits', 'remixedBy'),
  // Numbering
  int('trackTotal', 'Track total', 'numbering', 'trackCount', 9999),
  int('discTotal', 'Disc total', 'numbering', 'discCount', 999),
  // Release
  text('subtitle', 'Subtitle', 'release', 'subtitle'),
  text('grouping', 'Grouping', 'release', 'grouping'),
  text('publisher', 'Publisher', 'release', 'publisher'),
  text('copyright', 'Copyright', 'release', 'copyright'),
  text('isrc', 'ISRC', 'release', 'isrc'),
  bool('compilation', 'Compilation', 'release', 'isCompilation'),
  // Content
  text('comment', 'Comment', 'content', 'comment', TAG_LONG_TEXT_MAX_LENGTH),
  text('description', 'Description', 'content', 'description', TAG_LONG_TEXT_MAX_LENGTH),
  text('lyrics', 'Lyrics', 'content', 'lyrics', TAG_LONG_TEXT_MAX_LENGTH),
  int('bpm', 'BPM', 'content', 'beatsPerMinute', 999),
  text('initialKey', 'Initial key', 'content', 'initialKey'),
  // Sorting
  text('titleSort', 'Title sort', 'sorting', 'titleSort'),
  list('artistSort', 'Artist sort', 'sorting', 'performersSort'),
  list('albumArtistSort', 'Album artist sort', 'sorting', 'albumArtistsSort'),
  text('albumSort', 'Album sort', 'sorting', 'albumSort'),
  list('composerSort', 'Composer sort', 'sorting', 'composersSort'),
  // Advanced — editable, not hidden (Decision F): a mismatched release is fixed here.
  // W16-20: the Apple setters for both artist ids throw on clear.
  held(text('musicBrainzArtistId', 'MusicBrainz artist id', 'advanced', 'musicBrainzArtistId')),
  held(
    text(
      'musicBrainzReleaseArtistId',
      'MusicBrainz release artist id',
      'advanced',
      'musicBrainzReleaseArtistId'
    )
  ),
  text('musicBrainzReleaseId', 'MusicBrainz release id', 'advanced', 'musicBrainzReleaseId'),
  text(
    'musicBrainzReleaseGroupId',
    'MusicBrainz release group id',
    'advanced',
    'musicBrainzReleaseGroupId'
  ),
  text('musicBrainzTrackId', 'MusicBrainz track id', 'advanced', 'musicBrainzTrackId'),
  text('musicBrainzDiscId', 'MusicBrainz disc id', 'advanced', 'musicBrainzDiscId'),
  text('releaseStatus', 'Release status', 'advanced', 'musicBrainzReleaseStatus'),
  text('releaseType', 'Release type', 'advanced', 'musicBrainzReleaseType'),
  text('releaseCountry', 'Release country', 'advanced', 'musicBrainzReleaseCountry'),
  // Read-only — the app computes and writes ReplayGain through its own path.
  replayGain('replayGainTrackGain', 'Track gain', 'replayGainTrackGain'),
  replayGain('replayGainTrackPeak', 'Track peak', 'replayGainTrackPeak'),
  replayGain('replayGainAlbumGain', 'Album gain', 'replayGainAlbumGain'),
  replayGain('replayGainAlbumPeak', 'Album peak', 'replayGainAlbumPeak')
] as const satisfies readonly TagFieldDef[]

/** A generic field's registry key — also its persisted `field` column value. */
export type TagFieldKey = (typeof TAG_FIELDS)[number]['key']

const BY_KEY: ReadonlyMap<string, TagFieldDef> = new Map(
  TAG_FIELDS.map((field): [string, TagFieldDef] => [field.key, field])
)

/** The registry entry for a key, or `undefined` for a key it does not know. */
export function tagField(key: string): TagFieldDef | undefined {
  return BY_KEY.get(key)
}

/** Whether a key names a registry field — known, admitted or not. */
export function isTagFieldKey(key: string): key is TagFieldKey {
  return BY_KEY.has(key)
}

/**
 * Whether a field may be edited: admitted by its corpus check and not
 * read-only. The IPC validator and the editor both ask this one question.
 */
export function isEditableTagField(field: TagFieldDef): boolean {
  return field.admitted && !field.readOnly
}

/** Equality by value — lists compare element-wise, in order. */
export function tagValuesEqual(a: TagFieldValue | null, b: TagFieldValue | null): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index])
  }
  return a === b
}

/**
 * A generic edit's changes, keyed by field. A value sets the field; `null`
 * clears the frame on flush. A key absent from the patch is left as it was.
 * Reverting to the file's own value is the separate `revert` path.
 */
export type TagFieldPatch = Readonly<Partial<Record<TagFieldKey, TagFieldValue | null>>>

/**
 * The most tracks one generic prefill may read — **W16-17**. Unlike the grouped
 * prefill, which folds materialised rows, the generic one opens every file
 * through taglib (nothing generic is indexed), so the batch is bounded. The
 * editor asks only when its "All fields" section opens, so a plain title edit
 * never pays for it.
 */
export const MAX_TAG_FIELD_PREFILL_TRACKS = 1000

/** The fields a prefill reads: every admitted one, the read-only ReplayGain included. */
export function prefillTagFieldKeys(): TagFieldKey[] {
  return TAG_FIELDS.filter((field) => field.admitted).map((field) => field.key as TagFieldKey)
}

/**
 * The generic half of the editor's prefill: each requested field folded across
 * the batch to a shared value or `mixed`, exactly as the grouped fields are.
 * A `null` value with `mixed` unset means every track agrees the field is empty.
 */
export type TagFieldEditState = Readonly<
  Partial<Record<TagFieldKey, OverrideFieldState<TagFieldValue>>>
>
