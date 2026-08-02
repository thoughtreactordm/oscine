import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAudioMetadata } from 'music-metadata'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normaliseCodec,
  readTrackFormatDetail,
  readTrackTags,
  toTrackFormatDetail,
  toTrackTags
} from '../../../src/main/library/metadata'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-meta-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/*
 * A real, valid WAV is assembled here rather than committed as a fixture.
 *
 * `.wav` is in the card's supported list and is the one supported format whose
 * container is simple enough to write by hand, which makes it the only way to
 * prove the `music-metadata` integration end to end without checking a binary
 * into the repository. Everything below the parser — field names, units, the
 * shape of `IRatio` — is guesswork until something actually parses a file.
 */

const SAMPLE_RATE = 44100
const CHANNELS = 2
const BITS = 16
const DURATION_SEC = 0.5

/** One `INFO` sub-chunk: a four-character id, a NUL-terminated string, padded even. */
function infoChunk(id: string, value: string): Buffer {
  // Assembled from bytes rather than from a string escape, so the terminator is
  // explicit and no NUL character ends up in this source file.
  const text = Buffer.concat([Buffer.from(value, 'utf8'), Buffer.alloc(1)])
  const header = Buffer.alloc(8)
  header.write(id, 0, 'ascii')
  header.writeUInt32LE(text.length, 4)
  // RIFF chunks are word-aligned; an odd-length payload gets one pad byte that
  // the declared size does not count.
  const pad = text.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([header, text, pad])
}

function riffChunk(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(id, 0, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  const pad = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([header, payload, pad])
}

function writeWav(name: string, info: Record<string, string>): string {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8
  const blockAlign = (CHANNELS * BITS) / 8

  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(CHANNELS, 2)
  fmt.writeUInt32LE(SAMPLE_RATE, 4)
  fmt.writeUInt32LE(byteRate, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(BITS, 14)

  const infoPayload = Buffer.concat([
    Buffer.from('INFO', 'ascii'),
    ...Object.entries(info).map(([id, value]) => infoChunk(id, value))
  ])

  // Silence. The parser reads the header for duration and never the samples.
  const audio = Buffer.alloc(byteRate * DURATION_SEC)

  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    riffChunk('fmt ', fmt),
    riffChunk('LIST', infoPayload),
    riffChunk('data', audio)
  ])

  const abs = join(dir, name)
  writeFileSync(abs, riffChunk('RIFF', body))
  return abs
}

describe('readTrackTags, against a real file', () => {
  it('reads the tags a RIFF INFO chunk carries', async () => {
    const file = writeWav('track.wav', {
      INAM: 'Julie and Candy',
      IART: 'Boards of Canada',
      IPRD: 'Geogaddi',
      ICRD: '2002',
      ITRK: '9'
    })

    const tags = await readTrackTags(file)

    expect(tags.title).toBe('Julie and Candy')
    expect(tags.artist).toBe('Boards of Canada')
    expect(tags.album).toBe('Geogaddi')
    expect(tags.year).toBe(2002)
    expect(tags.trackNo).toBe(9)
  })

  it('reads the audio properties the track list and W3 need', async () => {
    const file = writeWav('props.wav', { INAM: 'Silence' })

    const tags = await readTrackTags(file)

    expect(tags.sampleRate).toBe(SAMPLE_RATE)
    expect(tags.channels).toBe(CHANNELS)
    expect(tags.bitDepth).toBe(BITS)
    expect(tags.durationMs).toBe(DURATION_SEC * 1000)
    expect(tags.codec).toBe('pcm')
  })

  it('reports absent tags as null rather than as empty strings', async () => {
    const file = writeWav('bare.wav', {})

    const tags = await readTrackTags(file)

    expect(tags.title).toBeNull()
    expect(tags.artist).toBeNull()
    expect(tags.album).toBeNull()
    expect(tags.albumArtist).toBeNull()
    expect(tags.replayGain).toBeNull()
  })

  it('rejects a file that is not there', async () => {
    await expect(readTrackTags(join(dir, 'gone.flac'))).rejects.toThrow()
  })

  /**
   * The finding that shapes how the scanner skips.
   *
   * `music-metadata` is deliberately tolerant. Handed a renamed text file, or a
   * truncated download whose magic bytes are intact, it does *not* throw — it
   * resolves with every field empty. So a `try`/`catch` around the parser
   * catches only the I/O failures, and the card's "files that fail to parse are
   * logged and skipped" needs the emptiness itself to be the signal. That check
   * lives in the scanner; these two cases are what justify it.
   */
  it.each([
    ['content it cannot identify', 'notmusic.wav', Buffer.from('this is not a RIFF header')],
    [
      'a truncated file whose magic bytes survive',
      'truncated.flac',
      Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(3, 0xff)])
    ]
  ])('resolves empty rather than rejecting for %s', async (_case, name, contents) => {
    const abs = join(dir, name)
    writeFileSync(abs, contents)

    const tags = await readTrackTags(abs)

    // No duration and no codec: nothing here describes an audio stream.
    expect(tags.durationMs).toBeNull()
    expect(tags.codec).toBeNull()
  })
})

