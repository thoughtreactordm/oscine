import { OfflineAudioContext } from 'node-web-audio-api'
import { describe, expect, it } from 'vitest'
import type { EqualizerBand, EqualizerSpec } from '../../../src/renderer/audio/equalizer'
import {
  bandMagnitudeDb,
  biquadCoefficients,
  fractionForFrequency,
  logFrequencyAt,
  responseCurveDb,
  specMagnitudeDb
} from '../../../src/renderer/audio/eqResponse'

const FS = 48000

function band(overrides: Partial<EqualizerBand> = {}): EqualizerBand {
  return {
    id: 'b',
    type: 'peaking',
    frequencyHz: 1000,
    gainDb: 0,
    q: 1,
    enabled: true,
    ...overrides
  }
}

function spec(bands: EqualizerBand[], extra: Partial<EqualizerSpec> = {}): EqualizerSpec {
  return { enabled: true, preampDb: 0, bands, ...extra }
}

/** A log sweep 20 Hz – 20 kHz, `count + 1` points inclusive. */
function logSweep(count: number, minHz = 20, maxHz = 20000): number[] {
  return Array.from({ length: count + 1 }, (_, i) => logFrequencyAt(i / count, minHz, maxHz))
}

/**
 * A live context only for the agreement test. Constructed behind a guard so the
 * suite skips cleanly on a runtime with no Web Audio rather than failing — the
 * pure code under test needs none of it.
 */
const audioContext = (() => {
  try {
    const ctx = new OfflineAudioContext(1, 128, FS)
    const node = ctx.createBiquadFilter()
    return typeof node.getFrequencyResponse === 'function' ? ctx : null
  } catch {
    return null
  }
})()

function nodeMagnitudeDb(b: EqualizerBand, frequencies: number[]): number[] {
  const node = audioContext!.createBiquadFilter()
  node.type = b.type
  node.frequency.value = b.frequencyHz
  node.gain.value = b.gainDb
  node.Q.value = b.q
  const mag = new Float32Array(frequencies.length)
  const phase = new Float32Array(frequencies.length)
  node.getFrequencyResponse(Float32Array.from(frequencies), mag, phase)
  return Array.from(mag, (m) => 20 * Math.log10(m))
}

