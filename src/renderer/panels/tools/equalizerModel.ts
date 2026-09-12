import {
  EQUALIZER_BAND_LIMIT,
  EQUALIZER_BAND_TYPES,
  EQUALIZER_FREQUENCY_MAX_HZ,
  EQUALIZER_FREQUENCY_MIN_HZ,
  EQUALIZER_GAIN_DB_LIMIT,
  EQUALIZER_Q_MAX,
  EQUALIZER_Q_MIN,
  type EqualizerBand,
  type EqualizerSpec
} from '@shared/audio/equalizer'
import {
  MAX_DISPLAY_FREQUENCY_HZ,
  MIN_DISPLAY_FREQUENCY_HZ,
  fractionForFrequency,
  logFrequencyAt,
  responseCurveDb
} from '../../audio/eqResponse'

/**
 * The Tools EQ pane's pure half — **W19-4**.
 *
 * Everything the curve and the band table reason about that is not Vue: the
 * pointer-to-parameter mapping, the hit-test-friendly geometry, the add/remove/
 * update logic that keeps ids stable, the keyboard nudge, the SVG path builders
 * and the frame batcher. Kept out of the components the way `tagWritebackModel`
 * and `listViewport` are, so the geometry is asserted against numbers rather than
 * against the DOM (there is no DOM harness in this repo).
 *
 * The x-axis mapping is not re-derived here: it goes through `logFrequencyAt` /
 * `fractionForFrequency` from W19-2, so the drawn curve and the hit-testing that
 * drops a handle on it read the same endpoints and can never drift. Likewise the
 * curve itself comes back through `responseCurveDb`, the one place a biquad's
 * magnitude is computed, so the picture cannot disagree with the sound.
 */

const MIN_HZ = MIN_DISPLAY_FREQUENCY_HZ
const MAX_HZ = MAX_DISPLAY_FREQUENCY_HZ

/** The dB half-range the plot shows by default: ±12 dB, the everyday tone shape. */
export const DEFAULT_DISPLAY_GAIN_DB = 12
/** The wide range for the operator cutting a room mode: ±24 dB, the node's own bound. */
export const WIDE_DISPLAY_GAIN_DB = 24
/** The two ranges the ±12 / ±24 toggle switches between. */
export const DISPLAY_GAIN_RANGES: readonly number[] = [
  DEFAULT_DISPLAY_GAIN_DB,
  WIDE_DISPLAY_GAIN_DB
]

/** A fresh band's Q — one octave-ish, wide enough to be obviously audible when dragged. */
export const DEFAULT_BAND_Q = 1
/** A fresh band's type; the one gesture (double-click) can only sensibly add a peak. */
export const DEFAULT_BAND_TYPE: EqualizerBand['type'] = 'peaking'

/** Points in a drawn curve. ~256 as the card asks: dense enough to read, cheap to recompute per frame. */
export const CURVE_POINTS = 256

/**
 * The colours the plot draws with, every one a `var(--ui-*)` token and never a
 * literal — this is the M5 criterion made concrete. The components bind these,
 * so a theme swap changes what the tokens resolve to with zero component change,
 * and `equalizerModel.test.ts` asserts the whole table stays token-only.
 */
export const EQ_PALETTE = Object.freeze({
  /** The composite response line. */
  curveStroke: 'var(--ui-primary)',
  /** The composite fill under the line (opacity is set on the element, not here). */
  curveFill: 'var(--ui-primary)',
  /** One band's translucent fill. */
  bandFill: 'var(--ui-primary)',
  /** A draggable handle. */
  handle: 'var(--ui-primary)',
  /** The ring that lifts a handle off the curve behind it. */
  handleRing: 'var(--ui-bg)',
  /** The band numeral drawn inside a handle. */
  handleLabel: 'var(--ui-bg)',
  /** A bypassed band's handle and curve. */
  disabled: 'var(--ui-text-dimmed)',
  /** Minor gridlines. */
  gridLine: 'var(--ui-border)',
  /** The 0 dB line and decade lines. */
  gridLineStrong: 'var(--ui-border-accented)',
  /** Axis tick labels. */
  axisLabel: 'var(--ui-text-dimmed)',
  /** The raw track spectrum backdrop. */
  spectrumRaw: 'var(--ui-text-dimmed)',
  /** The spectrum after the curve has shaped it — the curve's influence. */
  spectrumShaped: 'var(--ui-primary)'
})

