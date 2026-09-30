/**
 * The equalizer's shared vocabulary: the spec a curve is, the preset a saved
 * one is, and the pure validators that guard a stored blob on its way back in.
 *
 * These types were born in the renderer's `audio/equalizer.ts` router (W19-1),
 * but a stored `EqualizerSpec` reaches an audio graph through a settings key,
 * and settings validation lives in `src/shared`. So the shape moves here and the
 * router re-exports it — the router still owns applying a spec to Web Audio, this
 * module owns saying what a spec *is* and refusing one that is not.
 *
 * The validators are the load-bearing part. A hand-edited or version-skewed blob
 * is the input, and the output feeds biquads: reject on structure (wrong shape
 * falls back to the descriptor default), clamp on range (a `gainDb` of 400
 * becomes 24), and refuse a non-finite number outright rather than clamping a
 * `NaN` into a real gain. The renderer's router clamps again at the device — the
 * two are not redundant: this layer protects the stored value, the router
 * protects the hardware.
 *
 * Nothing here imports Web Audio or the renderer, so main and renderer both use
 * it: main to validate what it loads from SQLite, the renderer to push it.
 */

export interface EqualizerBand {
  /** Stable; survives reorder, and is what per-entity assignment would reference. */
  id: string
  type: 'peaking' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'notch'
  /** Clamped to 20 .. min(20000, nyquist) at the node. */
  frequencyHz: number
  /** Clamped to ±24; ignored by lowpass/highpass/notch. */
  gainDb: number
  /** Clamped to 0.1 .. 18. */
  q: number
  enabled: boolean
}

export interface EqualizerSpec {
  enabled: boolean
  preampDb: number
  bands: readonly EqualizerBand[]
}

/**
 * A saved curve, recalled by name.
 *
 * The id is the forward-compatibility move. W19-6 will let an operator assign a
 * preset to a genre, artist, album or playlist — the moment that lands a preset
 * stops being a value and becomes a referenced entity. Given a stable id now,
 * that follow-on is one new cascading key with zero data migration; without it,
 * it is a blob migration to add identity to records already in operators'
 * installs. Renaming must not break a reference, which is exactly why the id is
 * generated once and never derived from the name.
 */
export interface EqualizerPreset {
  /** Stable, generated once, never derived from the name. */
  id: string
  name: string
  spec: EqualizerSpec
}

/** The biquad pool is fixed at this size; the spec can carry no more bands. */
export const EQUALIZER_BAND_LIMIT = 12

/** The band `type` values, as a runtime list the validator can test against. */
export const EQUALIZER_BAND_TYPES: readonly EqualizerBand['type'][] = [
  'peaking',
  'lowshelf',
  'highshelf',
  'lowpass',
  'highpass',
  'notch'
]

/** ±24 dB, the bound the router clamps band gain and pre-amp to at the node. */
export const EQUALIZER_GAIN_DB_LIMIT = 24
/** The audible band a biquad centre may sit in, matching the router's clamp. */
export const EQUALIZER_FREQUENCY_MIN_HZ = 20
export const EQUALIZER_FREQUENCY_MAX_HZ = 20000
/** The Q range a biquad accepts, matching the router's clamp. */
export const EQUALIZER_Q_MIN = 0.1
export const EQUALIZER_Q_MAX = 18

/**
 * Off, no gain, no bands. The default, and why the settings this validates
 * change nothing audible until an operator touches them: a flat, disabled spec
 * ramps the chain to its dry path and the biquads never enter the signal.
 */
export const FLAT_EQUALIZER_SPEC: EqualizerSpec = Object.freeze({
  enabled: false,
  preampDb: 0,
  bands: Object.freeze([]) as readonly EqualizerBand[]
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * A finite number clamped into range, or `null` if it is not a finite number.
 *
 * The split the card draws: an out-of-range but finite value is a decision the
 * operator can express and we honour by clamping; a `NaN` or `Infinity` is a
 * broken blob, so the caller rejects the whole thing rather than inventing a gain.
 */
function finiteInRange(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return clamp(raw, min, max)
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
}

/** One band, or `null` if its shape is wrong or any number is not finite. */
export function parseEqualizerBand(raw: unknown): EqualizerBand | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.enabled !== 'boolean') return null
  if (
    typeof raw.type !== 'string' ||
    !EQUALIZER_BAND_TYPES.includes(raw.type as EqualizerBand['type'])
  ) {
    return null
  }
  const frequencyHz = finiteInRange(
    raw.frequencyHz,
    EQUALIZER_FREQUENCY_MIN_HZ,
    EQUALIZER_FREQUENCY_MAX_HZ
  )
  const gainDb = finiteInRange(raw.gainDb, -EQUALIZER_GAIN_DB_LIMIT, EQUALIZER_GAIN_DB_LIMIT)
  const q = finiteInRange(raw.q, EQUALIZER_Q_MIN, EQUALIZER_Q_MAX)
  if (frequencyHz === null || gainDb === null || q === null) return null
  return {
    id: raw.id,
    type: raw.type as EqualizerBand['type'],
    frequencyHz,
    gainDb,
    q,
    enabled: raw.enabled
  }
}

/**
 * A whole spec, or `null` if any part of it is structurally wrong.
 *
 * A single malformed band, a non-finite number, a thirteenth band, or a missing
 * field takes the whole spec down to `null` — the settings layer then falls back
 * to flat. That is deliberate: a partially-applied EQ curve is a worse outcome
 * than a flat one the operator can see is flat.
 */
export function parseEqualizerSpec(raw: unknown): EqualizerSpec | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.enabled !== 'boolean') return null
  const preampDb = finiteInRange(raw.preampDb, -EQUALIZER_GAIN_DB_LIMIT, EQUALIZER_GAIN_DB_LIMIT)
  if (preampDb === null) return null
  if (!Array.isArray(raw.bands)) return null
  if (raw.bands.length > EQUALIZER_BAND_LIMIT) return null
  const bands: EqualizerBand[] = []
  for (const rawBand of raw.bands) {
    const band = parseEqualizerBand(rawBand)
    if (band === null) return null
    bands.push(band)
  }
  return { enabled: raw.enabled, preampDb, bands }
}

/** One preset, or `null` if its identity or its spec is malformed. */
export function parseEqualizerPreset(raw: unknown): EqualizerPreset | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.name !== 'string') return null
  const spec = parseEqualizerSpec(raw.spec)
  if (spec === null) return null
  return { id: raw.id, name: raw.name, spec }
}

/**
 * The presets array, or `null` only when the blob is not an array at all.
 *
 * A single bad preset is dropped, not fatal — the same choice `recordValue`
 * makes in the settings kernel, and for the same reason: one corrupt record must
 * not cost the operator every other preset they saved. A non-array is a shape
 * error, so it rejects to the empty default.
 */
export function parseEqualizerPresets(raw: unknown): EqualizerPreset[] | null {
  if (!Array.isArray(raw)) return null
  const presets: EqualizerPreset[] = []
  for (const rawPreset of raw) {
    const preset = parseEqualizerPreset(rawPreset)
    if (preset !== null) presets.push(preset)
  }
  return presets
}
