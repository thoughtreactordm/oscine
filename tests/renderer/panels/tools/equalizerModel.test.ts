import { describe, expect, it, vi } from 'vitest'
import {
  EQUALIZER_BAND_LIMIT,
  EQUALIZER_FREQUENCY_MAX_HZ,
  EQUALIZER_FREQUENCY_MIN_HZ,
  EQUALIZER_GAIN_DB_LIMIT,
  EQUALIZER_Q_MAX,
  EQUALIZER_Q_MIN,
  type EqualizerBand,
  type EqualizerSpec
} from '../../../../src/shared/audio/equalizer'
import {
  MAX_DISPLAY_FREQUENCY_HZ,
  MIN_DISPLAY_FREQUENCY_HZ,
  fractionForFrequency
} from '../../../../src/renderer/audio/eqResponse'
import {
  DEFAULT_BAND_Q,
  EQ_PALETTE,
  addBandAtPoint,
  adjustQ,
  bandAriaValueText,
  compositeCurve,
  createRafBatch,
  curveAreaPath,
  curvePath,
  flattenedSpec,
  formatFrequency,
  formatGain,
  formatQ,
  frequencyForX,
  frequencyGridLines,
  gainForY,
  gainGridLines,
  nudgeBandParams,
  pointerToParams,
  presetDisplayName,
  qFromDrag,
  removeBand,
  spectrumAreaPath,
  toggleBand,
  typeUsesGain,
  updateBand,
  xForFrequency,
  yForGain,
  type PlotGeometry
} from '../../../../src/renderer/panels/tools/equalizerModel'

const geometry: PlotGeometry = { width: 800, height: 400, maxGainDb: 12 }

function band(overrides: Partial<EqualizerBand> = {}): EqualizerBand {
  return {
    id: overrides.id ?? 'b1',
    type: overrides.type ?? 'peaking',
    frequencyHz: overrides.frequencyHz ?? 1000,
    gainDb: overrides.gainDb ?? 0,
    q: overrides.q ?? DEFAULT_BAND_Q,
    enabled: overrides.enabled ?? true
  }
}

function spec(bands: EqualizerBand[], overrides: Partial<EqualizerSpec> = {}): EqualizerSpec {
  return { enabled: overrides.enabled ?? true, preampDb: overrides.preampDb ?? 0, bands }
}

describe('axis mappings', () => {
  it('maps frequency to x through the same log fraction as W19-2', () => {
    for (const hz of [20, 100, 1000, 5000, 20000]) {
      const expected = fractionForFrequency(hz, MIN_DISPLAY_FREQUENCY_HZ, MAX_DISPLAY_FREQUENCY_HZ)
      expect(xForFrequency(hz, geometry)).toBeCloseTo(expected * geometry.width, 6)
    }
  })

  it('round-trips frequency <-> x, including at both axis extremes', () => {
    for (const hz of [MIN_DISPLAY_FREQUENCY_HZ, 63, 440, 3200, MAX_DISPLAY_FREQUENCY_HZ]) {
      expect(frequencyForX(xForFrequency(hz, geometry), geometry)).toBeCloseTo(hz, 3)
    }
  })

  it('round-trips gain <-> y, with 0 dB at the vertical centre', () => {
    expect(yForGain(0, geometry)).toBeCloseTo(geometry.height / 2, 6)
    for (const db of [-12, -4.5, 0, 6, 12]) {
      expect(gainForY(yForGain(db, geometry), geometry)).toBeCloseTo(db, 6)
    }
  })
})

describe('pointerToParams', () => {
  it('reads frequency from x and gain from y', () => {
    const x = xForFrequency(1000, geometry)
    const y = yForGain(3, geometry)
    const params = pointerToParams(x, y, geometry)
    expect(params.frequencyHz).toBeCloseTo(1000, 3)
    expect(params.gainDb).toBeCloseTo(3, 6)
  })

  it('clamps a drag past the top-left corner to min frequency and max gain', () => {
    const params = pointerToParams(-200, -200, geometry)
    expect(params.frequencyHz).toBeCloseTo(EQUALIZER_FREQUENCY_MIN_HZ, 6)
    expect(params.gainDb).toBe(geometry.maxGainDb)
  })

  it('clamps a drag past the bottom-right corner to max frequency and min gain', () => {
    const params = pointerToParams(geometry.width + 200, geometry.height + 200, geometry)
    expect(params.frequencyHz).toBeCloseTo(EQUALIZER_FREQUENCY_MAX_HZ, 6)
    expect(params.gainDb).toBe(-geometry.maxGainDb)
  })
})

