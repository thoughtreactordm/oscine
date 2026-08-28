import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { parseFile } from 'music-metadata'
import taglib from 'node-taglib-sharp'

const {
  ByteVector,
  File,
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2UserTextInformationFrame,
  Picture,
  PictureType,
  TagTypes
} = taglib

/**
 * The tag write-back test corpus — W16-2, design authority D28.
 *
 * D7 names a mixed-format round-trip corpus as one of the two literal
 * preconditions for write-back: nothing in W16 flushes until a write → read →
 * verify cycle is green across every v1 codec, with embedded artwork and an
 * arbitrary frame proven to survive a tag edit rather than be dropped. This
 * module is that corpus, and the discipline is the one `probe:fixture` and the
 * M2 fixture already hold: the library is **synthesised, never scavenged**, so a
 * Linux run and a Windows run measure the same bytes. ffmpeg makes the audio, a
 * fixed embedded PNG makes the artwork platform-identical, and every tag value
 * is a constant in this file.
 *
 * It is also a **gate**, in the M1/M2 sense: `verifyRoundTrip` reports a flat
 * list of pass/fail checks and the probe that wraps it exits non-zero on any
 * failure. Anything it flags is a triage card, never a quiet fix folded into the
 * flush path — the whole point of a precondition is that it fails loudly before
 * the corruptible operation ships.
 *
 * ## What the round-trip proves
 *
 * The write engine's one irreducible risk (R6) is destroying an operator's file.
 * The corpus attacks it from three sides per codec:
 *   - **Fields round-trip.** Known-bad baseline tags are corrected by a write and
 *     read back — through node-taglib-sharp (the writer under evaluation) *and*
 *     through music-metadata (the reader the app actually ships).
 *   - **Unrelated frames survive.** A write that touches only the scalar fields
 *     must not drop the embedded cover or the arbitrary custom frame it never
 *     names. This is the frame-preservation guarantee, tested by seeding both and
 *     asserting they are byte-for-byte intact afterwards.
 *   - **Audio is untouched.** The decoded PCM is hashed before and after the
 *     write; a tag edit that rewrote a single audio byte changes the hash.
 *
 * node-taglib-sharp is the write engine's leading library candidate (W16-3); this
 * corpus is where it is confirmed to round-trip all five codecs before that card
 * adopts it. A codec it cannot round-trip is a finding here, not a surprise there.
 */

/** The v1 codec set and no more, each in the container the scanner accepts. */
export const CODECS = Object.freeze([
  { id: 'flac', file: '01-flac.flac', tagType: 'xiph', hz: 220, encode: ['-c:a', 'flac'] },
  {
    id: 'mp3',
    file: '02-mp3.mp3',
    tagType: 'id3v2',
    hz: 330,
    encode: ['-c:a', 'libmp3lame', '-b:a', '192k']
  },
  {
    id: 'vorbis',
    file: '03-vorbis.ogg',
    tagType: 'xiph',
    hz: 440,
    encode: ['-c:a', 'libvorbis', '-q:a', '5']
  },
  {
    id: 'opus',
    file: '04-opus.opus',
    tagType: 'xiph',
    hz: 550,
    encode: ['-c:a', 'libopus', '-b:a', '128k']
  },
  {
    id: 'aac',
    file: '05-aac.m4a',
    tagType: 'apple',
    hz: 660,
    encode: ['-c:a', 'aac', '-b:a', '192k']
  }
])

/** Bumped whenever the synthesised content changes, so a stale report is obvious. */
export const CORPUS_VERSION = 1

const SAMPLE_RATE = 44_100
const CLIP_SECONDS = 2

/**
 * The deliberately-wrong baseline every file is born with.
 *
 * These are the "known-bad tags" D7 asks for: the write step exists to replace
 * them, and the verify step asserts none of them survived. ffmpeg writes them as
 * plain container metadata at synthesis time.
 */
const BASELINE = Object.freeze({
  title: 'untitled',
  artist: 'Unknown Artist',
  album: '???',
  track: '0',
  date: '1900',
  genre: 'mis-tag'
})

/** The corrected values the round-trip writes and then demands back, verbatim. */
export const CORRECTED = Object.freeze({
  title: 'Oscine Round-Trip',
  artists: Object.freeze(['Oscine Writeback']),
  album: 'W16 Tag-Writeback Corpus',
  genres: Object.freeze(['Ambient', 'Electronic']),
  year: 2026,
  track: 4,
  trackCount: 12,
  disc: 1,
  discCount: 2
})

