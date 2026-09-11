import { parseFile } from 'music-metadata'
import type { IAudioMetadata, ILyricsTag, ITag } from 'music-metadata'
import type { BitrateMode, TrackFormatDetail } from '@shared/library'

/**
 * The `music-metadata` adapter.
 *
 * Everything the scanner knows about tag parsing is this file's `TrackTags`
 * shape. That containment is the point: `music-metadata` returns a large,
 * format-dependent structure with several ways to spell the same fact, and
 * letting it reach the writer would put format trivia into SQL-building code.
 * It also makes the scanner testable without binary fixtures — tests supply a
 * `MetadataReader`, not a file.
 */

export interface ReplayGain {
  /** Decibels, per the `rg_track_gain` column comment in schema v1. */
  trackGainDb: number | null
  /** Linear ratio in [0..1], which is how ReplayGain peaks are defined. */
  trackPeak: number | null
  albumGainDb: number | null
  albumPeak: number | null
}

export interface TrackTags {
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  trackNo: number | null
  discNo: number | null
  year: number | null
  durationMs: number | null
  codec: string | null
  sampleRate: number | null
  channels: number | null
  bitDepth: number | null
  /** The first named genre, or `null`. See `primaryGenre`. */
  genre: string | null
  /** `null` when the file carries no `REPLAYGAIN_*` tags at all. */
  replayGain: ReplayGain | null
  /**
   * The file's embedded lyrics as raw text, or `null` — W17's tier-2 source.
   *
   * Raw on purpose: whatever the tag holds, verbatim. See {@link extractLyrics}.
   * The scanner never writes this to a column — it rides along in the on-demand
   * read (the lyrics resolver reuses the `MetadataReader` seam) so the feature
   * stays schema v1 and the scan path untouched, per W17-2. `parseLrc` (later,
   * in the resolver) is what decides whether the text is timed.
   */
  lyrics: string | null
}

/** Injection seam: the scanner takes one of these rather than importing a parser. */
export type MetadataReader = (absPath: string) => Promise<TrackTags>

/** The same seam for the on-demand format readout. Same reason: no fixtures. */
export type FormatDetailReader = (absPath: string) => Promise<TrackFormatDetail>

export interface EmbeddedArtwork {
  /** Parser order, retained as the deterministic tiebreaker after cover type. */
  index: number
  format: string
  type: string | null
  bytes: Uint8Array
}

/** Injection seam for artwork reconciliation and malformed-image tests. */
export type EmbeddedArtworkReader = (absPath: string) => Promise<EmbeddedArtwork[]>

/**
 * The file's front-cover picture, or `null` — the frame Decision B writes and
 * clears. A typed front cover wins; failing that, a file carrying exactly one
 * *untyped* picture treats it as the de-facto front (the common single-cover
 * case, and what a flush would have replaced). A lone picture that is explicitly
 * typed something else — a back cover, a disc label — is not a front cover, so a
 * file left with only that reads as having no front cover to match.
 */
export function resolveFrontCover(pictures: readonly EmbeddedArtwork[]): EmbeddedArtwork | null {
  const typed = pictures.find((picture) => (picture.type ?? '').toLowerCase().includes('front'))
  if (typed) return typed
  return pictures.length === 1 && (pictures[0].type ?? '') === '' ? pictures[0] : null
}

/** Trimmed, with blank and whitespace-only tags treated as absent. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Guards every numeric column.
 *
 * A malformed tag reaches us as `NaN` or `Infinity` rather than as a throw, and
 * SQLite stores a non-finite REAL as NULL without complaint — so the column
 * would end up empty either way, but only this way is it deliberate.
 */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A positive integer, or `null`. Track and disc numbers are never zero. */
function positiveInt(value: unknown): number | null {
  const n = finite(value)
  return n !== null && Number.isInteger(n) && n > 0 ? n : null
}

/**
 * A plausible release year.
 *
 * Year 0 is the common representation of "no date" in several tag formats, and
 * a four-digit ceiling rejects the timestamps that occasionally land in a year
 * field. Both would otherwise be shown to the user as though they were real.
 */
