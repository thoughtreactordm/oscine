import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, resolveTheme, type ThemeMode } from '@shared/theme'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import {
  FLASH_DARK_LIMIT,
  FLASH_LUMINANCE_DELTA,
  MAX_FLASHES_PER_SEC,
  MAX_RISE_PER_FRAME,
  MIN_ATTACK_SEC,
  MIN_SAMPLE_RATE_HZ,
  RECOVERY_HOLD_SEC,
  RECOVERY_PER_SEC,
  createFlashGuard,
  type FlashGuard
} from '../../../src/renderer/visualizer/flashGuard'
import {
  PALETTE_PROPERTIES,
  PaletteSlot,
  createPaletteModel
} from '../../../src/renderer/visualizer/palette'

const FPS = 60
const FRAME = 1 / FPS
/** The sparsest sampling the guard supports: every other frame at 60 fps. */
const SAMPLE_EVERY = FPS / MIN_SAMPLE_RATE_HZ

/** A hand-built analysis frame, so a test controls exactly what the guard is fed. */
function input(): AnalysisFrame & {
  bass: number
  mid: number
  treble: number
  level: number
  onset: number
} {
  return {
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(ANALYSIS_BANDS),
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    onset: 0,
    silent: false,
    timeSec: 0
  }
}

/**
 * The true luminance's flashes, counted independently of the guard and to the
 * letter of WCAG 2.3.1 with no safety margin: a flash is a rise of at least 10 %
 * followed by a fall of at least 10 %, with the darker end under 0.8. Returns
 * the frame each flash completed on.
 */
function flashTimes(trace: readonly number[]): number[] {
  const times: number[] = []
  let trough = trace[0] ?? 0
  let peak = trough
  let rising = false
  trace.forEach((y, frame) => {
    if (!rising) {
      if (y < trough) trough = y
      if (y - trough >= FLASH_LUMINANCE_DELTA) {
        rising = true
        peak = y
      }
    } else {
      if (y > peak) peak = y
      if (peak - y >= FLASH_LUMINANCE_DELTA) {
        if (Math.min(trough, y) < FLASH_DARK_LIMIT) times.push(frame)
        rising = false
        trough = y
      }
    }
  })
  return times
}

/** The most flashes in any one-second window. */
function worstSecond(times: readonly number[]): number {
  let worst = 0
  for (let i = 0; i < times.length; i++) {
    let n = 0
    for (let j = i; j < times.length && (times[j] ?? 0) - (times[i] ?? 0) < FPS; j++) n++
    worst = Math.max(worst, n)
  }
  return worst
}

const DARK = 0.02
const WHITE = 1

interface Run {
  luminance: number[]
  intensity: number[]
}

/**
 * Drive `guard` with a one-frame full-scale onset at `rateHz` for `seconds`,
 * then `restSeconds` of nothing, rendering an effect that lights the frame by
 * the shaped onset times intensity. The guard sees every {@link SAMPLE_EVERY}th
 * frame; the trace records every one.
 */
function strobe(guard: FlashGuard | null, rateHz: number, seconds: number, restSeconds = 0): Run {
  const audio = input()
  const luminance: number[] = []
  const intensity: number[] = []
  const reference = createFlashGuard() // the envelope alone, for the unguarded run
  const strobeFrames = Math.round(seconds * FPS)
  const total = strobeFrames + Math.round(restSeconds * FPS)
  let nextOnset = 0
  for (let f = 0; f < total; f++) {
    const t = f * FRAME
    audio.onset = 0
    if (f < strobeFrames && t >= nextOnset - 1e-9) {
      audio.onset = 1
      nextOnset += 1 / rateHz
    }
    const shaped = (guard ?? reference).shape(audio, FRAME)
    const gain = guard ? guard.intensity : 1
    const y = DARK + (WHITE - DARK) * gain * shaped.onset
    luminance.push(y)
    intensity.push(gain)
    if (guard && f % SAMPLE_EVERY === 0) guard.observeLuminance(y)
  }
  return { luminance, intensity }
}