describe('normaliseCodec', () => {
  it('collapses the parser vocabulary onto the schema v1 tokens', () => {
    expect(normaliseCodec('MPEG 1 Layer 3')).toBe('mp3')
    expect(normaliseCodec('FLAC')).toBe('flac')
    expect(normaliseCodec('Vorbis')).toBe('vorbis')
    expect(normaliseCodec('Opus')).toBe('opus')
    expect(normaliseCodec('MPEG-4/AAC')).toBe('aac')
    expect(normaliseCodec('PCM_S16LE')).toBe('pcm')
  })

  it('recognises the extensible WAV wrapper as PCM', () => {
    // Found against a real 24-bit/96k WAV: ffmpeg writes WAVE_FORMAT_EXTENSIBLE
    // (0xFFFE) for anything above 16-bit stereo, and the parser labels it
    // `non-pcm (65534)`. Left alone, the most ordinary hi-res WAV in a library
    // gets a codec that reads like a failure.
    expect(normaliseCodec('non-pcm (65534)')).toBe('pcm')
  })

  it('falls back to the container when no codec is reported', () => {
    expect(normaliseCodec(undefined, 'FLAC')).toBe('flac')
    expect(normaliseCodec('', 'Ogg')).toBe('ogg')
  })

  it('keeps an unrecognised codec rather than discarding it', () => {
    // A NULL would be worse: this value is what tells you why a file will not
    // play once someone is looking at the row.
    expect(normaliseCodec('Monkey’s Audio')).toBe('monkey’s audio')
  })

  it('is null only when nothing was reported', () => {
    expect(normaliseCodec(undefined, undefined)).toBeNull()
    expect(normaliseCodec('   ')).toBeNull()
  })
})

/**
 * The mapping as a pure function.
 *
 * ReplayGain cannot be expressed in a RIFF INFO chunk, so the units — decibels
 * for gain, a linear ratio for peak — are only checkable here. Getting them
 * backwards would be silent until M2 applied a peak as though it were a gain.
 */
describe('toTrackTags', () => {
  function parsed(common: object, format: object = {}): IAudioMetadata {
    // A partial stand-in for the parser's result. Cast because IAudioMetadata
    // carries several branches this mapping never reads.
    return { common, format, native: {}, quality: { warnings: [] } } as unknown as IAudioMetadata
  }

  it('takes the first genre a file names', () => {
    expect(toTrackTags(parsed({ genre: ['IDM', 'Electronic'] })).genre).toBe('IDM')
  })

  it('leaves genre null when the file names none', () => {
    // The same value a track indexed before migration 10 carries. Both mean the
    // genre strand is absent for that track rather than empty.
    expect(toTrackTags(parsed({})).genre).toBeNull()
    expect(toTrackTags(parsed({ genre: [] })).genre).toBeNull()
  })

  it('skips a blank leading genre rather than reading it as a value', () => {
    expect(toTrackTags(parsed({ genre: ['   ', 'Ambient'] })).genre).toBe('Ambient')
  })

  it('does not split a compound genre tag', () => {
    // `Folk/Rock` is one genre in some libraries and two in others, and the
    // scanner writes to disk-backed state for every file it touches — so it
    // reads the list, and does not invent one.
    expect(toTrackTags(parsed({ genre: ['Folk/Rock'] })).genre).toBe('Folk/Rock')
  })

  it('takes gain in dB and peak as a ratio', () => {
    const tags = toTrackTags(
      parsed({
        replaygain_track_gain: { dB: -7.5, ratio: 0.177 },
        replaygain_track_peak: { dB: -0.5, ratio: 0.944 },
        replaygain_album_gain: { dB: -6.25, ratio: 0.237 },
        replaygain_album_peak: { dB: -0.1, ratio: 0.988 }
      })
    )

    expect(tags.replayGain).toEqual({
      trackGainDb: -7.5,
      trackPeak: 0.944,
      albumGainDb: -6.25,
      albumPeak: 0.988
    })
  })

  it('keeps a partial ReplayGain set rather than discarding it', () => {
    const tags = toTrackTags(parsed({ replaygain_track_gain: { dB: -9, ratio: 0.126 } }))

    expect(tags.replayGain).toEqual({
      trackGainDb: -9,
      trackPeak: null,
      albumGainDb: null,
      albumPeak: null
    })
  })

  it('reports no ReplayGain at all as null, so rg_source stays NULL', () => {
    expect(toTrackTags(parsed({})).replayGain).toBeNull()
  })

  it('treats blank and whitespace-only tags as absent', () => {
    const tags = toTrackTags(parsed({ title: '   ', artist: '', album: '  Geogaddi  ' }))

    expect(tags.title).toBeNull()
    expect(tags.artist).toBeNull()
    expect(tags.album).toBe('Geogaddi')
  })

  it('rejects the placeholder values tag formats use for "no value"', () => {
    // Year 0 and track 0 both mean "unset" in the wild, and both would be shown
    // to the user as real data.
    const tags = toTrackTags(parsed({ year: 0, track: { no: 0, of: 0 }, disk: { no: 0, of: 0 } }))

    expect(tags.year).toBeNull()
    expect(tags.trackNo).toBeNull()
    expect(tags.discNo).toBeNull()
  })

  it('falls back to the leading year of a full date', () => {
    expect(toTrackTags(parsed({ date: '2002-02-18' })).year).toBe(2002)
  })

  it('discards a non-finite number rather than storing it', () => {
    const tags = toTrackTags(
      parsed({}, { duration: Number.NaN, sampleRate: Number.POSITIVE_INFINITY })
    )

    expect(tags.durationMs).toBeNull()
    expect(tags.sampleRate).toBeNull()
  })

  it('converts duration from seconds to the millisecond column', () => {
    expect(toTrackTags(parsed({}, { duration: 312.4567 })).durationMs).toBe(312457)
  })
})

