import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { parseFile } from 'music-metadata'
import taglib from 'node-taglib-sharp'

const {
  ByteVector,
  File,
  Id3v2CommentsFrame,
  Id3v2FrameClassType,
  Id3v2FrameIdentifiers,
  Id3v2PrivateFrame,
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
 * The corpus attacks it from four sides per codec:
 *   - **Fields round-trip.** Known-bad baseline tags are corrected by a write and
 *     read back — through node-taglib-sharp (the writer under evaluation) *and*
 *     through music-metadata (the reader the app actually ships).
 *   - **Unrelated frames survive.** A write that touches only the scalar fields
 *     must not drop the embedded pictures or the custom frames it never names.
 *     W16-13 hardens this: a back cover, a binary custom frame, and a
 *     multi-instance custom frame (two COMM/TXXX distinguished only by
 *     description) are seeded alongside the original text frame.
 *   - **Picture writes follow Decision B.** Setting a new front cover replaces
 *     only that slot (`written:artwork`); the back cover stays byte-identical
 *     (`preserved:back-cover`). Clearing removes only the front (`removed:artwork`).
 *     Apple `covr` has no picture-type field, so the back-cover checks apply to
 *     the four codecs whose containers actually distinguish front from the rest.
 *   - **Audio is untouched.** The decoded PCM is hashed before and after the
 *     write; a tag edit that rewrote a single audio byte changes the hash.
 *
 * node-taglib-sharp is the write engine's library (W16-3); this corpus is where
 * it is confirmed to round-trip all five codecs. A codec it cannot round-trip is
 * a finding here, not a surprise in the flush path. Anything the gate flags is a
 * triage card, never a quiet fix folded into the writer.
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
export const CORPUS_VERSION = 2

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

/** The arbitrary text frame that must survive a write. Keyed per tag format. */
const CUSTOM = Object.freeze({
  /** Xiph field name / ID3v2 TXXX description / MP4 freeform atom name. */
  key: 'OSCINE_CUSTOM',
  /** MP4 freeform atom mean (reverse-DNS, iTunes convention). */
  mean: 'com.oscine',
  value: 'preserve-me-42'
})

/**
 * A binary custom frame. ID3 stores it as PRIV (true binary). Vorbis comments
 * and iTunes freeform atoms are UTF-8 text, so Xiph and Apple store the same
 * payload as a base64 field (`OSCINE_BIN`) — the format-honest encoding, not a
 * second picture block. The bytes include NULs and high bits so a latin-1
 * string round-trip cannot masquerade as success.
 */
const BINARY = Object.freeze({
  key: 'OSCINE_BIN',
  owner: 'com.oscine.probe',
  bytes: Buffer.from([
    0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef, 0xff, 0x00, 0x80, 0x7f, 0x0a, 0x0d, 0x1b, 0x42
  ])
})
const BINARY_B64 = BINARY.bytes.toString('base64')

/**
 * Two instances of the same frame type, distinguished only by description (ID3
 * COMM) or as two values of one key (Xiph / iTunes freeform). The point is that
 * a write which does not name them must keep both, not collapse to the first.
 */
const MULTI = Object.freeze({
  key: 'OSCINE_MULTI',
  a: Object.freeze({ description: 'oscine-a', value: 'alpha' }),
  b: Object.freeze({ description: 'oscine-b', value: 'beta' })
})

/**
 * 24×24 solid PNGs, embedded as bytes so artwork is identical on every platform
 * — an ffmpeg-generated cover would differ byte-for-byte across ffmpeg builds
 * and break the "survives unchanged" comparison. Generated once with
 * `ffmpeg -f lavfi -i color=c=<hex>:s=24x24 -frames:v 1`.
 *
 * Front `0x2E5C8A`, back `0x8A2E5C`, and the replacement front `0x5C8A2E` are
 * different colours so a swapped or dropped picture cannot pass a byte compare.
 */
const COVER_MIME = 'image/png'
const COVER_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAACXBIWXMAAAABAAAAAQBPJcTWAAAALElEQVR4nGPUi+pkoAZgoYopDKMGEQNGA5swGA0jwmA0jAiD0TAiDAZfGAEAktMBb44rLt4AAAAASUVORK5CYII=',
  'base64'
)
const BACK_COVER_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAACXBIWXMAAAABAAAAAQBPJcTWAAAALElEQVR4nGPs0o1loAZgoYopDKMGEQNGA5swGA0jwmA0jAiD0TAiDAZfGAEAp90BcrByiw4AAAAASUVORK5CYII=',
  'base64'
)
const NEW_COVER_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAACXBIWXMAAAABAAAAAQBPJcTWAAAALElEQVR4nGOM7tJloAZgoYopDKMGEQNGA5swGA0jwmA0jAiD0TAiDAZfGAEAmjIBcEEHe2oAAAAASUVORK5CYII=',
  'base64'
)