describe('the envelope', () => {
  it('never takes an input from rest to peak in one frame, even after a stall', () => {
    for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.1, 0.5]) {
      const guard = createFlashGuard()
      const audio = input()
      audio.onset = 1
      audio.bass = 1
      audio.mid = 1
      audio.treble = 1
      audio.level = 1
      audio.spectrum.fill(1)
      const shaped = guard.shape(audio, dt)
      for (const value of [shaped.onset, shaped.bass, shaped.mid, shaped.treble, shaped.level]) {
        expect(value).toBeLessThanOrEqual(MAX_RISE_PER_FRAME)
        expect(value).toBeLessThan(1)
      }
      for (const band of shaped.spectrum) expect(band).toBeLessThan(1)
    }
  })

  it('reaches full scale in the minimum attack and no sooner', () => {
    const guard = createFlashGuard()
    const audio = input()
    audio.bass = 1
    let frames = 0
    while (guard.shape(audio, FRAME).bass < 1) frames++
    expect((frames + 1) * FRAME).toBeGreaterThanOrEqual(MIN_ATTACK_SEC - 1e-9)
    expect((frames + 1) * FRAME).toBeLessThan(MIN_ATTACK_SEC + 2 * FRAME)
  })

  it('turns a one-frame onset into a full pulse that holds its peak, then decays', () => {
    const guard = createFlashGuard()
    const audio = input()
    audio.onset = 1
    const trace = [guard.shape(audio, FRAME).onset]
    audio.onset = 0
    for (let f = 0; f < 60; f++) trace.push(guard.shape(audio, FRAME).onset)
    const peakAt = trace.indexOf(Math.max(...trace))
    expect(trace[peakAt]).toBeCloseTo(1, 6)
    expect(peakAt * FRAME).toBeGreaterThan(MIN_ATTACK_SEC - 2 * FRAME)
    for (let f = 1; f <= peakAt; f++) expect(trace[f]).toBeGreaterThan(trace[f - 1] ?? 1)
    for (let f = peakAt + 1; f < trace.length; f++) {
      expect(trace[f]).toBeLessThan(trace[f - 1] ?? 0)
    }
    expect(trace[trace.length - 1]).toBeLessThan(0.05)
  })

  it('lets a fall through at once and leaves the waveform alone', () => {
    const guard = createFlashGuard()
    const audio = input()
    audio.level = 1
    for (let f = 0; f < 30; f++) guard.shape(audio, FRAME)
    audio.level = 0.2
    const shaped = guard.shape(audio, FRAME)
    expect(shaped.level).toBe(0.2)
    expect(shaped.waveform).toBe(audio.waveform)
  })

  it('hands back the same frame object every call', () => {
    const guard = createFlashGuard()
    const audio = input()
    expect(guard.shape(audio, FRAME)).toBe(guard.shape(audio, FRAME))
  })
})

