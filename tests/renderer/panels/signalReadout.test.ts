import { describe, expect, it } from 'vitest'
import {
  buildFormatRows,
  buildReplayGainRows,
  describeDecodePath,
  describeLoudness,
  formatBitrate,
  formatChannels,
  formatGainDb,
  formatSampleRate
} from '../../../src/renderer/panels/tunedeck/signalReadout'
import {
  decideR1Admission,
  DEFAULT_R1_POLICY,
  type R1Policy
} from '../../../src/renderer/audio/r1Admission'
import {
  normalizationPolicyForMode,
  resolveNormalization
} from '../../../src/renderer/audio/normalization'
import { formatDuration, formatFileSize } from '../../../src/renderer/panels/displayFormat'
import type { Track, TrackFormatDetail } from '../../../src/shared/library'

/**
 * The operator's own formatters, pinned. The readout takes them as a parameter
 * so it cannot contradict the track list's size column — binding the real ones
 * here is what proves the wiring, rather than a stub that would agree with
 * anything.
 */
const FORMATS = {
  duration: (seconds: number | null) => formatDuration(seconds, 'auto'),
  size: (bytes: number | null) => formatFileSize(bytes, 'binary')
}

/**
 * What the signal pane claims about a file.
 *
 * The decode-path block is driven through the **real** `decideR1Admission`
 * rather than a hand-written decision object, for the same reason
 * `upNextRows.test.ts` drives the real queue: the pane's whole value is that it
 * agrees with the guard, and a fixture decision would only prove the readout
 * agrees with itself. The two ways R1 sends a track to `<audio>` — over the
 * per-track cap, and over the residency budget — are produced by actually
 * exceeding them.
 */