/** Apple `covr` has no picture-type field, so Decision B's back-cover checks skip AAC. */
function supportsTypedPictures(codecId) {
  return codecId !== 'aac'
}

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

function pictureBytes(picture) {
  return picture ? Buffer.from(picture.data.toByteArray()) : null
}

function findPicture(pictures, type) {
  return (pictures ?? []).find((picture) => picture.type === type) ?? null
}

function frontCoverPicture(pictures) {
  const all = pictures ?? []
  return all.find((picture) => isFrontCoverSlot(picture, all)) ?? null
}

/**
 * The front-cover slot Decision B writes and clears — kept in lockstep with
 * `isFrontCoverSlot` / `applyArtwork` in `src/main/library/writeback/writer.ts`.
 * A typed FrontCover always counts; a sole untyped Other is the de-facto front;
 * a lone back cover is not.
 */
function isFrontCoverSlot(picture, all) {
  if (picture.type === PictureType.FrontCover) return true
  return all.length === 1 && picture.type === PictureType.Other
}

function applyFrontCover(tag, intent) {
  const existing = tag.pictures ?? []
  const kept = existing.filter((picture) => !isFrontCoverSlot(picture, existing))
  if (intent === 'clear') {
    tag.pictures = kept
    return
  }
  const front = Picture.fromFullData(
    ByteVector.fromByteArray(intent.bytes),
    PictureType.FrontCover,
    intent.mime,
    'cover'
  )
  tag.pictures = [front, ...kept]
}

function makeFrontCover() {
  return Picture.fromFullData(
    ByteVector.fromByteArray(COVER_BYTES),
    PictureType.FrontCover,
    COVER_MIME,
    'cover'
  )
}

function makeBackCover() {
  return Picture.fromFullData(
    ByteVector.fromByteArray(BACK_COVER_BYTES),
    PictureType.BackCover,
    COVER_MIME,
    'back'
  )
}

/** Writes the arbitrary text custom frame in the idiom each format provides. */
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

/** Reads the arbitrary text custom frame back, or null when it is gone. */
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

function writeBinaryFrame(file, tagType) {
  const tag = customTag(file, tagType)
  if (tagType === 'xiph') {
    tag.setFieldAsStrings(BINARY.key, BINARY_B64)
  } else if (tagType === 'id3v2') {
    const frame = Id3v2PrivateFrame.fromOwner(BINARY.owner)
    frame.privateData = ByteVector.fromByteArray(BINARY.bytes)
    tag.addFrame(frame)
  } else {
    tag.setItunesStrings(CUSTOM.mean, BINARY.key, BINARY_B64)
  }
}

function readBinaryFrame(file, tagType) {
  const tag = customTag(file, tagType)
  if (tagType === 'xiph') {
    const values = tag.getField(BINARY.key)
    if (!values || values.length === 0) return null
    return Buffer.from(values[0], 'base64')
  }
  if (tagType === 'id3v2') {
    const frames = tag.getFramesByIdentifier(
      Id3v2FrameClassType.PrivateFrame,
      Id3v2FrameIdentifiers.PRIV
    )
    const match = Id3v2PrivateFrame.find(frames, BINARY.owner)
    return match ? Buffer.from(match.privateData.toByteArray()) : null
  }
  const values = tag.getItunesStrings(CUSTOM.mean, BINARY.key)
  if (!values || values.length === 0) return null
  return Buffer.from(values[0], 'base64')
}

function writeMultiFrame(file, tagType) {
  const tag = customTag(file, tagType)
  if (tagType === 'xiph') {
    tag.setFieldAsStrings(MULTI.key, MULTI.a.value, MULTI.b.value)
  } else if (tagType === 'id3v2') {
    for (const instance of [MULTI.a, MULTI.b]) {
      const frame = Id3v2CommentsFrame.fromDescription(instance.description, 'eng')
      frame.text = instance.value
      tag.addFrame(frame)
    }
  } else {
    tag.setItunesStrings(CUSTOM.mean, MULTI.key, MULTI.a.value, MULTI.b.value)
  }
}

