/**
 * The per-field write cases for the tag write-back gate — **W16-16**, design
 * authority `oscine-tag-writeback` → "The full tag surface", Decision D: a
 * generic field is admitted to the registry only once its round-trip is green
 * on all five codecs.
 *
 * One entry per `TAG_FIELDS` entry in `src/shared/tagFields.ts`. The probe runs
 * under plain Node and cannot import that TS module, so this is a mirror — and
 * `tests/tooling/writebackFieldCases.test.ts` fails the moment the two disagree
 * on a key, a taglib property, a kind or read-only-ness. The registry is the
 * authority; this table only adds the values to write.
 *
 * Values are chosen to catch encoding and shape bugs, not to look realistic:
 * non-ASCII text, embedded newlines in the long free-text frames, a `list`
 * whose second entry is not a copy of the first (so a collapse or a reorder
 * cannot pass), and ints away from the defaults taglib reports for "absent".
 */

/**
 * What a *clear* writes per kind, and what the writer (W16-17) must write too:
 * the gate proves these shapes remove the frame, nothing else.
 */
export const CLEAR_VALUE = Object.freeze({
  text: undefined,
  list: Object.freeze([]),
  int: 0,
  bool: false
})

function text(key, taglib, value) {
  return Object.freeze({ key, taglib, kind: 'text', readOnly: false, value })
}

function int(key, taglib, value) {
  return Object.freeze({ key, taglib, kind: 'int', readOnly: false, value })
}

function bool(key, taglib, value) {
  return Object.freeze({ key, taglib, kind: 'bool', readOnly: false, value })
}

/** `value` is the single-entry *set* case; `multi` is the ordered two-entry case. */
function list(key, taglib, value, multi) {
  return Object.freeze({
    key,
    taglib,
    kind: 'list',
    readOnly: false,
    value: Object.freeze(value),
    multi: Object.freeze(multi)
  })
}

/** Read-only (Decision F): seeded and read back, never set or cleared by an edit. */
function real(key, taglib, value) {
  return Object.freeze({ key, taglib, kind: 'real', readOnly: true, value })
}

export const FIELD_CASES = Object.freeze([
  list('composers', 'composers', ['Hildegard von Bingen'], ['Hildegard von Bingen', 'Arvo Pärt']),
  text('conductor', 'conductor', 'Nadia Boulanger'),
  text('remixedBy', 'remixedBy', 'Ødegaard ✓'),
  int('trackTotal', 'trackCount', 14),
  int('discTotal', 'discCount', 3),
  text('subtitle', 'subtitle', 'Live at the Aviary'),
  text('grouping', 'grouping', 'Dawn Chorus'),
  text('publisher', 'publisher', 'Oscine Records'),
  text('copyright', 'copyright', '℗ 2026 Oscine'),
  text('isrc', 'isrc', 'GBAYE2600001'),
  bool('compilation', 'isCompilation', true),
  text('comment', 'comment', 'Line one\nLine two — ünïcödé'),
  text('description', 'description', 'A synthesised corpus track.'),
  text('lyrics', 'lyrics', 'First verse, first line\nFirst verse, second line\n\nSecond verse'),
  int('bpm', 'beatsPerMinute', 128),
  text('initialKey', 'initialKey', 'F#m'),
  text('titleSort', 'titleSort', 'Round-Trip, Oscine'),
  list('artistSort', 'performersSort', ['Writeback, Oscine'], ['Writeback, Oscine', 'Pärt, Arvo']),
  list(
    'albumArtistSort',
    'albumArtistsSort',
    ['Artists, Various'],
    ['Artists, Various', 'Corpus, The']
  ),
  text('albumSort', 'albumSort', 'Tag-Writeback Corpus, W16'),
  list(
    'composerSort',
    'composersSort',
    ['Bingen, Hildegard von'],
    ['Bingen, Hildegard von', 'Pärt, Arvo']
  ),
  text('musicBrainzArtistId', 'musicBrainzArtistId', '0383dadf-2a4e-4d10-a46a-e9e041da8eb3'),
  text(
    'musicBrainzReleaseArtistId',
    'musicBrainzReleaseArtistId',
    '89ad4ac3-39f7-470e-963a-56509c546377'
  ),
  text('musicBrainzReleaseId', 'musicBrainzReleaseId', '5b11f4ce-a62d-471e-81fc-a69a8278c7da'),
  text(
    'musicBrainzReleaseGroupId',
    'musicBrainzReleaseGroupId',
    '1b022e01-4da6-387b-8658-8678046e4cef'
  ),
  text('musicBrainzTrackId', 'musicBrainzTrackId', 'd7f5d4e4-1f6e-4b4a-9c3a-2c1d5e7f8a90'),
  text('musicBrainzDiscId', 'musicBrainzDiscId', 'lwHl8fGzJyLXQR33ug60E8jhf4k-'),
  text('releaseStatus', 'musicBrainzReleaseStatus', 'official'),
  text('releaseType', 'musicBrainzReleaseType', 'album'),
  text('releaseCountry', 'musicBrainzReleaseCountry', 'GB'),
  real('replayGainTrackGain', 'replayGainTrackGain', -7.25),
  real('replayGainTrackPeak', 'replayGainTrackPeak', 0.988),
  real('replayGainAlbumGain', 'replayGainAlbumGain', -6.5),
  real('replayGainAlbumPeak', 'replayGainAlbumPeak', 0.995)
])

/** How close a read-back ReplayGain value must be: taglib formats to two places. */
export const REAL_TOLERANCE = 0.005