describe('addBandAtPoint', () => {
  it('adds a peaking band at the clicked frequency', () => {
    const x = xForFrequency(2000, geometry)
    const y = yForGain(-3, geometry)
    const outcome = addBandAtPoint(spec([]), x, y, geometry, () => 'new-id')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.bandId).toBe('new-id')
    expect(outcome.spec.bands).toHaveLength(1)
    const added = outcome.spec.bands[0]
    expect(added.type).toBe('peaking')
    expect(added.frequencyHz).toBeCloseTo(2000, 3)
    expect(added.gainDb).toBeCloseTo(-3, 6)
    expect(added.q).toBe(DEFAULT_BAND_Q)
    expect(added.enabled).toBe(true)
  })

  it('refuses past the band limit and surfaces the reason', () => {
    const full = spec(Array.from({ length: EQUALIZER_BAND_LIMIT }, (_, i) => band({ id: `b${i}` })))
    const outcome = addBandAtPoint(full, 100, 100, geometry, () => 'new-id')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain(String(EQUALIZER_BAND_LIMIT))
  })
})

describe('band mutation is immutable and id-stable', () => {
  it('removes a band and leaves the others’ ids intact', () => {
    const source = spec([band({ id: 'a' }), band({ id: 'b' }), band({ id: 'c' })])
    const next = removeBand(source, 'b')
    expect(next.bands.map((b) => b.id)).toEqual(['a', 'c'])
    // The input is untouched — no shared mutation to feed a redraw loop.
    expect(source.bands.map((b) => b.id)).toEqual(['a', 'b', 'c'])
  })

  it('updateBand writes exactly the patched field on the target band only', () => {
    const source = spec([band({ id: 'a', gainDb: 1 }), band({ id: 'b', gainDb: 2 })])
    const next = updateBand(source, 'b', { gainDb: 5 })
    expect(next).not.toBe(source)
    expect(next.bands[0]).toBe(source.bands[0]) // untouched band is shared, not rebuilt
    expect(next.bands[1].gainDb).toBe(5)
    expect(source.bands[1].gainDb).toBe(2) // original unchanged
  })

  it('typing a frequency moves the handle, and the handle x round-trips back', () => {
    const source = spec([band({ id: 'a', frequencyHz: 1000 })])
    const targetX = xForFrequency(4000, geometry)
    const next = updateBand(source, 'a', { frequencyHz: frequencyForX(targetX, geometry) })
    expect(xForFrequency(next.bands[0].frequencyHz, geometry)).toBeCloseTo(targetX, 3)
  })

  it('clamps out-of-range numbers and drops non-finite ones', () => {
    const source = spec([band({ id: 'a', gainDb: 3, q: 2, frequencyHz: 1000 })])
    expect(updateBand(source, 'a', { gainDb: 999 }).bands[0].gainDb).toBe(EQUALIZER_GAIN_DB_LIMIT)
    expect(updateBand(source, 'a', { q: 0 }).bands[0].q).toBe(EQUALIZER_Q_MIN)
    expect(updateBand(source, 'a', { q: 99 }).bands[0].q).toBe(EQUALIZER_Q_MAX)
    expect(updateBand(source, 'a', { frequencyHz: 1 }).bands[0].frequencyHz).toBe(
      EQUALIZER_FREQUENCY_MIN_HZ
    )
    // A NaN mid-keystroke keeps the last good value rather than poisoning the spec.
    expect(updateBand(source, 'a', { gainDb: Number.NaN }).bands[0].gainDb).toBe(3)
  })

  it('toggleBand flips only the target band’s enabled', () => {
    const source = spec([band({ id: 'a', enabled: true }), band({ id: 'b', enabled: true })])
    const next = toggleBand(source, 'a')
    expect(next.bands[0].enabled).toBe(false)
    expect(next.bands[1].enabled).toBe(true)
  })

  it('flattenedSpec clears bands and pre-amp but leaves the enabled flag', () => {
    const flat = flattenedSpec(spec([band()], { preampDb: -3, enabled: true }))
    expect(flat.bands).toEqual([])
    expect(flat.preampDb).toBe(0)
    expect(flat.enabled).toBe(true)
  })
})