function readMultiFrame(file, tagType) {
  const tag = customTag(file, tagType)
  if (tagType === 'xiph') {
    return [...(tag.getField(MULTI.key) ?? [])]
  }
  if (tagType === 'id3v2') {
    const frames = tag.getFramesByIdentifier(
      Id3v2FrameClassType.CommentsFrame,
      Id3v2FrameIdentifiers.COMM
    )
    const a = Id3v2CommentsFrame.find(frames, MULTI.a.description, 'eng')
    const b = Id3v2CommentsFrame.find(frames, MULTI.b.description, 'eng')
    return [a?.text ?? null, b?.text ?? null]
  }
  return [...(tag.getItunesStrings(CUSTOM.mean, MULTI.key) ?? [])]
}

function customFramesIntact(file, tagType) {
  const text = readCustomFrame(file, tagType)
  const binary = readBinaryFrame(file, tagType)
  const multi = readMultiFrame(file, tagType)
  const textOk = text === CUSTOM.value
  const binaryOk = binary !== null && binary.equals(BINARY.bytes)
  const multiOk = arraysEqual(multi, [MULTI.a.value, MULTI.b.value])
  return {
    ok: textOk && binaryOk && multiOk,
    detail: !textOk
      ? `text custom got ${JSON.stringify(text)}`
      : !binaryOk
        ? `binary custom ${binary === null ? 'missing' : 'bytes changed'}`
        : !multiOk
          ? `multi-instance got ${JSON.stringify(multi)}`
          : ''
  }
}

function flattenNative(parsed) {
  const out = []
  for (const tags of Object.values(parsed.native ?? {})) {
    for (const tag of tags) out.push(tag)
  }
  return out
}

function nativeTextEquals(tag, expected) {
  const value = tag.value
  if (typeof value === 'string') return value === expected
  if (Array.isArray(value)) return value.includes(expected) || value.join() === expected
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text === expected
  }
  return false
}

function nativeIdLooksLike(tag, token) {
  return String(tag.id ?? '')
    .toUpperCase()
    .includes(String(token).toUpperCase())
}

function readerCustomIntact(parsed) {
  const tags = flattenNative(parsed)
  const textOk = tags.some(
    (tag) => nativeIdLooksLike(tag, CUSTOM.key) && nativeTextEquals(tag, CUSTOM.value)
  )
  const binaryOk = tags.some((tag) => {
    const id = String(tag.id ?? '')
    const value = tag.value
    if (id === 'PRIV' && value && typeof value === 'object') {
      const owner = value.owner_identifier ?? value.owner
      return owner === BINARY.owner && value.data && Buffer.from(value.data).equals(BINARY.bytes)
    }
    return nativeIdLooksLike(tag, BINARY.key) && nativeTextEquals(tag, BINARY_B64)
  })
  const comments = parsed.common?.comment ?? []
  const commentTexts = comments.map((entry) =>
    typeof entry === 'string' ? entry : (entry.text ?? '')
  )
  const commentDescs = comments.map((entry) =>
    typeof entry === 'string' ? '' : (entry.descriptor ?? '')
  )
  const multiFromComments =
    (commentDescs.includes(MULTI.a.description) && commentDescs.includes(MULTI.b.description)) ||
    (commentTexts.includes(MULTI.a.value) && commentTexts.includes(MULTI.b.value))
  const multiFromNative =
    tags.filter(
      (tag) =>
        nativeIdLooksLike(tag, MULTI.key) &&
        (nativeTextEquals(tag, MULTI.a.value) || nativeTextEquals(tag, MULTI.b.value))
    ).length >= 2 ||
    (tags.some((tag) => nativeTextEquals(tag, MULTI.a.value) && nativeIdLooksLike(tag, 'COMM')) &&
      tags.some((tag) => nativeTextEquals(tag, MULTI.b.value) && nativeIdLooksLike(tag, 'COMM')))
  const multiOk = multiFromComments || multiFromNative
  return {
    ok: textOk && binaryOk && multiOk,
    detail: !textOk
      ? 'music-metadata lost the text custom frame'
      : !binaryOk
        ? 'music-metadata lost the binary custom frame'
        : !multiOk
          ? 'music-metadata lost a multi-instance custom frame'
          : ''
  }
}