/** The human name each filter type wears in the table's type select and the aria text. */
export const FILTER_TYPE_LABELS: Readonly<Record<EqualizerBand['type'], string>> = Object.freeze({
  peaking: 'Peak',
  lowshelf: 'Low shelf',
  highshelf: 'High shelf',
  lowpass: 'Low-pass',
  highpass: 'High-pass',
  notch: 'Notch'
})

/** Types whose gain the node ignores — the table greys the gain cell for these. */
const GAINLESS_TYPES: ReadonlySet<EqualizerBand['type']> = new Set(['lowpass', 'highpass', 'notch'])

/** Whether a band's `gainDb` reaches the filter, or is inert for its type. */
export function typeUsesGain(type: EqualizerBand['type']): boolean {
  return !GAINLESS_TYPES.has(type)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** A frequency held inside the node's audible clamp, `[20, 20000]`. */
export function clampFrequency(frequencyHz: number): number {
  return clamp(frequencyHz, EQUALIZER_FREQUENCY_MIN_HZ, EQUALIZER_FREQUENCY_MAX_HZ)
}

/** A gain held inside the node's clamp, `±24`. */
export function clampGain(gainDb: number): number {
  return clamp(gainDb, -EQUALIZER_GAIN_DB_LIMIT, EQUALIZER_GAIN_DB_LIMIT)
}

/** A Q held inside the node's clamp, `[0.1, 18]`. */
export function clampQ(q: number): number {
  return clamp(q, EQUALIZER_Q_MIN, EQUALIZER_Q_MAX)
}

// ── Plot geometry and the axis mappings ────────────────────────────────────

/**
 * The inner plot rectangle, in pixels. `x` runs `0..width` left-to-right from
 * {@link MIN_DISPLAY_FREQUENCY_HZ} to {@link MAX_DISPLAY_FREQUENCY_HZ} on a log
 * axis; `y` runs `0..height` top-to-bottom from `+maxGainDb` to `-maxGainDb` on
 * a linear axis. The component draws this group offset by its axis margins; the
 * mappings work in this local space so they can be tested without a layout.
 */
export interface PlotGeometry {
  readonly width: number
  readonly height: number
  /** The dB half-range shown; `y` spans `[-maxGainDb, +maxGainDb]`. */
  readonly maxGainDb: number
}

/** Where a frequency sits on the x-axis, clamped to the plot. */
export function xForFrequency(frequencyHz: number, geometry: PlotGeometry): number {
  const fraction = clamp(fractionForFrequency(frequencyHz, MIN_HZ, MAX_HZ), 0, 1)
  return fraction * geometry.width
}

/** The frequency at an x pixel, clamped to the audible axis. */
export function frequencyForX(x: number, geometry: PlotGeometry): number {
  const fraction = geometry.width <= 0 ? 0 : clamp(x / geometry.width, 0, 1)
  return logFrequencyAt(fraction, MIN_HZ, MAX_HZ)
}

/** Where a gain sits on the y-axis (0 at top = `+maxGainDb`), clamped to the plot. */
export function yForGain(gainDb: number, geometry: PlotGeometry): number {
  const span = 2 * geometry.maxGainDb
  const fraction = span <= 0 ? 0.5 : clamp((geometry.maxGainDb - gainDb) / span, 0, 1)
  return fraction * geometry.height
}

/** The gain at a y pixel, clamped to the displayed range. */
export function gainForY(y: number, geometry: PlotGeometry): number {
  const fraction = geometry.height <= 0 ? 0 : clamp(y / geometry.height, 0, 1)
  return geometry.maxGainDb - fraction * 2 * geometry.maxGainDb
}

/** A frequency/gain pair a band would take at a pointer position, clamped to the plot edges. */
export interface BandParams {
  readonly frequencyHz: number
  readonly gainDb: number
}

/**
 * What dragging a handle to `(x, y)` sets: frequency from x, gain from y, both
 * clamped so a handle dragged past an edge stops at it rather than escaping the
 * plot. Q is untouched — it is the wheel/shift-drag gesture, not this one.
 */
export function pointerToParams(x: number, y: number, geometry: PlotGeometry): BandParams {
  return { frequencyHz: frequencyForX(x, geometry), gainDb: gainForY(y, geometry) }
}

// ── Band add / remove / update, all id-stable and immutable ────────────────

/** The outcome of a double-click add: a new spec, or the reason nothing was added. */
export type AddBandOutcome =
  | { readonly ok: true; readonly spec: EqualizerSpec; readonly bandId: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Add a peaking band at a pointer position, up to {@link EQUALIZER_BAND_LIMIT}.
 *
 * Past the limit it returns a reason rather than silently dropping the click —
 * the card's rule, because a double-click that does nothing with no word is a
 * bug report waiting to happen. The id is generated once here; `newId` is
 * injected so a test can assert against fixed ids.
 */
export function addBandAtPoint(
  spec: EqualizerSpec,
  x: number,
  y: number,
  geometry: PlotGeometry,
  newId: () => string
): AddBandOutcome {
  if (spec.bands.length >= EQUALIZER_BAND_LIMIT) {
    return { ok: false, reason: `The band pool is full — ${EQUALIZER_BAND_LIMIT} is the maximum.` }
  }
  const { frequencyHz, gainDb } = pointerToParams(x, y, geometry)
  const band: EqualizerBand = {
    id: newId(),
    type: DEFAULT_BAND_TYPE,
    frequencyHz,
    gainDb,
    q: DEFAULT_BAND_Q,
    enabled: true
  }
  return { ok: true, spec: { ...spec, bands: [...spec.bands, band] }, bandId: band.id }
}

/** A partial edit to one band, from the table's inputs or a drag. */
export type BandPatch = Partial<
  Pick<EqualizerBand, 'type' | 'frequencyHz' | 'gainDb' | 'q' | 'enabled'>
>

/**
 * Apply a patch to a band, clamping numbers and dropping non-finite ones.
 *
 * A non-finite field is *ignored*, not written: the table's text inputs can
 * produce a `NaN` mid-keystroke, and a `NaN` reaching `audio.eq.active` fails the
 * settings validator and drops the whole curve to flat — losing every other band
 * the operator built. Better to keep the last good value until they finish
 * typing a real one.
 */
function applyPatch(band: EqualizerBand, patch: BandPatch): EqualizerBand {
  const next: EqualizerBand = { ...band }
  if (patch.type !== undefined && EQUALIZER_BAND_TYPES.includes(patch.type)) next.type = patch.type
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  if (patch.frequencyHz !== undefined && Number.isFinite(patch.frequencyHz)) {
    next.frequencyHz = clampFrequency(patch.frequencyHz)
  }
  if (patch.gainDb !== undefined && Number.isFinite(patch.gainDb)) {
    next.gainDb = clampGain(patch.gainDb)
  }
  if (patch.q !== undefined && Number.isFinite(patch.q)) next.q = clampQ(patch.q)
  return next
}

/** A new spec with one band patched; other bands, and their ids, untouched. */
export function updateBand(spec: EqualizerSpec, id: string, patch: BandPatch): EqualizerSpec {
  return {
    ...spec,
    bands: spec.bands.map((band) => (band.id === id ? applyPatch(band, patch) : band))
  }
}

/** A new spec with one band removed; the survivors keep their ids (W19-3 keys on them). */
export function removeBand(spec: EqualizerSpec, id: string): EqualizerSpec {
  return { ...spec, bands: spec.bands.filter((band) => band.id !== id) }
}

/** A new spec with one band's `enabled` flipped — alt-click / per-band bypass. */
export function toggleBand(spec: EqualizerSpec, id: string): EqualizerSpec {
  return {
    ...spec,
    bands: spec.bands.map((band) => (band.id === id ? { ...band, enabled: !band.enabled } : band))
  }
}

/** A flat spec: no bands, no pre-amp. Reset-to-flat; the master enable is left alone. */
export function flattenedSpec(spec: EqualizerSpec): EqualizerSpec {
  return { ...spec, preampDb: 0, bands: [] }
}

// ── Keyboard and wheel nudges ──────────────────────────────────────────────

/** Coarse arrow step for gain, in dB. */
export const COARSE_GAIN_STEP_DB = 1
/** Fine (shift-arrow) step for gain, in dB. */
export const FINE_GAIN_STEP_DB = 0.1
/** Coarse arrow step for frequency, as a fraction of the log axis (uniform on screen). */
export const COARSE_FREQ_STEP_FRACTION = 0.02
/** Fine (shift-arrow) step for frequency, as a fraction of the log axis. */
export const FINE_FREQ_STEP_FRACTION = 0.005
/** One wheel notch multiplies Q by this (or its inverse). */
export const Q_WHEEL_FACTOR = 1.15
/** Vertical pixels of a shift-drag that double Q. */
export const Q_DRAG_PX_PER_DOUBLING = 120

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

/** Whether a key is one of the four the focused handle answers to. */
export function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}

/**
 * The frequency/gain a focused handle takes when an arrow is pressed. Up/down
 * move gain (clamped to the displayed range so the handle stays visible),
 * left/right move frequency by a fixed fraction of the log axis so a step looks
 * the same width everywhere. `fine` is the shift modifier.
 */
export function nudgeBandParams(
  band: EqualizerBand,
  key: ArrowKey,
  fine: boolean,
  geometry: PlotGeometry
): BandParams {
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const step = (fine ? FINE_GAIN_STEP_DB : COARSE_GAIN_STEP_DB) * (key === 'ArrowUp' ? 1 : -1)
    return {
      frequencyHz: band.frequencyHz,
      gainDb: clamp(band.gainDb + step, -geometry.maxGainDb, geometry.maxGainDb)
    }
  }
  const stepFraction =
    (fine ? FINE_FREQ_STEP_FRACTION : COARSE_FREQ_STEP_FRACTION) * (key === 'ArrowRight' ? 1 : -1)
  const fraction = clamp(
    fractionForFrequency(band.frequencyHz, MIN_HZ, MAX_HZ) + stepFraction,
    0,
    1
  )
  return { frequencyHz: logFrequencyAt(fraction, MIN_HZ, MAX_HZ), gainDb: band.gainDb }
}