describe('toTrackFormatDetail', () => {
  function parsed(format: object): IAudioMetadata {
    return {
      common: {},
      format,
      native: {},
      quality: { warnings: [] }
    } as unknown as IAudioMetadata
  }

  it('carries the parser strings through undigested', () => {
    // The whole point of a separate type: `normaliseCodec` would collapse this
    // to `mp3`, which is right for the column and wrong for a readout.
    const detail = toTrackFormatDetail(
      parsed({
        container: 'MPEG',
        codec: 'MPEG 1 Layer 3',
        codecProfile: 'V0',
        bitrate: 245_000,
        lossless: false,
        tool: 'LAME 3.100'
      })
    )

    expect(detail.codec).toBe('MPEG 1 Layer 3')
    expect(detail.container).toBe('MPEG')
    expect(detail.codecProfile).toBe('V0')
    expect(detail.tool).toBe('LAME 3.100')
    expect(detail.lossless).toBe(false)
  })

  it('reads constancy off the encoder profile, both ways', () => {
    expect(toTrackFormatDetail(parsed({ codecProfile: 'CBR' })).bitrateMode).toBe('constant')
    expect(toTrackFormatDetail(parsed({ codecProfile: 'V2' })).bitrateMode).toBe('variable')
    expect(toTrackFormatDetail(parsed({ codecProfile: 'ABR' })).bitrateMode).toBe('variable')
  })

  it('refuses to guess constancy when the file did not say', () => {
    // `LC` is an AAC object type, not a bitrate mode, and Vorbis states nothing
    // at all. Neither may be turned into a CBR/VBR claim.
    expect(toTrackFormatDetail(parsed({ codecProfile: 'LC' })).bitrateMode).toBeNull()
    expect(toTrackFormatDetail(parsed({ codec: 'Vorbis I' })).bitrateMode).toBeNull()
  })

  it('leaves a lossless codec unlabelled', () => {
    // FLAC varies per frame by construction. Calling that VBR beside a V0 MP3
    // would imply a choice the encoder never offered.
    const detail = toTrackFormatDetail(parsed({ codecProfile: 'VBR', lossless: true }))
    expect(detail.bitrateMode).toBeNull()
  })

  it('rounds the fractional bitrate the parser derives', () => {
    expect(toTrackFormatDetail(parsed({ bitrate: 320_999.87 })).bitrateBps).toBe(321_000)
  })

  it('has no bitrate rather than a zero one', () => {
    expect(toTrackFormatDetail(parsed({ bitrate: 0 })).bitrateBps).toBeNull()
    expect(toTrackFormatDetail(parsed({ bitrate: Number.NaN })).bitrateBps).toBeNull()
    expect(toTrackFormatDetail(parsed({})).bitrateBps).toBeNull()
  })
})

describe('readTrackFormatDetail, against a real file', () => {
  it('reports the container, bitrate and losslessness of a WAV', async () => {
    const file = writeWav('signal.wav', { INAM: 'Silence' })

    const detail = await readTrackFormatDetail(file)

    expect(detail.container).toBe('WAVE')
    expect(detail.lossless).toBe(true)
    // 44100 × 2 × 16 — the figure the readout puts beside "Bitrate", derived by
    // the parser from the same header the scanner reads.
    expect(detail.bitrateBps).toBe(1_411_200)
    // Uncompressed PCM states no profile, so the pane draws no mode note.
    expect(detail.bitrateMode).toBeNull()
  })
})
