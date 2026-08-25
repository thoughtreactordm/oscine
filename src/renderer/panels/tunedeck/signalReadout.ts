import type { Track, TrackFormatDetail } from '@shared/library'
import type { NormalizationDecision } from '../../audio/normalization'
import type { R1AdmissionDecision } from '../../audio/r1Admission'

/**
 * Everything the signal pane says, as data.
 *
 * No Vue and no DOM, and relative imports throughout, for the reason stated at
 * the top of `upNextRows.ts`: `tests/` compiles under `tsconfig.node.json`,
 * which maps no `@renderer`. Which matters more here than anywhere else in the
 * pane — this file is the whole of what the readout *claims*, and a claim is
 * worth testing. The component above it is a `v-for` over what comes out here.
 *
 * ## The one rule
 *
 * **A fact we do not have is not a row.** W7-3's acceptance says nothing may
 * render as "unknown" that the parser actually provides, and the honest reading
 * of that goes further than filling in the gaps: an MP3 has no bit depth, and
 * `Bit depth —` says "we failed to read it" about a field that does not exist.
 * So rows are built only for facts in hand, and the pane's height varies by
 * format. That is a readout doing its job, not a layout bug.
 *
 * The two blocks that *are* fixed — loudness and the decode path — always
 * render, because their absence is itself the thing being reported.
 */

export interface SignalRow {
  /** Stable within one readout; keys the list. */
  key: string
  label: string
  value: string
  /** Drawn dimmer, after the value. The qualifier, not the fact. */
  note?: string
}

/**
 * The two formatters that are an operator preference rather than this module's
 * business.
 *
 * Passed in rather than imported so a readout size reads the same as the track
 * list's size column — binary or decimal is W8-4's key, and a pane that hard-
 * coded MiB would be the one place in the app that ignored it. The pane binds
 * these to `useDisplayFormatStore`; the tests bind them to something trivial,
 * which is the other half of why they are a parameter.
 */
export interface ReadoutFormats {
  duration: (seconds: number | null) => string
  size: (bytes: number | null) => string
}

/**
 * Sample rate in kHz, trailing zeros trimmed.
 *
 * `44.1`, `48`, `192` — not `44.100` and not `48.0`. The unit is what carries
 * the magnitude here and a fixed decimal place makes the common rates look
 * like measurements rather than like the two numbers everyone recognises.
 */
export function formatSampleRate(hz: number | null): string | null {
  if (hz === null || !Number.isFinite(hz) || hz <= 0) return null
  const khz = hz / 1000
  return `${Number(khz.toFixed(3))} kHz`
}

/** Bits per second as kbps, rounded. Below 1 kbps is a broken parse, not a file. */
export function formatBitrate(bps: number | null): string | null {
  if (bps === null || !Number.isFinite(bps) || bps < 1000) return null
  return `${Math.round(bps / 1000)} kbps`
}

/**
 * The conventional name for a channel count.
 *
 * A count is not a layout — 6 channels is 5.1 by overwhelming convention and by
 * nothing stronger, and a file could in principle carry six discrete mono stems.
 * These are the readings every other player shows, and the count is preserved
 * verbatim for anything outside the list rather than guessed at.
 */
export function formatChannels(count: number | null): string | null {
  if (count === null || !Number.isInteger(count) || count <= 0) return null
  switch (count) {
    case 1:
      return 'Mono'
    case 2:
      return 'Stereo'
    case 3:
      return '2.1'
    case 4:
      return 'Quadraphonic'
    case 6:
      return '5.1'
    case 8:
      return '7.1'
    default:
      return `${count} channels`
  }
}

