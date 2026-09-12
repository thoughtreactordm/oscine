/**
 * Import a parametric EQ text profile into an {@link EqualizerSpec} — **W19-5+**.
 *
 * The format is the Equalizer APO / AutoEQ `ParametricEQ.txt` de-facto standard,
 * the one oratory1990 measurements and the whole AutoEq corpus are published in:
 *
 *   Preamp: -6.7 dB
 *   Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70
 *   Filter 3: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70
 *
 * It maps almost exactly onto our spec — a preamp plus typed biquad bands — so
 * this is a text transform, not a new audio path. It lives in `src/shared`
 * beside the settings validators because it produces the same `EqualizerSpec`
 * those guard, and because a bundled device library (a later card) will want to
 * parse the same files in the main process at build or load time.
 *
 * Two format realities the caller is told about through `warnings` rather than
 * silently swallowing:
 *
 *   - **The band pool is 12** ({@link EQUALIZER_BAND_LIMIT}). A longer profile is
 *     truncated to its first 12 filters — a real limit of the fixed biquad pool,
 *     not a parse failure.
 *   - **Shelves fix their slope.** Web Audio's `BiquadFilterNode` (and so our
 *     curve) ignores a shelf's Q and fixes S=1, while an APO shelf can carry a
 *     Q. The Q is read and stored so a round-trip keeps it, but the drawn and
 *     heard shelf is the S=1 one — imported shelves are close, not identical.
 *
 * Unsupported filter tokens (all-pass, band-pass, slope-stepped shelves) are
 * skipped with a warning rather than approximated into the wrong shape.
 */

import {
  EQUALIZER_BAND_LIMIT,
  EQUALIZER_FREQUENCY_MAX_HZ,
  EQUALIZER_FREQUENCY_MIN_HZ,
  EQUALIZER_GAIN_DB_LIMIT,
  EQUALIZER_Q_MAX,
  EQUALIZER_Q_MIN,
  type EqualizerBand,
  type EqualizerSpec
} from './equalizer'

/** APO/AutoEq filter tokens we can represent, mapped to our band types. */
const TYPE_BY_TOKEN: Readonly<Record<string, EqualizerBand['type']>> = {
  PK: 'peaking',
  PEQ: 'peaking',
  LS: 'lowshelf',
  LSC: 'lowshelf',
  LSQ: 'lowshelf',
  HS: 'highshelf',
  HSC: 'highshelf',
  HSQ: 'highshelf',
  LP: 'lowpass',
  LPQ: 'lowpass',
  HP: 'highpass',
  HPQ: 'highpass',
  NO: 'notch'
}

/** A parsed profile: the spec it maps to, plus what the caller should be told. */
export interface ParametricEqImport {
  readonly spec: EqualizerSpec
  /** How many filter lines became bands. */
  readonly filtersRead: number
  /** Human-readable notes: truncation, skipped filters, dropped values. */
  readonly warnings: readonly string[]
}

export interface ParseParametricEqOptions {
  /** Injected so a test can assert fixed ids; defaults to a real UUID. */
  newId?: () => string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function toFinite(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const PREAMP = /^\s*Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i
// "Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70" — Gain and Q are optional so a
// bare low/high-pass line still parses.
const FILTER =
  /^\s*Filter\s+\d+:\s*(ON|OFF)\s+([A-Za-z]+)\s+Fc\s+(-?\d+(?:\.\d+)?)\s*Hz(?:\s+Gain\s+(-?\d+(?:\.\d+)?)\s*dB)?(?:\s+Q\s+(-?\d+(?:\.\d+)?))?/i

/** A missing Q (a bare pass filter) defaults here — a mild, standard knee. */
const DEFAULT_Q = 0.707

/**
 * Parse an APO/AutoEq parametric profile, or `null` when the text carries no
 * preamp and no recognisable filter line — i.e. it is not one of these files.
 */
export function parseParametricEq(
  text: string,
  options: ParseParametricEqOptions = {}
): ParametricEqImport | null {
  const newId = options.newId ?? (() => crypto.randomUUID())
  const warnings: string[] = []

  let preampDb = 0
  let sawPreamp = false
  let sawFilterLine = false
  const bands: EqualizerBand[] = []
  let overflow = 0

  for (const line of text.split(/\r?\n/)) {
    const preampMatch = PREAMP.exec(line)
    if (preampMatch) {
      const value = toFinite(preampMatch[1])
      if (value === null) {
        warnings.push('Ignored a pre-amp value that was not a number.')
      } else {
        preampDb = clamp(value, -EQUALIZER_GAIN_DB_LIMIT, EQUALIZER_GAIN_DB_LIMIT)
        sawPreamp = true
      }
      continue
    }

    const filterMatch = FILTER.exec(line)
    if (!filterMatch) continue
    sawFilterLine = true

    const token = filterMatch[2].toUpperCase()
    const type = TYPE_BY_TOKEN[token]
    if (type === undefined) {
      warnings.push(`Skipped an unsupported filter type (${filterMatch[2]}).`)
      continue
    }

    const frequencyRaw = toFinite(filterMatch[3])
    if (frequencyRaw === null) {
      warnings.push('Skipped a filter with no readable frequency.')
      continue
    }

    if (bands.length >= EQUALIZER_BAND_LIMIT) {
      overflow += 1
      continue
    }

    const gainRaw = toFinite(filterMatch[4]) ?? 0
    const qRaw = toFinite(filterMatch[5]) ?? DEFAULT_Q
    bands.push({
      id: newId(),
      type,
      frequencyHz: clamp(frequencyRaw, EQUALIZER_FREQUENCY_MIN_HZ, EQUALIZER_FREQUENCY_MAX_HZ),
      gainDb: clamp(gainRaw, -EQUALIZER_GAIN_DB_LIMIT, EQUALIZER_GAIN_DB_LIMIT),
      q: clamp(qRaw, EQUALIZER_Q_MIN, EQUALIZER_Q_MAX),
      enabled: filterMatch[1].toUpperCase() === 'ON'
    })
  }

  if (!sawPreamp && !sawFilterLine) return null

  if (overflow > 0) {
    warnings.push(
      `Kept the first ${EQUALIZER_BAND_LIMIT} filters; ${overflow} beyond the band limit were dropped.`
    )
  }

  return {
    spec: { enabled: true, preampDb, bands },
    filtersRead: bands.length,
    warnings
  }
}