function readerFrontPicture(pictures) {
  const typed = pictures.find((picture) => (picture.type ?? '').toLowerCase().includes('front'))
  if (typed) return typed
  return pictures.length === 1 && (pictures[0].type ?? '') === '' ? pictures[0] : null
}

function readerBackPicture(pictures) {
  return pictures.find((picture) => (picture.type ?? '').toLowerCase().includes('back')) ?? null
}

function readerPictureBytes(picture) {
  return picture ? Buffer.from(picture.data) : null
}

/**
 * Builds the corpus under `rootDir/library`, returning a manifest.
 *
 * Each file gets synthesised audio, the known-bad baseline, front and back
 * covers, a text custom frame, a binary custom frame, and a multi-instance
 * custom frame — the full "before" state a flush is later asked to correct
 * without breaking. Apple `covr` stores both pictures but cannot type the back
 * cover, so the typed `preserved:back-cover` checks skip AAC. Idempotent: the
 * root is wiped first, so a rebuild is byte-stable given the same ffmpeg.
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
      file.tag.pictures = [makeFrontCover(), makeBackCover()]
      writeCustomFrame(file, codec.tagType)
      writeBinaryFrame(file, codec.tagType)
      writeMultiFrame(file, codec.tagType)
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
    backCover: { bytes: BACK_COVER_BYTES, mimeType: COVER_MIME },
    writtenCover: { bytes: NEW_COVER_BYTES, mimeType: COVER_MIME },
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
 * music-metadata. After the scalar pass it sets a new front cover and then
 * clears it, asserting Decision B: the back cover and custom frames survive
 * both picture writes. Returns a flat check list the probe turns into a report
 * and an exit code.
 */