/**
 * Genres are written as ONE separator-joined value, not one frame per genre.
 *
 * The app reads a file's genres as `splitGenres(primaryGenre(common.genre))` (see
 * `src/main/library/metadata.ts`): it takes only the *first* genre element and
 * then splits that on `;`, `/` and `,`. Multiple native genre frames therefore
 * lose everything after the first on the next scan — proven here, where .m4a
 * genres also come back joined regardless. So the round-trip that actually
 * survives the app's pipeline is a single delimited string, and that is what the
 * flush engine (W16-3) must write. Testing the delimited form is the faithful
 * check; testing multiple frames would assert a shape the app cannot read back.
 */
export const GENRE_WRITTEN = CORRECTED.genres.join('; ')

/** The arbitrary frame that must survive a scalar write. Keyed per tag format. */
const CUSTOM = Object.freeze({
  /** Xiph field name / ID3v2 TXXX description / MP4 freeform atom name. */
  key: 'OSCINE_CUSTOM',
  /** MP4 freeform atom mean (reverse-DNS, iTunes convention). */
  mean: 'com.oscine',
  value: 'preserve-me-42'
})

/**
 * A 24×24 solid PNG, embedded as bytes so the artwork is identical on every
 * platform — an ffmpeg-generated cover would differ byte-for-byte across ffmpeg
 * builds and break the "survives unchanged" comparison. Generated once with
 * `ffmpeg -f lavfi -i color=c=0x2E5C8A:s=24x24 -frames:v 1`.
 */
const COVER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAACXBIWXMAAAABAAAAAQBPJcTWAAAALElEQVR4nGPUi+pkoAZgoYopDKMGEQNGA5swGA0jwmA0jAiD0TAiDAZfGAEAktMBb44rLt4AAAAASUVORK5CYII='
const COVER_BYTES = Buffer.from(COVER_PNG_BASE64, 'base64')
const COVER_MIME = 'image/png'

/** Runs a command to completion, capturing stderr for a useful error message. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}\n${stderr.trim()}`))
    )
  })
}

/**
 * The SHA-256 of a file's decoded PCM.
 *
 * Decoding rather than hashing the file: a tag edit legitimately changes the file
 * bytes (that is the point), but must not change one sample of audio. Two decodes
 * of the same audio stream are identical, so a matching hash across a write proves
 * the audio region was untouched — a stronger claim than byte-equality of the file.
 */
function pcmHash(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        path,
        '-map',
        '0:a',
        '-f',
        's16le',
        '-ac',
        '2',
        '-ar',
        String(SAMPLE_RATE),
        '-'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const hash = createHash('sha256')
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => hash.update(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(hash.digest('hex'))
        : reject(new Error(`ffmpeg decode exited ${code}\n${stderr.trim()}`))
    )
  })
}