/** Q after a wheel notch: `direction >= 0` widens (raises Q), `< 0` narrows. */
export function adjustQ(q: number, direction: number): number {
  const factor = direction >= 0 ? Q_WHEEL_FACTOR : 1 / Q_WHEEL_FACTOR
  return clampQ(q * factor)
}

/** Q from a shift-drag: dragging up (negative `deltaYpx`) raises Q, multiplicatively. */
export function qFromDrag(startQ: number, deltaYpx: number): number {
  const doublings = -deltaYpx / Q_DRAG_PX_PER_DOUBLING
  return clampQ(startQ * Math.pow(2, doublings))
}

// ── Display formatting ─────────────────────────────────────────────────────

const MINUS = '−'

/** A frequency as the table and handles show it: `320 Hz`, `3.20 kHz`, `12.5 kHz`. */
export function formatFrequency(frequencyHz: number): string {
  if (frequencyHz >= 1000) {
    const khz = frequencyHz / 1000
    return `${khz.toFixed(khz < 10 ? 2 : 1)} kHz`
  }
  return `${Math.round(frequencyHz)} Hz`
}

/** A gain with an explicit sign and a true minus glyph: `+3.0 dB`, `${MINUS}4.5 dB`, `0.0 dB`. */
export function formatGain(gainDb: number): string {
  const rounded = Number(gainDb.toFixed(1))
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : ''
  return `${sign}${Math.abs(rounded).toFixed(1)} dB`
}