const MIB = 1024 * 1024

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    rootId: 1,
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: 1,
    discNo: null,
    year: null,
    durationSec: 245,
    codec: 'flac',
    encodedBytes: 28_000_000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    playCount: 0,
    lastPlayedAt: null,
    favorite: false,
    artwork: { small: 'fermata://artwork/1/small', large: 'fermata://artwork/1/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

function detail(overrides: Partial<TrackFormatDetail> = {}): TrackFormatDetail {
  return {
    container: 'FLAC',
    codec: 'FLAC',
    codecProfile: null,
    bitrateBps: 911_000,
    bitrateMode: null,
    lossless: true,
    tool: null,
    ...overrides
  }
}

function rowValue(rows: readonly { key: string; value: string }[], key: string): string {
  const row = rows.find((candidate) => candidate.key === key)
  if (!row) throw new Error(`No row ${key}: have ${rows.map((r) => r.key).join(', ')}`)
  return row.value
}

function rowKeys(rows: readonly { key: string }[]): string[] {
  return rows.map((row) => row.key)
}

describe('scalar formatting', () => {
  it('trims sample rates to the numbers people recognise', () => {
    expect(formatSampleRate(44100)).toBe('44.1 kHz')
    expect(formatSampleRate(48000)).toBe('48 kHz')
    expect(formatSampleRate(192000)).toBe('192 kHz')
  })

  it('has no value for an impossible rate', () => {
    expect(formatSampleRate(null)).toBeNull()
    expect(formatSampleRate(0)).toBeNull()
    expect(formatSampleRate(Number.NaN)).toBeNull()
  })

  it('rounds bitrate to kbps and rejects sub-kbps parses', () => {
    expect(formatBitrate(320_000)).toBe('320 kbps')
    expect(formatBitrate(320_999)).toBe('321 kbps')
    expect(formatBitrate(999)).toBeNull()
    expect(formatBitrate(null)).toBeNull()
  })

  it('names the conventional layouts and counts the rest', () => {
    expect(formatChannels(1)).toBe('Mono')
    expect(formatChannels(2)).toBe('Stereo')
    expect(formatChannels(6)).toBe('5.1')
    expect(formatChannels(8)).toBe('7.1')
    expect(formatChannels(12)).toBe('12 channels')
    expect(formatChannels(0)).toBeNull()
  })

  it('always signs a gain, including zero', () => {
    expect(formatGainDb(-7.1)).toBe('−7.10 dB')
    expect(formatGainDb(2.345)).toBe('+2.35 dB')
    expect(formatGainDb(0)).toBe('+0.00 dB')
    expect(formatGainDb(null)).toBeNull()
  })
})

describe('format rows', () => {
  it('prefers the parser codec string over the collapsed column token', () => {
    const rows = buildFormatRows(
      track({ codec: 'mp3' }),
      detail({ codec: 'MPEG 1 Layer 3', container: 'MPEG', lossless: false }),
      FORMATS
    )
    expect(rowValue(rows, 'codec')).toBe('MPEG 1 Layer 3')
  })

  it('falls back to the indexed codec, upper-cased, before the parse lands', () => {
    const rows = buildFormatRows(track({ codec: 'flac' }), null, FORMATS)
    expect(rowValue(rows, 'codec')).toBe('FLAC')
  })

  it('omits a fact it does not have rather than rendering it unknown', () => {
    // An MP3 has no bit depth. That is not a failed read, and a row saying so
    // would be the pane inventing a gap in the file.
    const rows = buildFormatRows(
      track({ codec: 'mp3', bitDepth: null }),
      detail({ codec: 'MPEG 1 Layer 3', container: 'MPEG', lossless: false }),
      FORMATS
    )
    expect(rowKeys(rows)).not.toContain('bitDepth')
    expect(rows.every((row) => row.value !== '' && row.value !== 'unknown')).toBe(true)
  })

  it('still renders the indexed facts when the on-demand parse has not landed', () => {
    const rows = buildFormatRows(track(), null, FORMATS)
    expect(rowKeys(rows)).toEqual([
      'codec',
      'sampleRate',
      'bitDepth',
      'channels',
      'duration',
      'size'
    ])
  })

  it('notes the bitrate mode only when the file stated one', () => {
    const stated = buildFormatRows(
      track(),
      detail({ bitrateMode: 'variable', bitrateBps: 245_000 }),
      FORMATS
    )
    expect(stated.find((row) => row.key === 'bitrate')?.note).toBe('VBR')

    const silent = buildFormatRows(track(), detail({ bitrateMode: null }), FORMATS)
    expect(silent.find((row) => row.key === 'bitrate')?.note).toBeUndefined()
  })

  it('carries the encoder profile as the codec note', () => {
    const rows = buildFormatRows(
      track({ codec: 'mp3' }),
      detail({ codec: 'MPEG 1 Layer 3', codecProfile: 'V0', bitrateMode: 'variable' }),
      FORMATS
    )
    // `V0` and `VBR` are different facts — the encoder's setting and the
    // constancy it implies — so both rows earn their note.
    expect(rows.find((row) => row.key === 'codec')?.note).toBe('V0')
    expect(rows.find((row) => row.key === 'bitrate')?.note).toBe('VBR')
  })

  it('does not print CBR twice one line apart', () => {
    // A constant-bitrate MP3's profile *is* the word the bitrate row already
    // shows. Observed in the running app before this was dropped.
    const rows = buildFormatRows(
      track({ codec: 'mp3' }),
      detail({ codec: 'MPEG 1 Layer 3', codecProfile: 'CBR', bitrateMode: 'constant' }),
      FORMATS
    )
    expect(rows.find((row) => row.key === 'codec')?.note).toBeUndefined()
    expect(rows.find((row) => row.key === 'bitrate')?.note).toBe('CBR')
  })
})

describe('loudness', () => {
  it('says album gain is applied when album mode has one to apply', () => {
    const subject = track({ rgTrackGainDb: -7.1, rgAlbumGainDb: -6.2 })
    const decision = resolveNormalization(subject, normalizationPolicyForMode('album'))
    const readout = describeLoudness(decision)

    expect(readout.applied).toBe('album')
    expect(readout.summary).toContain('Album gain')

    const rows = buildReplayGainRows(subject, readout.applied)
    expect(rows.find((row) => row.key === 'rgAlbum')?.note).toBe('applied')
    expect(rows.find((row) => row.key === 'rgTrack')?.note).toBeUndefined()
  })

  it('reports the fallback the operator actually gets on an untagged track', () => {
    // The state the pane exists to expose: a mode is selected, the file carries
    // nothing, and the audible gain is the untagged fallback rather than the
    // mode's name.
    const subject = track()
    const decision = resolveNormalization(subject, normalizationPolicyForMode('album'))
    const readout = describeLoudness(decision)

    expect(readout.measured).toBe(false)
    expect(readout.applied).toBeNull()
    expect(readout.summary).toContain('No ReplayGain tags')
    expect(buildReplayGainRows(subject, readout.applied)).toHaveLength(0)
  })

  it('marks nothing applied when normalization is off, but still shows the measurements', () => {
    const subject = track({ rgTrackGainDb: -7.1, rgSource: 'computed' })
    const readout = describeLoudness(
      resolveNormalization(subject, normalizationPolicyForMode('off'))
    )

    expect(readout.applied).toBeNull()
    expect(readout.summary).toContain('Not normalized')

    const rows = buildReplayGainRows(subject, readout.applied)
    expect(rowValue(rows, 'rgTrack')).toBe('−7.10 dB')
    expect(rows.find((row) => row.key === 'rgTrack')?.note).toBeUndefined()
    expect(rowValue(rows, 'rgSource')).toBe('Computed by Fermata')
  })
})

describe('decode path', () => {
  function admit(input: Partial<Parameters<typeof decideR1Admission>[0]>, policy?: R1Policy) {
    return decideR1Admission(
      {
        trackId: 1,
        durationSec: 245,
        channels: 2,
        encodedBytes: 28_000_000,
        targetSampleRateHz: 48000,
        issuedNotFreedBytes: 0,
        reservedDecodeBytes: 0,
        ...input
      },
      policy ?? DEFAULT_R1_POLICY
    )
  }

  it('reads a decoded track as decoded, with no consequence to report', () => {
    const readout = describeDecodePath(admit({}), FORMATS)
    expect(readout.streaming).toBe(false)
    expect(readout.label).toBe('Decoded')
    expect(readout.consequence).toBeNull()
    expect(rowValue(readout.rows, 'boundary')).toBe('Sample-accurate')
  })

  it('explains a per-track cap fallback with both figures', () => {
    // A ninety-minute stereo track at 48 kHz decodes to about a gigabyte.
    const decision = admit(
      { durationSec: 90 * 60 },
      { ...DEFAULT_R1_POLICY, maxTrackDecodedBytes: 256 * MIB }
    )
    expect(decision.path).toBe('streaming')

    const readout = describeDecodePath(decision, FORMATS)
    expect(readout.streaming).toBe(true)
    expect(readout.label).toBe('Streaming')
    expect(readout.explanation).toContain('per-track cap')
    expect(readout.explanation).toContain('256 MiB')
    expect(readout.consequence).toContain('hard cut')
    expect(rowValue(readout.rows, 'boundary')).toBe('Hard')
  })

  it('explains a residency fallback against the shared budget', () => {
    const decision = admit(
      { issuedNotFreedBytes: 700 * MIB },
      { maxTrackDecodedBytes: 512 * MIB, maxDecodedResidencyBytes: 768 * MIB }
    )
    expect(decision.reason).toBe('residency-budget')

    const readout = describeDecodePath(decision, FORMATS)
    expect(readout.explanation).toContain('768 MiB')
    expect(readout.explanation).toContain('prefetched')
  })

  it('draws no meter for a track it could not price', () => {
    // Zero is a sentinel in `estimateDecodedBytes`, and an empty bar would read
    // as "this decode is free" — the opposite of what unpriceable means.
    const decision = admit({ durationSec: null })
    expect(decision.reason).toBe('unpriceable')

    const readout = describeDecodePath(decision, FORMATS)
    expect(readout.capFraction).toBeNull()
    expect(rowKeys(readout.rows)).not.toContain('estimate')
    expect(readout.explanation).toContain('could not be priced')
  })

  it('clamps the meter at the cap rather than overflowing it', () => {
    const readout = describeDecodePath(
      admit({ durationSec: 90 * 60 }, { ...DEFAULT_R1_POLICY, maxTrackDecodedBytes: 64 * MIB }),
      FORMATS
    )
    expect(readout.capFraction).toBe(1)
  })

  it('scales the meter against the cap for an admitted track', () => {
    const policy = { ...DEFAULT_R1_POLICY, maxTrackDecodedBytes: 256 * MIB }
    const decision = admit({ durationSec: 245 }, policy)
    const readout = describeDecodePath(decision, FORMATS)

    expect(readout.capFraction).toBeCloseTo(
      (decision.estimatedDecodedBytes ?? 0) / policy.maxTrackDecodedBytes,
      10
    )
    expect(readout.capFraction).toBeGreaterThan(0)
    expect(readout.capFraction).toBeLessThan(1)
  })
})