/** Synthesises one codec's audio with the known-bad baseline tags. */
async function encode(codec, path) {
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${codec.hz}:duration=${CLIP_SECONDS}:sample_rate=${SAMPLE_RATE}`,
    '-ac',
    '2',
    '-map_metadata',
    '-1',
    ...codec.encode,
    '-metadata',
    `title=${BASELINE.title}`,
    '-metadata',
    `artist=${BASELINE.artist}`,
    '-metadata',
    `album=${BASELINE.album}`,
    '-metadata',
    `track=${BASELINE.track}`,
    '-metadata',
    `date=${BASELINE.date}`,
    '-metadata',
    `genre=${BASELINE.genre}`,
    path
  ])
}

/** The format-specific tag a custom frame lives in. */
function customTag(file, tagType) {
  if (tagType === 'xiph') return file.getTag(TagTypes.Xiph, true)
  if (tagType === 'id3v2') return file.getTag(TagTypes.Id3v2, true)
  return file.getTag(TagTypes.Apple, true)
}

/** Writes the arbitrary custom frame in the idiom each format provides. */
function writeCustomFrame(file, tagType) {
  const tag = customTag(file, tagType)
  if (tagType === 'xiph') {
    tag.setFieldAsStrings(CUSTOM.key, CUSTOM.value)
  } else if (tagType === 'id3v2') {
    const frame = Id3v2UserTextInformationFrame.fromDescription(CUSTOM.key)
    frame.text = [CUSTOM.value]
    tag.addFrame(frame)
  } else {
    tag.setItunesStrings(CUSTOM.mean, CUSTOM.key, CUSTOM.value)
  }
}

/** Reads the arbitrary custom frame back, or null when it is gone. */
function readCustomFrame(file, tagType) {
  const tag = customTag(file, tagType)
  if (tagType === 'xiph') {
    const values = tag.getField(CUSTOM.key)
    return values && values.length > 0 ? values[0] : null
  }
  if (tagType === 'id3v2') {
    const frames = tag.getFramesByIdentifier(
      Id3v2FrameClassType.UserTextInformationFrame,
      Id3v2FrameIdentifiers.TXXX
    )
    const match = Id3v2UserTextInformationFrame.findUserTextInformationFrame(frames, CUSTOM.key)
    return match ? (match.text[0] ?? null) : null
  }
  const values = tag.getItunesStrings(CUSTOM.mean, CUSTOM.key)
  return values && values.length > 0 ? values[0] : null
}

/**
 * Builds the corpus under `rootDir/library`, returning a manifest.
 *
 * Each file gets synthesised audio, the known-bad baseline, the embedded cover,
 * and the custom frame — the full "before" state a flush is later asked to
 * correct without breaking. Idempotent: the root is wiped first, so a rebuild is
 * byte-stable given the same ffmpeg.
 */
export async function buildWritebackCorpus(rootDir, log = () => {}) {
  await rm(rootDir, { recursive: true, force: true })
  const libraryDir = join(rootDir, 'library')
  await mkdir(libraryDir, { recursive: true })

  const tracks = []
  for (const codec of CODECS) {
    const path = join(libraryDir, codec.file)
    log(`synthesising ${codec.file}`)
    await encode(codec, path)

    const file = File.createFromPath(path)
    try {
      file.tag.pictures = [
        Picture.fromFullData(
          ByteVector.fromByteArray(COVER_BYTES),
          PictureType.FrontCover,
          COVER_MIME,
          'cover'
        )
      ]
      writeCustomFrame(file, codec.tagType)
      file.save()
    } finally {
      file.dispose()
    }
    tracks.push({ id: codec.id, tagType: codec.tagType, file: codec.file, path })
  }

  return {
    version: CORPUS_VERSION,
    libraryDir,
    cover: { bytes: COVER_BYTES, mimeType: COVER_MIME },
    tracks
  }
}

/** One verification outcome. `detail` explains a failure; empty on a pass. */
function check(checks, codec, name, passed, detail = '') {
  checks.push({ codec, name, passed, detail })
}

/** Whether two arrays of primitives are equal in order and value. */
function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/**
 * The genre set the app would derive from a raw genre value, mirroring
 * `splitGenres` in `@shared/genre`: split on `;`, `/`, `,`; trim and collapse
 * whitespace; dedupe by casefold, first spelling winning. Kept a local mirror
 * because these probe scripts run under plain Node and cannot import the TS
 * module — the canonical splitter is the one in the app, not this.
 */
function splitGenreValue(value) {
  const byKey = new Map()
  for (const part of value.split(/[;/,]/)) {
    const label = part.trim().replace(/\s+/g, ' ')
    if (label === '') continue
    const key = label.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, label)
  }
  return [...byKey.values()]
}

/**
 * The genre set the app recovers from a reader's `genre` array.
 *
 * `music-metadata` (the shipped reader) is consumed as `primaryGenre` — the first
 * element — then split, so a rescan sees exactly this. node-taglib-sharp's own
 * read-back is format-divergent (MP4 re-splits a delimited value into elements
 * while Xiph/ID3 keep it whole), so its values are joined before splitting to
 * recover the same set regardless of how the writer chose to store them.
 */
function recoverGenres(values, { firstOnly }) {
  const source = firstOnly
    ? (values.find((v) => typeof v === 'string' && v.trim() !== '') ?? '')
    : values.join('; ')
  return splitGenreValue(source)
}

/**
 * Runs the write → read → verify cycle over a built corpus.
 *
 * For each codec it hashes the audio, writes the corrected scalar fields (and
 * nothing else), hashes again, then re-reads through both node-taglib-sharp and
 * music-metadata and asserts the full set of properties. Returns a flat check
 * list the probe turns into a report and an exit code.
 */
export async function verifyRoundTrip(manifest, log = () => {}) {
  const checks = []

  for (const track of manifest.tracks) {
    const { id: codec, tagType, path } = track
    log(`round-tripping ${track.file}`)

    const pcmBefore = await pcmHash(path)

    // Sanity: the seeded "before" state the write must preserve.
    let seededPicture
    let seededCustom
    {
      const file = File.createFromPath(path)
      try {
        seededPicture =
          file.tag.pictures.length > 0 ? Buffer.from(file.tag.pictures[0].data.toByteArray()) : null
        seededCustom = readCustomFrame(file, tagType)
      } finally {
        file.dispose()
      }
    }
    check(
      checks,
      codec,
      'seed:artwork',
      seededPicture !== null,
      'no cover was embedded at synthesis'
    )
    check(
      checks,
      codec,
      'seed:custom-frame',
      seededCustom === CUSTOM.value,
      `custom frame seeded as ${JSON.stringify(seededCustom)}`
    )

    // The write: correct the scalar fields only. Pictures and the custom frame
    // are deliberately never named — surviving that omission is the R6 property.
    {
      const file = File.createFromPath(path)
      try {
        const tag = file.tag
        tag.title = `${CORRECTED.title} (${codec})`
        tag.performers = [...CORRECTED.artists]
        tag.album = CORRECTED.album
        tag.genres = [GENRE_WRITTEN]
        tag.year = CORRECTED.year
        tag.track = CORRECTED.track
        tag.trackCount = CORRECTED.trackCount
        tag.disc = CORRECTED.disc
        tag.discCount = CORRECTED.discCount
        file.save()
      } finally {
        file.dispose()
      }
    }

    const pcmAfter = await pcmHash(path)
    check(
      checks,
      codec,
      'audio:untouched',
      pcmBefore === pcmAfter,
      'decoded PCM changed across the tag write'
    )

    // Read back through the writer's own reader.
    {
      const file = File.createFromPath(path)
      try {
        const tag = file.tag
        check(
          checks,
          codec,
          'field:title',
          tag.title === `${CORRECTED.title} (${codec})`,
          `got ${JSON.stringify(tag.title)}`
        )
        check(
          checks,
          codec,
          'field:artist',
          arraysEqual(tag.performers, CORRECTED.artists),
          `got ${JSON.stringify(tag.performers)}`
        )
        check(
          checks,
          codec,
          'field:album',
          tag.album === CORRECTED.album,
          `got ${JSON.stringify(tag.album)}`
        )
        check(
          checks,
          codec,
          'field:genres',
          arraysEqual(recoverGenres(tag.genres, { firstOnly: false }), [...CORRECTED.genres]),
          `got ${JSON.stringify(tag.genres)}`
        )
        check(checks, codec, 'field:year', tag.year === CORRECTED.year, `got ${tag.year}`)
        check(
          checks,
          codec,
          'field:track',
          tag.track === CORRECTED.track && tag.trackCount === CORRECTED.trackCount,
          `got ${tag.track}/${tag.trackCount}`
        )
        check(
          checks,
          codec,
          'field:disc',
          tag.disc === CORRECTED.disc && tag.discCount === CORRECTED.discCount,
          `got ${tag.disc}/${tag.discCount}`
        )

        const picture =
          tag.pictures.length > 0 ? Buffer.from(tag.pictures[0].data.toByteArray()) : null
        check(
          checks,
          codec,
          'preserved:artwork',
          picture !== null && seededPicture !== null && picture.equals(seededPicture),
          picture === null ? 'cover dropped by the write' : 'cover bytes changed'
        )

        const custom = readCustomFrame(file, tagType)
        check(
          checks,
          codec,
          'preserved:custom-frame',
          custom === CUSTOM.value,
          `got ${JSON.stringify(custom)}`
        )
      } finally {
        file.dispose()
      }
    }

    // Read back through music-metadata — the reader the app actually ships.
    {
      const parsed = await parseFile(path)
      const { common } = parsed
      check(
        checks,
        codec,
        'reader:title',
        common.title === `${CORRECTED.title} (${codec})`,
        `music-metadata got ${JSON.stringify(common.title)}`
      )
      check(
        checks,
        codec,
        'reader:artist',
        common.artist === CORRECTED.artists[0],
        `music-metadata got ${JSON.stringify(common.artist)}`
      )
      check(
        checks,
        codec,
        'reader:album',
        common.album === CORRECTED.album,
        `music-metadata got ${JSON.stringify(common.album)}`
      )
      check(
        checks,
        codec,
        'reader:genres',
        Array.isArray(common.genre) &&
          arraysEqual(recoverGenres(common.genre, { firstOnly: true }), [...CORRECTED.genres]),
        `music-metadata got ${JSON.stringify(common.genre)}`
      )
      check(
        checks,
        codec,
        'reader:year',
        common.year === CORRECTED.year,
        `music-metadata got ${common.year}`
      )
      check(
        checks,
        codec,
        'reader:artwork',
        Array.isArray(common.picture) && common.picture.length > 0,
        'music-metadata saw no embedded picture'
      )
    }
  }

  return { version: manifest.version, checks }
}