function releaseYear(metadata: IAudioMetadata): number | null {
  const tagged = positiveInt(metadata.common.year)
  if (tagged !== null && tagged < 3000) return tagged

  // `common.year` is usually derived from `common.date` already, but not for
  // every container — take the leading four digits when it was not.
  const fromDate = /^(\d{4})/.exec(text(metadata.common.date) ?? '')
  if (!fromDate) return null
  const year = Number(fromDate[1])
  return year > 0 && year < 3000 ? year : null
}

/**
 * The first genre a file names, verbatim.
 *
 * Genre is multi-valued in every tag format that has it, and the related pane's
 * neighbourhood strand is a single equality over one indexed column — so
 * something has to collapse the list, and the choices are "first", "join them"
 * or "normalise them". Only the first is defensible without inventing rules:
 * joining produces a value that matches nothing else in the library, and
 * normalising means owning a synonym table for a dimension W7-5 already calls
 * the weak half.
 *
 * Not split on `/` or `;` either, however tempting a `Rock; Pop` tag makes it.
 * `Folk/Rock` is one genre in some libraries and two in others, and a scanner
 * that guesses wrong writes the wrong thing to disk-backed state for every file
 * it touches. The honest reading of a list is its first element.
 *
 * When M3's FTS5 work lands and the strand stops being an equality, this is the
 * function that gets to be cleverer — see the seam note in `library/related.ts`.
 */
export function primaryGenre(genres: readonly string[] | undefined): string | null {
  for (const candidate of genres ?? []) {
    const value = text(candidate)
    if (value !== null) return value
  }
  return null
}

/**
 * Collapses the parser's codec vocabulary onto the tokens schema v1 documents.
 *
 * `format.codec` is descriptive rather than enumerated — MP3 arrives as
 * `'MPEG 1 Layer 3'` — so matching is by substring. Anything unrecognised is
 * kept lower-cased rather than discarded: an honest unknown value is more use
 * when debugging a file than a NULL.
 */
export function normaliseCodec(codec?: string, container?: string): string | null {
  const raw = text(codec) ?? text(container)
  if (raw === null) return null

  const lower = raw.toLowerCase()
  if (lower.includes('layer 3') || lower.includes('mp3')) return 'mp3'
  if (lower.includes('flac')) return 'flac'
  if (lower.includes('vorbis')) return 'vorbis'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('alac')) return 'alac'
  if (lower.includes('aac')) return 'aac'
  // WAV. Outside the list in the schema comment, which enumerates the lossy and
  // lossless codecs, not the uncompressed case the card's `.wav` support implies.
  if (lower.startsWith('pcm')) return 'pcm'
  // WAVE_FORMAT_EXTENSIBLE. The parser reports this as `non-pcm (65534)`
  // because the real subformat sits in an extension field it does not read, but
  // 0xFFFE is only a wrapper — and it is how essentially every 24-bit or
  // multichannel WAV is written, so without this the common case gets a codec
  // string that reads like an error.
  if (lower.includes('65534')) return 'pcm'
  return lower
}

/** ID3/Vorbis/MP4 lyric frame ids, upper-cased for a case-fold match. */
const LYRIC_FRAME_IDS = new Set([
  'USLT',
  'SYLT',
  'LYRICS',
  'UNSYNCEDLYRICS',
  'SYNCEDLYRICS',
  '©LYR'
])

/**
 * The file's embedded lyrics as one raw string, or `null`.
 *
 * Deliberately *raw* — whatever the tag holds, verbatim — because most embedded
 * *synced* lyrics are LRC text stuffed into an unsynced frame, so only the
 * shared `parseLrc` (run later, in the resolver) is entitled to decide whether a
 * blob is timed. This surfaces text and does not parse it.
 *
 * `music-metadata` folds ID3 `USLT`/`SYLT`, Vorbis `LYRICS`/`UNSYNCEDLYRICS`/
 * `SYNCEDLYRICS` and MP4 `©lyr` onto `common.lyrics`, so that is preferred; the
 * native-frame sweep is the fallback for a container its generic mapper missed.
 * A tag's plain `text` wins over its `syncText`: the plain form is the common
 * case and needs no reconstruction.
 */