/** A Q to two places: `2.10`. */
export function formatQ(q: number): string {
  return q.toFixed(2)
}

/**
 * A band read aloud for `aria-valuetext`: type, frequency, gain (only where the
 * type uses it), Q, and whether it is bypassed. Q leads the spoken value because
 * it is the parameter operators understand least and a silent change is the trap.
 */
export function bandAriaValueText(band: EqualizerBand): string {
  const parts: string[] = [FILTER_TYPE_LABELS[band.type], formatFrequency(band.frequencyHz)]
  if (typeUsesGain(band.type)) parts.push(formatGain(band.gainDb))
  parts.push(`Q ${formatQ(band.q)}`)
  if (!band.enabled) parts.push('bypassed')
  return parts.join(', ')
}

/** The preset name a select shows, marked when the live curve has drifted from it. */
export function presetDisplayName(name: string, dirty: boolean): string {
  return dirty ? `${name} (modified)` : name
}

// ── The drawn curve ────────────────────────────────────────────────────────

/**
 * The composite response over the display axis, always computed as if enabled so
 * the designed curve is drawn even while the master is bypassed for an A/B — the
 * component dims the plot for that state rather than flattening it, which would
 * make the compare toggle jump the curve every press. Individual bands still
 * gate on their own `enabled`.
 *
 * The pre-amp (R11) is excluded: it is a uniform level offset, not part of the
 * *shape*, and folding it in would slide the composite line off the handles and
 * band fills — which are drawn at their own 0-referenced gains — so lowering the
 * pre-amp would visually tear the curve away from everything it describes. The
 * pre-amp's effect is read numerically and by the clip indicator instead.
 */