export async function verifyRoundTrip(manifest, log = () => {}) {
  const checks = []
  const typed = (codec) => supportsTypedPictures(codec)

  for (const track of manifest.tracks) {
    const { id: codec, tagType, path } = track
    log(`round-tripping ${track.file}`)

    const pcmBefore = await pcmHash(path)

    // Sanity: the seeded "before" state the write must preserve.
    let seededFront
    let seededBack
    let seededHasBackBytes
    let seededCustom
    {
      const file = File.createFromPath(path)
      try {
        const pictures = file.tag.pictures ?? []
        seededFront = pictureBytes(frontCoverPicture(pictures))
        seededBack = pictureBytes(findPicture(pictures, PictureType.BackCover))
        seededHasBackBytes = pictures.some((picture) =>
          pictureBytes(picture)?.equals(BACK_COVER_BYTES)
        )
        seededCustom = customFramesIntact(file, tagType)
      } finally {
        file.dispose()
      }
    }
    check(
      checks,
      codec,
      'seed:artwork',
      seededFront !== null && seededFront.equals(COVER_BYTES),
      'no front cover was embedded at synthesis'
    )
    check(
      checks,
      codec,
      'seed:back-cover',
      typed(codec)
        ? seededBack !== null && seededBack.equals(BACK_COVER_BYTES)
        : seededHasBackBytes,
      'no back cover was embedded at synthesis'
    )
    check(
      checks,
      codec,
      'seed:custom-frame',
      seededCustom.ok,
      seededCustom.detail || 'custom frames missing at synthesis'
    )

    // The write: correct the scalar fields only. Pictures and the custom frames
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

        const front = pictureBytes(frontCoverPicture(tag.pictures))
        check(
          checks,
          codec,
          'preserved:artwork',
          front !== null && seededFront !== null && front.equals(seededFront),
          front === null ? 'front cover dropped by the scalar write' : 'front cover bytes changed'
        )

        const custom = customFramesIntact(file, tagType)
        check(checks, codec, 'preserved:custom-frame', custom.ok, custom.detail)

        if (typed(codec)) {
          const back = pictureBytes(findPicture(tag.pictures, PictureType.BackCover))
          check(
            checks,
            codec,
            'preserved:back-cover',
            back !== null && back.equals(BACK_COVER_BYTES),
            back === null ? 'back cover dropped by the scalar write' : 'back cover bytes changed'
          )
        }
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
      const pictures = common.picture ?? []
      check(
        checks,
        codec,
        'reader:artwork',
        pictures.length > 0,
        'music-metadata saw no embedded picture'
      )
      const readerCustom = readerCustomIntact(parsed)
      check(checks, codec, 'reader:preserved:custom-frame', readerCustom.ok, readerCustom.detail)
    }

    // Picture write path (W16-13): replace only the front cover, then clear it.
    {
      const file = File.createFromPath(path)
      try {
        applyFrontCover(file.tag, { bytes: NEW_COVER_BYTES, mime: COVER_MIME })
        file.save()
      } finally {
        file.dispose()
      }
    }

    {
      const file = File.createFromPath(path)
      try {
        const pictures = file.tag.pictures ?? []
        const front = pictureBytes(frontCoverPicture(pictures))
        const back = pictureBytes(findPicture(pictures, PictureType.BackCover))
        check(
          checks,
          codec,
          'written:artwork',
          front !== null && front.equals(NEW_COVER_BYTES),
          front === null
            ? 'front cover missing after set'
            : 'front cover bytes did not match the new image'
        )
        if (typed(codec)) {
          check(
            checks,
            codec,
            'preserved:back-cover',
            back !== null && back.equals(BACK_COVER_BYTES),
            back === null
              ? 'back cover dropped by the front-cover write'
              : 'back cover bytes changed'
          )
        }
        const custom = customFramesIntact(file, tagType)
        check(checks, codec, 'preserved:custom-frame:after-artwork-write', custom.ok, custom.detail)
      } finally {
        file.dispose()
      }
    }

    {
      const parsed = await parseFile(path)
      const pictures = parsed.common.picture ?? []
      const front = readerPictureBytes(readerFrontPicture(pictures))
      const back = readerPictureBytes(readerBackPicture(pictures))
      check(
        checks,
        codec,
        'reader:written:artwork',
        front !== null && front.equals(NEW_COVER_BYTES),
        front === null
          ? 'music-metadata saw no front cover after set'
          : 'music-metadata front cover bytes did not match the new image'
      )
      if (typed(codec)) {
        check(
          checks,
          codec,
          'reader:preserved:back-cover',
          back !== null && back.equals(BACK_COVER_BYTES),
          back === null
            ? 'music-metadata lost the back cover after the front-cover write'
            : 'music-metadata back cover bytes changed'
        )
      }
      const readerCustom = readerCustomIntact(parsed)
      check(
        checks,
        codec,
        'reader:preserved:custom-frame:after-artwork-write',
        readerCustom.ok,
        readerCustom.detail
      )
    }

    {
      const file = File.createFromPath(path)
      try {
        applyFrontCover(file.tag, 'clear')
        file.save()
      } finally {
        file.dispose()
      }
    }

    {
      const file = File.createFromPath(path)
      try {
        const pictures = file.tag.pictures ?? []
        const front = frontCoverPicture(pictures)
        const back = pictureBytes(findPicture(pictures, PictureType.BackCover))
        if (typed(codec)) {
          check(
            checks,
            codec,
            'removed:artwork',
            front === null && back !== null && back.equals(BACK_COVER_BYTES),
            front !== null
              ? 'front cover still present after clear'
              : back === null
                ? 'back cover dropped by the front-cover clear'
                : 'back cover bytes changed'
          )
        } else {
          const leftoverFront =
            front !== null || (pictures.length === 1 && pictures[0].type === PictureType.Other)
          check(
            checks,
            codec,
            'removed:artwork',
            !leftoverFront,
            leftoverFront ? 'front cover still present after clear' : ''
          )
        }
      } finally {
        file.dispose()
      }
    }

    {
      const parsed = await parseFile(path)
      const pictures = parsed.common.picture ?? []
      const front = readerFrontPicture(pictures)
      const back = readerPictureBytes(readerBackPicture(pictures))
      if (typed(codec)) {
        check(
          checks,
          codec,
          'reader:removed:artwork',
          front === null && back !== null && back.equals(BACK_COVER_BYTES),
          front !== null
            ? 'music-metadata still saw a front cover after clear'
            : back === null
              ? 'music-metadata lost the back cover after the front-cover clear'
              : 'music-metadata back cover bytes changed'
        )
      } else {
        check(
          checks,
          codec,
          'reader:removed:artwork',
          front === null,
          front !== null ? 'music-metadata still saw a front cover after clear' : ''
        )
      }
    }

    const pcmAfterPictures = await pcmHash(path)
    check(
      checks,
      codec,
      'audio:untouched:after-artwork-write',
      pcmBefore === pcmAfterPictures,
      'decoded PCM changed across the picture writes'
    )
  }

  return { version: manifest.version, checks }
}