export function extractLyrics(metadata: IAudioMetadata): string | null {
  for (const tag of metadata.common.lyrics ?? []) {
    const plain = text(tag.text)
    if (plain !== null) return plain
    const rebuilt = syncTextToLrc(tag)
    if (rebuilt !== null) return rebuilt
  }
  return nativeLyrics(metadata.native)
}

/**
 * Rebuild an LRC document from a structured `SYLT` frame.
 *
 * `syncText` timestamps are taken as milliseconds — the near-universal choice,
 * and what a re-parse expects — even though ID3 permits an MPEG-frame format.
 * `SYLT` is thin enough across the ecosystem that trading exactness on a
 * frame-timed file for simplicity is the right call; it is stated here so the
 * assumption is not silent.
 */
function syncTextToLrc(tag: ILyricsTag): string | null {
  const lines: string[] = []
  for (const item of tag.syncText ?? []) {
    const body = typeof item.text === 'string' ? item.text : ''
    if (typeof item.timestamp === 'number' && Number.isFinite(item.timestamp)) {
      lines.push(`${lrcStamp(item.timestamp)}${body}`)
    } else if (body !== '') {
      lines.push(body)
    }
  }
  const joined = lines.join('\n').trim()
  return joined === '' ? null : joined
}

/** `[mm:ss.mmm]` for a millisecond offset, the form `parseLrc` reads back at full precision. */
function lrcStamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms))
  const minutes = Math.floor(totalMs / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const millis = totalMs % 1000
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return `[${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}]`
}

/** Fallback sweep of native frames for a container `common.lyrics` did not cover. */
function nativeLyrics(native: IAudioMetadata['native']): string | null {
  for (const tags of Object.values(native)) {
    for (const tag of tags) {
      // Frame ids sometimes carry a `:descriptor` suffix (`USLT:eng`); key on the id.
      const id = tag.id.split(':')[0].toUpperCase()
      if (!LYRIC_FRAME_IDS.has(id)) continue
      const value = nativeLyricText(tag.value)
      if (value !== null) return value
    }
  }
  return null
}

/** A native lyric frame's value is a bare string (Vorbis/MP4) or a `{ text }` object (ID3). */
function nativeLyricText(value: ITag['value']): string | null {
  if (typeof value === 'string') return text(value)
  if (value !== null && typeof value === 'object' && 'text' in value) {
    return text((value as { text?: unknown }).text)
  }
  return null
}

function toReplayGain(common: IAudioMetadata['common']): ReplayGain | null {
  const gain: ReplayGain = {
    trackGainDb: finite(common.replaygain_track_gain?.dB),
    trackPeak: finite(common.replaygain_track_peak?.ratio),
    albumGainDb: finite(common.replaygain_album_gain?.dB),
    albumPeak: finite(common.replaygain_album_peak?.ratio)
  }
  return Object.values(gain).some((value) => value !== null) ? gain : null
}

/**
 * The whole mapping, as a pure function of a parse result.
 *
 * Separated from `readTrackTags` so it can be tested against a synthesised
 * metadata object, and so the one impure step is a single line.
 */
export function toTrackTags(metadata: IAudioMetadata): TrackTags {
  const { common, format } = metadata
  const duration = finite(format.duration)

  return {
    title: text(common.title),
    artist: text(common.artist),
    album: text(common.album),
    albumArtist: text(common.albumartist),
    trackNo: positiveInt(common.track?.no),
    discNo: positiveInt(common.disk?.no),
    year: releaseYear(metadata),
    durationMs: duration === null ? null : Math.round(duration * 1000),
    codec: normaliseCodec(format.codec, format.container),
    sampleRate: positiveInt(format.sampleRate),
    channels: positiveInt(format.numberOfChannels),
    bitDepth: positiveInt(format.bitsPerSample),
    genre: primaryGenre(common.genre),
    replayGain: toReplayGain(common),
    lyrics: extractLyrics(metadata)
  }
}

/**
 * Reads one file's tags.
 *
 * `skipCovers` matters more than it looks: artwork is M3, and without this every
 * file's embedded images are decoded into memory and thrown away — on a large
 * library that is the difference between a scan that fits in RAM and one that
 * does not. `duration: true` asks the parser to keep reading when the header
 * does not state a duration, which is the VBR MP3 case.
 */