describe('eqResponse', () => {
  describe.skipIf(!audioContext)('agreement with BiquadFilterNode', () => {
    // The one test that proves the picture matches the sound: for every filter
    // type across a range of gains and Q, the pure magnitude must track a real
    // node within ~0.01 dB. This is the reason a pure implementation is safe.
    const types: EqualizerBand['type'][] = [
      'peaking',
      'lowshelf',
      'highshelf',
      'lowpass',
      'highpass',
      'notch'
    ]
    const sweep = logSweep(60)

    for (const type of types) {
      const usesGain = type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
      for (const frequencyHz of [60, 250, 1000, 5000, 15000]) {
        for (const gainDb of usesGain ? [-18, -6, 6, 18] : [0]) {
          for (const q of [0.5, 0.7071, 2, 8]) {
            it(`${type} f0=${frequencyHz} gain=${gainDb} q=${q}`, () => {
              const b = band({ type, frequencyHz, gainDb, q })
              const coefficients = biquadCoefficients(b, FS)
              const reference = nodeMagnitudeDb(b, sweep)
              sweep.forEach((f, i) => {
                // The notch null dives to −140 dB where tiny numeric differences
                // read as large dB; compare only where the response is audible.
                if (reference[i] < -60) return
                expect(bandMagnitudeDb(coefficients, f, FS)).toBeCloseTo(reference[i], 2)
              })
            })
          }
        }
      }
    }
  })

  it('a flat spec is 0 dB everywhere', () => {
    const flat = spec([])
    for (const f of logSweep(20)) expect(specMagnitudeDb(flat, f, FS)).toBe(0)
  })

  it('a disabled spec is 0 dB everywhere regardless of its bands', () => {
    const loud = spec(
      [band({ gainDb: 18 }), band({ type: 'lowshelf', frequencyHz: 100, gainDb: -12 })],
      {
        enabled: false,
        preampDb: 6
      }
    )
    for (const f of logSweep(20)) expect(specMagnitudeDb(loud, f, FS)).toBe(0)
  })

  it('a peaking band peaks at its centre frequency and equals its gainDb there', () => {
    const centre = 1000
    const s = spec([band({ frequencyHz: centre, gainDb: 6, q: 2 })])
    const atCentre = specMagnitudeDb(s, centre, FS)
    expect(atCentre).toBeCloseTo(6, 4)
    // A genuine maximum: the shoulders are strictly below the peak.
    expect(specMagnitudeDb(s, centre * 0.7, FS)).toBeLessThan(atCentre)
    expect(specMagnitudeDb(s, centre / 0.7, FS)).toBeLessThan(atCentre)
  })

  it('a shelf reaches half its gain at the corner frequency', () => {
    const corner = 200
    const low = spec([band({ type: 'lowshelf', frequencyHz: corner, gainDb: 8 })])
    const high = spec([band({ type: 'highshelf', frequencyHz: 5000, gainDb: 8 })])
    expect(specMagnitudeDb(low, corner, FS)).toBeCloseTo(4, 4)
    expect(specMagnitudeDb(high, 5000, FS)).toBeCloseTo(4, 4)
  })

  it('decibels add: two identical +6 dB bands compose to +12 dB at centre', () => {
    const centre = 1000
    const s = spec([
      band({ id: 'a', frequencyHz: centre, gainDb: 6, q: 3 }),
      band({ id: 'b', frequencyHz: centre, gainDb: 6, q: 3 })
    ])
    expect(specMagnitudeDb(s, centre, FS)).toBeCloseTo(12, 4)
  })

  it('preampDb offsets the whole curve by a constant', () => {
    const bands = [band({ frequencyHz: 800, gainDb: 5, q: 1.5 })]
    const base = responseCurveDb(spec(bands), FS, 32, 20, 20000)
    const lifted = responseCurveDb(spec(bands, { preampDb: 3 }), FS, 32, 20, 20000)
    for (let i = 0; i < base.length; i++) expect(lifted[i] - base[i]).toBeCloseTo(3, 5)
  })

  it('Q changes the width of a peaking band, not its peak height', () => {
    const centre = 1000
    const wide = spec([band({ frequencyHz: centre, gainDb: 6, q: 0.5 })])
    const narrow = spec([band({ frequencyHz: centre, gainDb: 6, q: 6 })])
    // Same peak at centre...
    expect(specMagnitudeDb(wide, centre, FS)).toBeCloseTo(specMagnitudeDb(narrow, centre, FS), 4)
    // ...but the wide band still has appreciable gain an octave out where the narrow one has fallen off.
    const octaveUp = centre * 2
    expect(specMagnitudeDb(wide, octaveUp, FS)).toBeGreaterThan(
      specMagnitudeDb(narrow, octaveUp, FS)
    )
  })

  it('lowpass and highpass ignore gainDb entirely', () => {
    for (const type of ['lowpass', 'highpass'] as const) {
      const quiet = biquadCoefficients(band({ type, frequencyHz: 1000, gainDb: 0, q: 1 }), FS)
      const loud = biquadCoefficients(band({ type, frequencyHz: 1000, gainDb: 20, q: 1 }), FS)
      for (const f of logSweep(20)) {
        expect(bandMagnitudeDb(loud, f, FS)).toBeCloseTo(bandMagnitudeDb(quiet, f, FS), 10)
      }
    }
  })

  it('lowpass rolls off above its cutoff and passes below it', () => {
    const c = biquadCoefficients(band({ type: 'lowpass', frequencyHz: 1000, q: Math.SQRT1_2 }), FS)
    expect(bandMagnitudeDb(c, 100, FS)).toBeCloseTo(0, 1)
    expect(bandMagnitudeDb(c, 8000, FS)).toBeLessThan(-20)
  })

  it('follows Web Audio in reading lowpass/highpass Q as dB, not the textbook linear Q', () => {
    // A numeric Q of 1/√2 is NOT the −3 dB Butterworth knee here: Web Audio reads
    // it as +0.707 dB of resonance at the cutoff (10^(Q/20)). The textbook −3 dB
    // knee lives at Q ≈ −3.01 dB on this scale. Locking this down is what keeps
    // the drawn curve honest about the node the router actually builds.
    const resonant = biquadCoefficients(
      band({ type: 'lowpass', frequencyHz: 1000, q: Math.SQRT1_2 }),
      FS
    )
    expect(bandMagnitudeDb(resonant, 1000, FS)).toBeCloseTo(Math.SQRT1_2, 3)

    const butterworthQdb = 20 * Math.log10(Math.SQRT1_2) // ≈ −3.0103
    const butterworth = biquadCoefficients(
      band({ type: 'lowpass', frequencyHz: 1000, q: butterworthQdb }),
      FS
    )
    expect(bandMagnitudeDb(butterworth, 1000, FS)).toBeCloseTo(-3.01, 1)
  })

  it('the high-frequency end depends on sample rate', () => {
    const b = band({ type: 'peaking', frequencyHz: 15000, gainDb: 6, q: 1 })
    const at441 = bandMagnitudeDb(biquadCoefficients(b, 44100), 18000, 44100)
    const at96 = bandMagnitudeDb(biquadCoefficients(b, 96000), 18000, 96000)
    expect(Math.abs(at441 - at96)).toBeGreaterThan(0.1)
  })

  it('produces no NaN or Infinity across the full clamp ranges, including Q extremes and Nyquist', () => {
    const types: EqualizerBand['type'][] = [
      'peaking',
      'lowshelf',
      'highshelf',
      'lowpass',
      'highpass',
      'notch'
    ]
    const nyquist = FS / 2
    const evalFreqs = [...logSweep(20), nyquist]
    for (const type of types) {
      for (const frequencyHz of [20, 1000, nyquist]) {
        for (const gainDb of [-24, 24]) {
          for (const q of [0.1, 18]) {
            const s = spec([band({ type, frequencyHz, gainDb, q })], { preampDb: 12 })
            const coefficients = biquadCoefficients(band({ type, frequencyHz, gainDb, q }), FS)
            for (const f of evalFreqs) {
              expect(Number.isFinite(bandMagnitudeDb(coefficients, f, FS))).toBe(true)
              expect(Number.isFinite(specMagnitudeDb(s, f, FS))).toBe(true)
            }
          }
        }
      }
    }
  })

  it('responseCurveDb returns a point per grid step and matches specMagnitudeDb', () => {
    const s = spec([band({ frequencyHz: 2000, gainDb: -4, q: 1.2 })], { preampDb: 2 })
    const points = 64
    const curve = responseCurveDb(s, FS, points, 20, 20000)
    expect(curve).toHaveLength(points)
    for (let i = 0; i < points; i++) {
      const f = logFrequencyAt(i / (points - 1), 20, 20000)
      expect(curve[i]).toBeCloseTo(specMagnitudeDb(s, f, FS), 5)
    }
  })

  it('responseCurveDb is all zeros for a disabled spec', () => {
    const curve = responseCurveDb(
      spec([band({ gainDb: 12 })], { enabled: false }),
      FS,
      32,
      20,
      20000
    )
    expect(Array.from(curve).every((v) => v === 0)).toBe(true)
  })

  it('logFrequencyAt and fractionForFrequency round-trip', () => {
    for (const fraction of [0, 0.1, 0.37, 0.5, 0.83, 1]) {
      const f = logFrequencyAt(fraction, 20, 20000)
      expect(fractionForFrequency(f, 20, 20000)).toBeCloseTo(fraction, 10)
    }
    for (const f of [20, 100, 440, 1000, 5000, 20000]) {
      const fraction = fractionForFrequency(f, 20, 20000)
      expect(logFrequencyAt(fraction, 20, 20000)).toBeCloseTo(f, 6)
    }
    // The endpoints map exactly.
    expect(logFrequencyAt(0, 20, 20000)).toBeCloseTo(20, 10)
    expect(logFrequencyAt(1, 20, 20000)).toBeCloseTo(20000, 6)
  })
})