export function compositeCurve(
  spec: EqualizerSpec,
  sampleRateHz: number,
  points = CURVE_POINTS
): Float32Array {
  return responseCurveDb(
    { ...spec, enabled: true, preampDb: 0 },
    sampleRateHz,
    points,
    MIN_HZ,
    MAX_HZ
  )
}

/**
 * One band's own response, drawn regardless of its `enabled` (a bypassed band is
 * still shown, dimmed, so the operator can see the shape they turned off). Goes
 * through the same {@link responseCurveDb} as the composite so the two agree.
 */
export function bandCurve(
  band: EqualizerBand,
  sampleRateHz: number,
  points = CURVE_POINTS
): Float32Array {
  return responseCurveDb(
    { enabled: true, preampDb: 0, bands: [{ ...band, enabled: true }] },
    sampleRateHz,
    points,
    MIN_HZ,
    MAX_HZ
  )
}

/** The x pixel of curve sample `index` of `count`, spread across the plot width. */
function xForSample(index: number, count: number, geometry: PlotGeometry): number {
  const fraction = count <= 1 ? 0 : index / (count - 1)
  return fraction * geometry.width
}

/** An open polyline `d` for a curve — the composite stroke. */
export function curvePath(curve: Float32Array, geometry: PlotGeometry): string {
  if (curve.length === 0) return ''
  let d = ''
  for (let i = 0; i < curve.length; i++) {
    const x = xForSample(i, curve.length, geometry)
    const y = yForGain(curve[i], geometry)
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `
  }
  return d.trimEnd()
}

/**
 * A closed `d` for a spectrum: a filled area from the plot floor up to each
 * point's level. `valuesDb` is scaled by its own `[floorDb, ceilDb]` window, not
 * the EQ's ±dB axis — the spectrum is a backdrop reference, so it fills the plot
 * regardless of the gain scale the curve is drawn against.
 */
export function spectrumAreaPath(
  valuesDb: Float32Array,
  floorDb: number,
  ceilDb: number,
  geometry: PlotGeometry
): string {
  const count = valuesDb.length
  if (count === 0 || geometry.width <= 0) return ''
  const span = ceilDb - floorDb
  const yFor = (db: number): number => {
    const norm = span <= 0 ? 0 : clamp((db - floorDb) / span, 0, 1)
    return geometry.height * (1 - norm)
  }
  let d = `M0 ${geometry.height.toFixed(2)} `
  for (let i = 0; i < count; i++) {
    d += `L${xForSample(i, count, geometry).toFixed(2)} ${yFor(valuesDb[i]).toFixed(2)} `
  }
  d += `L${geometry.width.toFixed(2)} ${geometry.height.toFixed(2)} Z`
  return d
}

/** A closed `d` filling the area between a curve and the 0 dB line — a band fill. */
export function curveAreaPath(curve: Float32Array, geometry: PlotGeometry): string {
  if (curve.length === 0) return ''
  const baseline = yForGain(0, geometry)
  const first = xForSample(0, curve.length, geometry)
  const last = xForSample(curve.length - 1, curve.length, geometry)
  let d = `M${first.toFixed(2)} ${baseline.toFixed(2)} `
  for (let i = 0; i < curve.length; i++) {
    const x = xForSample(i, curve.length, geometry)
    const y = yForGain(curve[i], geometry)
    d += `L${x.toFixed(2)} ${y.toFixed(2)} `
  }
  d += `L${last.toFixed(2)} ${baseline.toFixed(2)} Z`
  return d
}

// ── Axis gridlines ─────────────────────────────────────────────────────────

/** A vertical frequency gridline: its position and, at a decade tick, its label. */
export interface FrequencyGridLine {
  readonly frequencyHz: number
  readonly x: number
  readonly label: string | null
}

const LABELED_FREQUENCIES: ReadonlySet<number> = new Set([
  20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000
])

/** The frequency gridlines across the plot: 1-2-3…-9 per decade, decades labelled. */
export function frequencyGridLines(geometry: PlotGeometry): FrequencyGridLine[] {
  const lines: FrequencyGridLine[] = []
  const seen = new Set<number>()
  for (const decade of [10, 100, 1000, 10000]) {
    for (let multiple = 1; multiple <= 9; multiple++) {
      const frequencyHz = decade * multiple
      if (frequencyHz < MIN_HZ || frequencyHz > MAX_HZ || seen.has(frequencyHz)) continue
      seen.add(frequencyHz)
      lines.push({
        frequencyHz,
        x: xForFrequency(frequencyHz, geometry),
        label: LABELED_FREQUENCIES.has(frequencyHz) ? formatFrequency(frequencyHz) : null
      })
    }
  }
  return lines
}

/** A horizontal dB gridline: its gain, its y, and its label. */
export interface GainGridLine {
  readonly gainDb: number
  readonly y: number
  readonly label: string
}

/** The dB gridlines: `0` and two steps either side of it, at `maxGainDb / 2`. */
export function gainGridLines(geometry: PlotGeometry): GainGridLine[] {
  const step = geometry.maxGainDb / 2
  const lines: GainGridLine[] = []
  for (let gainDb = geometry.maxGainDb; gainDb >= -geometry.maxGainDb; gainDb -= step) {
    lines.push({ gainDb, y: yForGain(gainDb, geometry), label: formatGain(gainDb) })
  }
  return lines
}

// ── Per-frame batching ─────────────────────────────────────────────────────

/** A one-callback-per-frame batcher — a burst of `request()`s runs `run` once. */
export interface RafBatch {
  /** Schedule `run` for the next frame if one is not already pending. */
  request(): void
  /** Run `run` now, cancelling any pending frame. */
  flush(): void
  /** Drop a pending frame without running. */
  cancel(): void
  /** Whether a frame is currently scheduled. */
  readonly pending: boolean
}

/**
 * Coalesce redraws to the display refresh: a drag fires pointer moves far faster
 * than the screen updates, and the curve is ~256 points, so `request()` on every
 * move but `run` at most once per frame. `raf`/`caf` are injected rather than
 * defaulted so this module stays free of DOM globals — it is unit-tested under
 * plain Node, where `requestAnimationFrame` neither exists nor has a type.
 */
export function createRafBatch(
  run: () => void,
  raf: (cb: () => void) => number,
  caf: (handle: number) => void
): RafBatch {
  let handle: number | null = null
  return {
    request(): void {
      if (handle !== null) return
      handle = raf(() => {
        handle = null
        run()
      })
    },
    flush(): void {
      if (handle !== null) {
        caf(handle)
        handle = null
      }
      run()
    },
    cancel(): void {
      if (handle !== null) {
        caf(handle)
        handle = null
      }
    },
    get pending(): boolean {
      return handle !== null
    }
  }
}