export const readTrackTags: MetadataReader = async (absPath) =>
  toTrackTags(await parseFile(absPath, { duration: true, skipCovers: true }))

/**
 * Bitrate constancy, only when the file says so.
 *
 * There is no `format.bitrateMode`, so this reads the encoder's profile string,
 * which is the one place the fact is actually recorded. LAME writes `CBR` or
 * `V0`–`V9`; `ABR` appears on average-bitrate encodes, which vary per frame and
 * are therefore variable however they are marketed.
 *
 * The tempting alternative — compare `format.bitrate` against
 * `size * 8 / duration` and call a mismatch VBR — is rejected. Embedded artwork,
 * an ID3v2 block and a trailing tag all count toward file size and none of them
 * is audio, so a CBR MP3 with a large cover reads as variable by that test. A
 * readout whose job is to be trusted about the file may not guess: `null` here
 * means "the file did not say", and the pane draws nothing rather than a coin
 * flip. Lossless codecs are left `null` too — FLAC's bitrate varies by frame by
 * construction, and labelling it VBR alongside a V0 MP3 implies a choice the
 * encoder never offered.
 */
function bitrateMode(profile: string | null, lossless: boolean | null): BitrateMode | null {
  if (profile === null || lossless === true) return null
  const upper = profile.toUpperCase()
  if (upper === 'CBR') return 'constant'
  if (upper === 'ABR' || upper === 'VBR' || /^V\d$/.test(upper)) return 'variable'
  return null
}

/**
 * The format block, as a pure function of a parse result.
 *
 * Pure half split out from `readTrackFormatDetail` for the same reason
 * `toTrackTags` is: it is the part with rules in it, and it can be tested
 * against a synthesised metadata object instead of a binary fixture.
 */
export function toTrackFormatDetail(metadata: IAudioMetadata): TrackFormatDetail {
  const { format } = metadata
  const profile = text(format.codecProfile)
  const lossless = typeof format.lossless === 'boolean' ? format.lossless : null

  return {
    container: text(format.container),
    codec: text(format.codec),
    codecProfile: profile,
    // Rounded because the parser divides by a fractional duration and hands back
    // 320999.87. Nobody wants that displayed, and no caller wants to round it.
    bitrateBps: (() => {
      const bps = finite(format.bitrate)
      return bps === null || bps <= 0 ? null : Math.round(bps)
    })(),
    bitrateMode: bitrateMode(profile, lossless),
    lossless,
    tool: text(format.tool)
  }
}

/**
 * Reads one file's format block, on demand, for the readout pane.
 *
 * `duration: true` for the same reason `readTrackTags` uses it, and it is the
 * reason this is worth doing at all: a VBR MP3 with no Xing header states no
 * bitrate in its first frame, and the parser can only report one after reading
 * the file. That is the exact case the readout exists to be honest about. FLAC
 * and friends carry it in the header and pay nothing.
 *
 * `skipCovers` matters here more than in the scanner, not less: this runs on
 * every track change, and decoding a 4 MB embedded JPEG to display a sample
 * rate would be a per-track allocation nobody asked for.
 */
export const readTrackFormatDetail: FormatDetailReader = async (absPath) =>
  toTrackFormatDetail(await parseFile(absPath, { duration: true, skipCovers: true }))

/**
 * Reads embedded pictures without making them part of every track parse.
 *
 * Album reconciliation calls this only for deterministic candidate tracks.
 * Front covers sort first and parser order breaks ties, so identical library
 * contents select the same bytes on every platform. Image decoding remains the
 * artwork worker's job: an advertised MIME type is not proof that bytes form a
 * valid image.
 */
export const readEmbeddedArtwork: EmbeddedArtworkReader = async (absPath) => {
  const metadata = await parseFile(absPath, { duration: false, skipCovers: false })
  return (metadata.common.picture ?? [])
    .map((picture, index) => ({
      index,
      format: picture.format,
      type: picture.type ?? null,
      bytes: picture.data
    }))
    .sort((a, b) => coverRank(a.type) - coverRank(b.type) || a.index - b.index)
}

function coverRank(type: string | null): number {
  return type?.toLowerCase().includes('front') ? 0 : 1
}