/** A signed decibel figure, always with its sign. `+0.00 dB` is a measurement. */
export function formatGainDb(db: number | null): string | null {
  if (db === null || !Number.isFinite(db)) return null
  return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(2)} dB`
}

/** A ReplayGain peak, which is a linear ratio and reads best as one. */
function formatPeak(peak: number | null): string | null {
  if (peak === null || !Number.isFinite(peak) || peak <= 0) return null
  return peak.toFixed(4)
}

const BITRATE_MODE_LABEL = { constant: 'CBR', variable: 'VBR' } as const

/**
 * The format block.
 *
 * `detail` is `null` while the on-demand parse is in flight or after it failed,
 * and the rows degrade to what the index already holds rather than vanishing —
 * codec, sample rate, depth and channels are all columns, so the pane is never
 * empty while it waits. Container and bitrate simply arrive a moment later.
 *
 * Codec prefers the parser's own string over `Track.codec`: the column holds
 * `normaliseCodec`'s collapsed token, which is right for grouping a library and
 * wrong for a readout whose entire purpose is to say `MPEG 1 Layer 3` rather
 * than `mp3`. Upper-cased when it falls back, so a bare `flac` does not read as
 * a lowercase accident beside the parser's own capitalisation.
 */
export function buildFormatRows(
  track: Track,
  detail: TrackFormatDetail | null,
  formats: ReadoutFormats
): readonly SignalRow[] {
  const rows: SignalRow[] = []

  const mode = detail?.bitrateMode ?? null
  const modeLabel = mode === null ? null : BITRATE_MODE_LABEL[mode]

  const codec = detail?.codec ?? (track.codec === null ? null : track.codec.toUpperCase())
  if (codec !== null) {
    // The profile is the encoder's own word for how it was configured, and it is
    // the only place `V0` is ever recorded — so it earns the width when it says
    // something the bitrate row will not. When it says exactly the same word,
    // it does not: a CBR MP3 was printing `CBR` twice, one line apart. Dropped
    // here rather than there because the mode belongs beside the bitrate it
    // qualifies, and `V0` does not.
    const profile = detail?.codecProfile ?? null
    const redundant = profile !== null && modeLabel !== null && profile.toUpperCase() === modeLabel
    rows.push({
      key: 'codec',
      label: 'Codec',
      value: codec,
      ...(profile !== null && !redundant ? { note: profile } : {})
    })
  }

  if (detail?.container) {
    rows.push({
      key: 'container',
      label: 'Container',
      value: detail.container,
      ...(detail.lossless === null ? {} : { note: detail.lossless ? 'lossless' : 'lossy' })
    })
  }

  const bitrate = formatBitrate(detail?.bitrateBps ?? null)
  if (bitrate !== null) {
    rows.push({
      key: 'bitrate',
      label: 'Bitrate',
      value: bitrate,
      // Absent unless the file said so — see `bitrateMode` in the main-process
      // metadata adapter for why this is never inferred from file size.
      ...(modeLabel === null ? {} : { note: modeLabel })
    })
  }

  const sampleRate = formatSampleRate(track.sampleRateHz)
  if (sampleRate !== null) {
    rows.push({ key: 'sampleRate', label: 'Sample rate', value: sampleRate })
  }

  if (track.bitDepth !== null && track.bitDepth > 0) {
    rows.push({ key: 'bitDepth', label: 'Bit depth', value: `${track.bitDepth}-bit` })
  }

  const channels = formatChannels(track.channels)
  if (channels !== null) {
    rows.push({ key: 'channels', label: 'Channels', value: channels })
  }

  if (track.durationSec !== null) {
    rows.push({ key: 'duration', label: 'Duration', value: formats.duration(track.durationSec) })
  }

  if (track.encodedBytes > 0) {
    rows.push({ key: 'size', label: 'File size', value: formats.size(track.encodedBytes) })
  }

  if (detail?.tool) {
    rows.push({ key: 'tool', label: 'Encoder', value: detail.tool })
  }

  return rows
}

export interface LoudnessReadout {
  /** What the operator set. */
  mode: NormalizationDecision['mode']
  /** One line saying what is happening to this track, right now. */
  summary: string
  /** Which measurement won, or `null` when neither did. Marks the row. */
  applied: NormalizationDecision['field']
  /** True when the applied figure is this track's own measurement. */
  measured: boolean
  /** The limiter pulled the request down to keep the peak under unity. */
  peakLimited: boolean
}

/**
 * What is actually being done to this track's loudness.
 *
 * The card asks for "which mode is actually being applied right now", and the
 * mode alone does not answer it: album mode on a track with no album gain falls
 * back, and a track with no measurement at all gets the untagged fallback
 * instead of anything it carries. `resolveNormalization` already decides all of
 * that for the audible gain — this reads its answer rather than reasoning about
 * the policy a second time, so the pane cannot disagree with the audio.
 */
export function describeLoudness(decision: NormalizationDecision): LoudnessReadout {
  // `field` is not the answer on its own. `resolveNormalization` names the field
  // it *selected* — which is `'track'` even for a file with no track gain, so
  // that the peak it pairs with is the matching one — and then falls back when
  // that field turns out to be empty. `gainDb` is the load-bearing test: it is
  // non-null only when a real measurement is in force. Reading `field` alone
  // would put an "applied" badge on a row that does not exist.
  const measured = decision.gainDb !== null
  return {
    mode: decision.mode,
    summary: loudnessSummary(decision, measured),
    // `off` is not "no gain won" — it is "nothing was asked for", and marking a
    // row `applied` under it would claim a gain that is not being applied.
    applied: decision.mode === 'off' || !measured ? null : decision.field,
    measured,
    peakLimited: decision.peakLimited
  }
}

function loudnessSummary(decision: NormalizationDecision, measured: boolean): string {
  if (decision.mode === 'off') return 'Not normalized — the file plays at its recorded level.'

  const applied = formatGainDb(decision.requestedGainDb) ?? '+0.00 dB'
  if (!measured) return `No ReplayGain tags — the untagged fallback of ${applied} is applied.`
  // Named after the field that won rather than after the mode, because album
  // mode on a file with no album gain applies the track gain and saying "album"
  // there would be the exact confusion this pane exists to clear up.
  return decision.field === 'album'
    ? `Album gain, ${applied} applied.`
    : `Track gain, ${applied} applied.`
}

/**
 * The measurements the file carries, said separately from what is applied.
 *
 * Both are shown in both modes on purpose. "Album mode is on and this file has
 * only a track gain" is precisely the state an operator opens this pane to
 * discover, and hiding the value that is not in force makes it invisible.
 * `field` marks the one that won.
 */
export function buildReplayGainRows(
  track: Track,
  applied: NormalizationDecision['field']
): readonly SignalRow[] {
  const rows: SignalRow[] = []

  const trackGain = formatGainDb(track.rgTrackGainDb)
  if (trackGain !== null) {
    rows.push({
      key: 'rgTrack',
      label: 'Track gain',
      value: trackGain,
      ...(applied === 'track' ? { note: 'applied' } : {})
    })
  }

  const albumGain = formatGainDb(track.rgAlbumGainDb)
  if (albumGain !== null) {
    rows.push({
      key: 'rgAlbum',
      label: 'Album gain',
      value: albumGain,
      ...(applied === 'album' ? { note: 'applied' } : {})
    })
  }

  const trackPeak = formatPeak(track.rgTrackPeak)
  if (trackPeak !== null) {
    rows.push({ key: 'rgTrackPeak', label: 'Track peak', value: trackPeak })
  }

  const albumPeak = formatPeak(track.rgAlbumPeak)
  if (albumPeak !== null) {
    rows.push({ key: 'rgAlbumPeak', label: 'Album peak', value: albumPeak })
  }

  if (track.rgSource !== null && rows.length > 0) {
    rows.push({
      key: 'rgSource',
      label: 'Source',
      // D7: Oscine never writes tags, so a computed value lives in the
      // database and the file still says nothing. Worth distinguishing.
      value: track.rgSource === 'tag' ? 'File tags' : 'Computed by Oscine'
    })
  }

  return rows
}

export interface DecodePathReadout {
  streaming: boolean
  /** The headline: two words for the state the operator came here to check. */
  label: string
  /** Why it went that way, in one sentence. */
  explanation: string
  /** Consequence, not cause — what streaming costs at a boundary. */
  consequence: string | null
  rows: readonly SignalRow[]
  /**
   * Estimate as a fraction of the per-track cap, clamped to 1.
   *
   * `null` when the track could not be priced at all, which is a different
   * state from "priced at zero" and must not draw an empty meter as though the
   * decode were free.
   */
  capFraction: number | null
}

/**
 * R1's verdict, in words.
 *
 * This is the pane's reason to exist. A hard boundary where a gapless one was
 * expected has exactly one visible symptom — a gap — and until now the only
 * place the cause was written down was a `console.info` line in a devtools
 * session nobody has open. The four reasons are the guard's own enum, so this
 * cannot drift from what the guard decided: a new reason is a compile error
 * here, not a silently missing sentence.
 */
export function describeDecodePath(
  decision: R1AdmissionDecision,
  formats: ReadoutFormats
): DecodePathReadout {
  const streaming = decision.path === 'streaming'
  const estimate = decision.estimatedDecodedBytes
  const rows: SignalRow[] = []

  if (estimate !== null && estimate > 0) {
    rows.push({ key: 'estimate', label: 'Decoded size', value: formats.size(estimate) })
  }
  rows.push({
    key: 'cap',
    label: 'Per-track cap',
    value: formats.size(decision.maxTrackDecodedBytes)
  })
  if (decision.projectedResidencyBytes !== null) {
    rows.push({
      key: 'residency',
      label: 'Renderer residency',
      value: formats.size(decision.projectedResidencyBytes),
      note: `of ${formats.size(decision.maxDecodedResidencyBytes)}`
    })
  }
  rows.push({
    key: 'boundary',
    label: 'Boundary',
    // The two are not independent: only a decoded source can be joined
    // sample-accurately, so this is the visible consequence of the row above.
    value: decision.transitionPolicy === 'sample-accurate' ? 'Sample-accurate' : 'Hard'
  })

  return {
    streaming,
    label: streaming ? 'Streaming' : 'Decoded',
    explanation: decodeExplanation(decision, formats),
    consequence: streaming
      ? 'Gapless and crossfade need a decoded source, so this track joins its neighbours with a hard cut.'
      : null,
    rows,
    capFraction:
      estimate === null || estimate <= 0
        ? null
        : Math.min(1, estimate / decision.maxTrackDecodedBytes)
  }
}

function decodeExplanation(decision: R1AdmissionDecision, formats: ReadoutFormats): string {
  const estimate = decision.estimatedDecodedBytes
  switch (decision.reason) {
    case 'within-budget':
      return 'Decoded whole into memory, within R1’s budget.'
    case 'unpriceable':
      return 'Streaming: the file states no duration or channel count, so the decode could not be priced. An unknown cost is not a zero cost.'
    case 'per-track-cap':
      return `Streaming: an estimated ${estimate === null ? 'unknown size' : formats.size(estimate)} decoded is over the ${formats.size(decision.maxTrackDecodedBytes)} per-track cap.`
    case 'residency-budget':
      return `Streaming: decoding this would take the renderer to ${formats.size(decision.projectedResidencyBytes)}, past the ${formats.size(decision.maxDecodedResidencyBytes)} budget across the playing and prefetched tracks.`
  }
}