describe('the luminance guard', () => {
  it('would see an 8 Hz full-scale train strobe without it — the test can catch one', () => {
    const { luminance } = strobe(null, 8, 4)
    expect(worstSecond(flashTimes(luminance))).toBeGreaterThanOrEqual(7)
  })

  // 10 Hz is the ceiling: the analysis model's onset refractory is 100 ms.
  for (const rateHz of [5, 8, 10]) {
    for (const sampleEvery of [1, SAMPLE_EVERY]) {
      it(`holds a ${rateHz} Hz full-scale onset train to ≤ ${MAX_FLASHES_PER_SEC} flashes a second (sampling every ${sampleEvery})`, () => {
        const guard = createFlashGuard()
        const audio = input()
        const luminance: number[] = []
        let nextOnset = 0
        for (let f = 0; f < 10 * FPS; f++) {
          audio.onset = f * FRAME >= nextOnset - 1e-9 ? 1 : 0
          if (audio.onset) nextOnset += 1 / rateHz
          const shaped = guard.shape(audio, FRAME)
          const y = DARK + (WHITE - DARK) * guard.intensity * shaped.onset
          luminance.push(y)
          if (f % sampleEvery === 0) guard.observeLuminance(y)
        }
        expect(worstSecond(flashTimes(luminance))).toBeLessThanOrEqual(MAX_FLASHES_PER_SEC)
        expect(guard.intensity).toBeLessThan(1)
      })
    }
  }

  it('lets a 2 Hz train through completely undamped', () => {
    const guard = createFlashGuard()
    const { luminance, intensity } = strobe(guard, 2, 10)
    expect(intensity.every((i) => i === 1)).toBe(true)
    // …and the pulses are real, full-size flashes, so nothing was quietly flattened.
    expect(worstSecond(flashTimes(luminance))).toBe(2)
    expect(Math.max(...luminance)).toBeCloseTo(WHITE, 2)
  })

  it('recovers gradually once a strobe passage ends', () => {
    const guard = createFlashGuard()
    const { intensity } = strobe(guard, 8, 3, 10)
    expect(Math.min(...intensity)).toBeLessThan(0.5)

    // From the last cut on: held through the calm, then a slow climb that finishes.
    let lastCut = 0
    for (let f = 1; f < intensity.length; f++) {
      if ((intensity[f] ?? 0) < (intensity[f - 1] ?? 0)) lastCut = f
    }
    const after = intensity.slice(lastCut)
    const floor = after[0] ?? 1
    const hold = Math.round(RECOVERY_HOLD_SEC * FPS)
    for (let f = 0; f < hold - 1; f++) expect(after[f]).toBe(floor)
    for (let f = 1; f < after.length; f++) {
      const rise = (after[f] ?? 0) - (after[f - 1] ?? 0)
      expect(rise).toBeGreaterThanOrEqual(0)
      expect(rise).toBeLessThanOrEqual(RECOVERY_PER_SEC * FRAME + 1e-9)
    }
    const fullAt = after.indexOf(1) * FRAME
    expect(fullAt).toBeGreaterThan(RECOVERY_HOLD_SEC + (1 - floor) / RECOVERY_PER_SEC - 0.1)
    expect(after[after.length - 1]).toBe(1)
  })

  it('ignores a non-finite sample', () => {
    const guard = createFlashGuard()
    guard.observeLuminance(NaN)
    guard.observeLuminance(Infinity)
    expect(guard.intensity).toBe(1)
  })

  it('starts over on reset', () => {
    const guard = createFlashGuard()
    strobe(guard, 8, 3)
    expect(guard.intensity).toBeLessThan(1)
    guard.reset()
    expect(guard.intensity).toBe(1)
    const { intensity } = strobe(guard, 2, 4)
    expect(intensity.every((i) => i === 1)).toBe(true)
  })
})

describe('a palette change is not a flash', () => {
  function tokens(mode: ThemeMode): Map<string, string> {
    const theme = BUILT_IN_THEMES.find((t) => t.id === DEFAULT_THEME_ID)
    if (!theme) throw new Error('no default theme')
    const vars = resolveTheme({ theme, mode }).cssVars
    const alias: Record<string, string> = {
      '--ui-primary': '--oscine-accent-primary',
      '--ui-bg': '--oscine-surface-base',
      '--ui-bg-elevated': '--oscine-surface-elevated',
      '--ui-text-highlighted': '--oscine-text-highlighted',
      '--ui-text-muted': '--oscine-text-muted'
    }
    return new Map(PALETTE_PROPERTIES.map((p) => [p, vars.get(alias[p] ?? p) ?? '']))
  }

  it('flips dark → light → dark → light, a second apart, without damping', () => {
    const palette = createPaletteModel()
    const guard = createFlashGuard()
    const audio = input()
    palette.setTarget(tokens('dark'))
    const luminance: number[] = []
    const i = PaletteSlot.bg * 3
    for (let f = 0; f < 5 * FPS; f++) {
      if (f > 0 && f % FPS === 0 && f <= 3 * FPS)
        palette.setTarget(tokens(f % (2 * FPS) ? 'light' : 'dark'))
      palette.update(FRAME)
      guard.shape(audio, FRAME)
      const { linear } = palette.palette
      // The stage at rest is the bg; its luminance is what the downsample reads.
      const y =
        0.2126 * (linear[i] ?? 0) + 0.7152 * (linear[i + 1] ?? 0) + 0.0722 * (linear[i + 2] ?? 0)
      luminance.push(y)
      if (f % SAMPLE_EVERY === 0) guard.observeLuminance(y)
      expect(guard.intensity).toBe(1)
    }
    // The flips were full-scale: it really went from near-black to white.
    expect(Math.min(...luminance)).toBeLessThan(0.05)
    expect(Math.max(...luminance)).toBeGreaterThan(0.95)
  })
})
