import { parseFile } from 'music-metadata'
import type { IAudioMetadata } from 'music-metadata'

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
  /** `null` when the file carries no `REPLAYGAIN_*` tags at all. */
  replayGain: ReplayGain | null
}

/** Injection seam: the scanner takes one of these rather than importing a parser. */
export type MetadataReader = (absPath: string) => Promise<TrackTags>

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
    replayGain: toReplayGain(common)
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