describe('keyboard and wheel nudges', () => {
  it('arrows move gain by 1 dB, shift-arrows by 0.1 dB, clamped to the display range', () => {
    const target = band({ gainDb: 0 })
    expect(nudgeBandParams(target, 'ArrowUp', false, geometry).gainDb).toBeCloseTo(1, 6)
    expect(nudgeBandParams(target, 'ArrowUp', true, geometry).gainDb).toBeCloseTo(0.1, 6)
    expect(nudgeBandParams(target, 'ArrowDown', false, geometry).gainDb).toBeCloseTo(-1, 6)
    // At the top of the display range it clamps rather than leaving the plot.
    expect(nudgeBandParams(band({ gainDb: 12 }), 'ArrowUp', false, geometry).gainDb).toBe(12)
  })

  it('left/right move frequency along the log axis and clamp at the ends', () => {
    const mid = band({ frequencyHz: 1000 })
    expect(nudgeBandParams(mid, 'ArrowRight', false, geometry).frequencyHz).toBeGreaterThan(1000)
    expect(nudgeBandParams(mid, 'ArrowLeft', false, geometry).frequencyHz).toBeLessThan(1000)
    expect(
      nudgeBandParams(band({ frequencyHz: 20000 }), 'ArrowRight', false, geometry).frequencyHz
    ).toBeCloseTo(EQUALIZER_FREQUENCY_MAX_HZ, 6)
  })

  it('a wheel notch scales Q and clamps at the ends', () => {
    expect(adjustQ(1, 1)).toBeGreaterThan(1)
    expect(adjustQ(1, -1)).toBeLessThan(1)
    expect(adjustQ(EQUALIZER_Q_MAX, 1)).toBe(EQUALIZER_Q_MAX)
    expect(adjustQ(EQUALIZER_Q_MIN, -1)).toBe(EQUALIZER_Q_MIN)
  })

  it('a shift-drag up doubles Q, down halves it', () => {
    expect(qFromDrag(1, -120)).toBeCloseTo(2, 6)
    expect(qFromDrag(1, 120)).toBeCloseTo(0.5, 6)
  })
})

describe('formatting and aria', () => {
  it('formats frequencies, gains and Q the way an operator transcribes them', () => {
    expect(formatFrequency(320)).toBe('320 Hz')
    expect(formatFrequency(1000)).toBe('1.00 kHz')
    expect(formatFrequency(3200)).toBe('3.20 kHz')
    expect(formatFrequency(12000)).toBe('12.0 kHz')
    expect(formatGain(3)).toBe('+3.0 dB')
    expect(formatGain(-4.5)).toBe('−4.5 dB')
    expect(formatGain(0)).toBe('0.0 dB')
    expect(formatQ(2.1)).toBe('2.10')
  })

  it('reads a peaking band aloud with its gain', () => {
    expect(
      bandAriaValueText(band({ type: 'peaking', frequencyHz: 3200, gainDb: -4.5, q: 2.1 }))
    ).toBe('Peak, 3.20 kHz, −4.5 dB, Q 2.10')
  })

  it('omits gain for a gainless type and marks a bypassed band', () => {
    expect(typeUsesGain('lowpass')).toBe(false)
    expect(
      bandAriaValueText(band({ type: 'lowpass', frequencyHz: 1000, q: 1, enabled: false }))
    ).toBe('Low-pass, 1.00 kHz, Q 1.00, bypassed')
  })

  it('marks a recalled preset modified once the curve drifts', () => {
    expect(presetDisplayName('Bass boost', false)).toBe('Bass boost')
    expect(presetDisplayName('Bass boost', true)).toBe('Bass boost (modified)')
  })
})

describe('drawn curve', () => {
  it('computes the composite as if enabled so a bypassed curve is still drawn', () => {
    const curve = compositeCurve(spec([band({ gainDb: 6 })], { enabled: false }), 48000)
    expect(curve.length).toBeGreaterThan(0)
    expect(curve.some((db) => Math.abs(db) > 0.5)).toBe(true)
  })

  it('builds an open path for the line and a closed path for a fill', () => {
    const curve = compositeCurve(spec([band({ gainDb: 6 })]), 48000)
    expect(curvePath(curve, geometry).startsWith('M')).toBe(true)
    expect(curveAreaPath(curve, geometry).endsWith('Z')).toBe(true)
  })
})

describe('gridlines', () => {
  it('labels the decade frequencies and spans the audible band', () => {
    const lines = frequencyGridLines(geometry)
    const labelled = lines.filter((line) => line.label !== null).map((line) => line.frequencyHz)
    expect(labelled).toContain(1000)
    expect(labelled).toContain(20)
    expect(labelled).toContain(20000)
  })

  it('places dB lines at 0 and two steps either side', () => {
    expect(gainGridLines(geometry).map((line) => line.gainDb)).toEqual([12, 6, 0, -6, -12])
  })
})

describe('createRafBatch', () => {
  it('coalesces a burst of requests into one run per frame', () => {
    const scheduled: Array<() => void> = []
    const raf = vi.fn((cb: () => void) => {
      scheduled.push(cb)
      return 1
    })
    const caf = vi.fn()
    const run = vi.fn()
    const batch = createRafBatch(run, raf, caf)

    for (let i = 0; i < 20; i++) batch.request()
    expect(raf).toHaveBeenCalledTimes(1)
    expect(batch.pending).toBe(true)

    scheduled[0]?.()
    expect(run).toHaveBeenCalledTimes(1)
    expect(batch.pending).toBe(false)

    // A later burst schedules a fresh frame.
    batch.request()
    expect(raf).toHaveBeenCalledTimes(2)
  })

  it('flush runs immediately and cancels the pending frame', () => {
    const raf = vi.fn(() => 7)
    const caf = vi.fn()
    const run = vi.fn()
    const batch = createRafBatch(run, raf, caf)

    batch.request()
    batch.flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(caf).toHaveBeenCalledWith(7)
    expect(batch.pending).toBe(false)
  })

  it('cancel drops the pending frame without running', () => {
    const raf = vi.fn(() => 9)
    const caf = vi.fn()
    const run = vi.fn()
    const batch = createRafBatch(run, raf, caf)

    batch.request()
    batch.cancel()
    expect(run).not.toHaveBeenCalled()
    expect(caf).toHaveBeenCalledWith(9)
    expect(batch.pending).toBe(false)
  })
})

describe('spectrumAreaPath', () => {
  it('builds a closed area, with louder points drawn higher than quiet ones', () => {
    const loud = spectrumAreaPath(new Float32Array([0, 0, 0]), -90, 0, geometry)
    const quiet = spectrumAreaPath(new Float32Array([-90, -90, -90]), -90, 0, geometry)
    expect(loud.startsWith('M')).toBe(true)
    expect(loud.endsWith('Z')).toBe(true)
    // A louder frame reaches nearer the top (y=0); a floor frame hugs the bottom.
    const loudMinY = Math.min(...[...loud.matchAll(/ (\d+\.\d+)/g)].map((m) => Number(m[1])))
    const quietMinY = Math.min(...[...quiet.matchAll(/ (\d+\.\d+)/g)].map((m) => Number(m[1])))
    expect(loudMinY).toBeLessThan(quietMinY)
  })

  it('returns nothing for an unmeasured plot', () => {
    expect(spectrumAreaPath(new Float32Array([0, 0]), -90, 0, { ...geometry, width: 0 })).toBe('')
  })
})

describe('theming', () => {
  it('draws only from --ui-* tokens, so a theme swap needs no component change (M5)', () => {
    for (const value of Object.values(EQ_PALETTE)) {
      expect(value).toMatch(/^var\(--ui-[a-z-]+\)$/)
    }
  })
})
