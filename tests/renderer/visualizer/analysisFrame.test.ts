import { afterEach, describe, expect, it } from 'vitest'
import {
  ANALYSIS_BANDS,
  MAX_FRAME_DT_SEC,
  ONSET_REFRACTORY_SEC,
  SILENCE_EPSILON,
  createAnalysisModel,
  type AnalysisFrame,
  type AnalysisModel
} from '../../../src/renderer/visualizer/analysisFrame'
import { SPECTRUM_FFT_SIZE } from '../../../src/renderer/panels/tools/spectrumModel'

const RATE = 48000

/** A signal as a pure function of the absolute sample index, so overlapping windows agree. */
type Signal = (sample: number) => number

const sine =
  (frequencyHz: number, amplitude = 1): Signal =>
  (s) =>
    amplitude * Math.sin((2 * Math.PI * frequencyHz * s) / RATE)

const sum =
  (...signals: Signal[]): Signal =>
  (s) =>
    signals.reduce((total, signal) => total + signal(s), 0)

const silence: Signal = () => 0

/** Deterministic white noise in −1..1 from an integer hash of the sample index. */
function noise(s: number): number {
  let h = (s | 0) ^ 0x9e3779b9
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) / 0xffffffff) * 2 - 1
}

/** A train of decaying noise bursts — percussive hits — at `rateHz`. */
function clicks(rateHz: number, amplitude = 0.8, decaySec = 0.015): Signal {
  const period = RATE / rateHz
  return (s) => {
    if (s < 0) return 0
    const age = s - Math.floor(s / period) * period
    return amplitude * noise(s) * Math.exp(-age / (decaySec * RATE))
  }
}

/** The tap: the `SPECTRUM_FFT_SIZE` samples ending at `endSample`. */
function fill(into: Float32Array, signal: Signal, endSample: number): void {
  const start = endSample - into.length
  for (let i = 0; i < into.length; i++) into[i] = signal(start + i)
}

interface Clock {
  sample: number
}

/** Run `seconds` of `signal` at `fps`, calling `each` with every frame and its time. */
function run(
  model: AnalysisModel,
  signal: Signal,
  fps: number,
  seconds: number,
  each?: (frame: AnalysisFrame, timeSec: number) => void,
  clock: Clock = { sample: 0 }
): Clock {
  const frames = Math.round(seconds * fps)
  const dt = 1 / fps
  for (let f = 0; f < frames; f++) {
    clock.sample += RATE / fps
    fill(model.waveform, signal, Math.round(clock.sample))
    const frame = model.update(true, dt)
    each?.(frame, clock.sample / RATE)
  }
  return clock
}

function onsetTimes(model: AnalysisModel, signal: Signal, fps: number, seconds: number): number[] {
  const times: number[] = []
  run(model, signal, fps, seconds, (frame, t) => {
    if (frame.onset > 0) times.push(t)
  })
  return times
}

describe('createAnalysisModel', () => {
  it('starts silent, with buffers of the advertised sizes', () => {
    const model = createAnalysisModel()
    expect(model.waveform).toHaveLength(SPECTRUM_FFT_SIZE)
    expect(model.frame.waveform).toBe(model.waveform)
    expect(model.frame.spectrum).toHaveLength(ANALYSIS_BANDS)
    expect(model.frame.silent).toBe(true)
    expect(model.frame.onset).toBe(0)
  })

  it('returns the same frame object every update', () => {
    const model = createAnalysisModel()
    const first = model.update(true, 1 / 60)
    expect(model.update(false, 1 / 60)).toBe(first)
    expect(first).toBe(model.frame)
  })
})

describe('band energies', () => {
  it('puts a 60 Hz sine in bass and not treble', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, sine(60), 60, 2)
    const { bass, mid, treble } = model.frame
    expect(bass).toBeGreaterThan(0.5)
    expect(treble).toBeLessThan(0.05)
    expect(bass).toBeGreaterThan(mid)
  })

  it('puts an 8 kHz sine in treble and not bass', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, sine(8000), 60, 2)
    expect(model.frame.treble).toBeGreaterThan(0.2)
    expect(model.frame.bass).toBeLessThan(0.05)
  })

  it('lights the spectrum band nearest a tone and leaves the far end dark', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, sine(1000), 60, 2)
    const { spectrum } = model.frame
    // 1 kHz sits ~56% of the way along the 30 Hz–16 kHz log axis.
    const at = Math.round((Math.log(1000 / 30) / Math.log(16000 / 30)) * (ANALYSIS_BANDS - 1))
    expect(spectrum[at]).toBeGreaterThan(0.5)
    expect(spectrum[ANALYSIS_BANDS - 1]).toBeLessThan(0.05)
    expect(spectrum[0]).toBeLessThan(0.05)
  })

  it('maps every value onto 0..1', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    // Full-scale noise is as loud as the tap gets.
    run(model, noise, 60, 3)
    const { spectrum, bass, mid, treble, level } = model.frame
    for (const value of [...spectrum, bass, mid, treble, level]) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(level).toBeGreaterThan(0.5)
  })
})

describe('auto-gain', () => {
  it('lifts a quiet master over seconds, not frames', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    const quiet = sine(440, 0.01) // −40 dBFS
    const clock = run(model, quiet, 60, 0.5)
    const early = model.frame.mid
    run(model, quiet, 60, 1, undefined, clock)
    const oneSecond = model.frame.mid
    run(model, quiet, 60, 8, undefined, clock)
    const settled = model.frame.mid

    expect(oneSecond).toBeGreaterThan(early)
    expect(settled).toBeGreaterThan(oneSecond)
    // Still visibly climbing after the first second: a time constant of seconds.
    expect(settled - oneSecond).toBeGreaterThan(0.02)
  })

  it('does not lift silence off the floor', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, silence, 60, 10)
    expect(Math.max(...model.frame.spectrum)).toBe(0)
    expect(model.frame.level).toBe(0)
  })
})

describe('onsets', () => {
  for (const fps of [30, 60]) {
    for (const rateHz of [2, 4, 7]) {
      it(`a ${rateHz} Hz click train yields onsets at ${rateHz} Hz and not more (${fps} fps)`, () => {
        const model = createAnalysisModel({ sampleRateHz: RATE })
        const warmup = 1
        const seconds = 5
        const times = onsetTimes(model, clicks(rateHz), fps, warmup + seconds).filter(
          (t) => t > warmup
        )
        const expected = rateHz * seconds
        expect(times.length).toBeGreaterThanOrEqual(expected - 1)
        expect(times.length).toBeLessThanOrEqual(expected + 1)
        // Spaced at the train's period, never doubled up inside one hit.
        for (let i = 1; i < times.length; i++) {
          expect(times[i] - times[i - 1]).toBeGreaterThan(ONSET_REFRACTORY_SEC)
          expect(times[i] - times[i - 1]).toBeCloseTo(1 / rateHz, 1)
        }
      })
    }
  }

  it('never fires twice inside the refractory window', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    // 20 Hz clicks: every hit is a rise, but only every ~100 ms may count.
    const times = onsetTimes(model, clicks(20), 60, 3)
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(ONSET_REFRACTORY_SEC - 1e-9)
    }
    expect(times.length).toBeLessThanOrEqual(3 / ONSET_REFRACTORY_SEC + 1)
  })

  it('finds no onsets in a steady tone', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    const times = onsetTimes(model, sum(sine(220, 0.4), sine(3000, 0.2)), 60, 4)
    expect(times.filter((t) => t > 0.5)).toEqual([])
  })

  it('reads a repeated poll of one render quantum as zero flux', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, silence, 60, 1)
    // A hit arrives: the first poll of it is an onset...
    fill(model.waveform, clicks(1), 512)
    expect(model.update(true, 1 / 60).onset).toBeGreaterThan(0)
    // ...and polling the identical window again, past the refractory window,
    // is not — there was no rise between the two reads.
    expect(model.update(true, ONSET_REFRACTORY_SEC + 0.01).onset).toBe(0)
  })

  it('reports onset strength in 0..1', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, clicks(4, 1), 60, 3, (frame) => {
      expect(frame.onset).toBeGreaterThanOrEqual(0)
      expect(frame.onset).toBeLessThanOrEqual(1)
    })
  })
})

describe('frame-rate independence', () => {
  it('converges to the same smoothed values at 30 and 60 fps', () => {
    const signal = sum(sine(60, 0.3), sine(440, 0.4), sine(6000, 0.1))
    const at30 = createAnalysisModel({ sampleRateHz: RATE })
    const at60 = createAnalysisModel({ sampleRateHz: RATE })
    run(at30, signal, 30, 4)
    run(at60, signal, 60, 4)

    for (const key of ['bass', 'mid', 'treble', 'level'] as const) {
      expect(at30.frame[key]).toBeCloseTo(at60.frame[key], 2)
    }
    for (let i = 0; i < ANALYSIS_BANDS; i++) {
      expect(Math.abs(at30.frame.spectrum[i] - at60.frame.spectrum[i])).toBeLessThan(0.02)
    }
  })

  it('decays at the same rate per second at 30 and 60 fps', () => {
    const at30 = createAnalysisModel({ sampleRateHz: RATE })
    const at60 = createAnalysisModel({ sampleRateHz: RATE })
    run(at30, sine(440, 0.5), 30, 2)
    run(at60, sine(440, 0.5), 60, 2)
    for (let f = 0; f < 15; f++) at30.update(false, 1 / 30)
    for (let f = 0; f < 30; f++) at60.update(false, 1 / 60)
    expect(at30.frame.mid).toBeCloseTo(at60.frame.mid, 4)
    expect(at30.frame.level).toBeCloseTo(at60.frame.level, 4)
  })

  it(`treats a stall as a ${MAX_FRAME_DT_SEC} s step`, () => {
    const stalled = createAnalysisModel({ sampleRateHz: RATE })
    const capped = createAnalysisModel({ sampleRateHz: RATE })
    fill(stalled.waveform, sine(440), SPECTRUM_FFT_SIZE)
    fill(capped.waveform, sine(440), SPECTRUM_FFT_SIZE)
    stalled.update(true, 5)
    capped.update(true, MAX_FRAME_DT_SEC)
    expect(stalled.frame.mid).toBe(capped.frame.mid)
    expect(Array.from(stalled.frame.spectrum)).toEqual(Array.from(capped.frame.spectrum))
    expect(stalled.frame.timeSec).toBeCloseTo(MAX_FRAME_DT_SEC, 9)
  })
})

describe('decay and silence', () => {
  it('decays rather than snapping when the read returns false, and leaves the waveform alone', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, sine(440, 0.5), 60, 2)
    const before = model.frame.mid
    const lastSamples = Array.from(model.waveform)
    expect(model.frame.silent).toBe(false)

    model.update(false, 1 / 60)
    expect(model.frame.mid).toBeLessThan(before)
    expect(model.frame.mid).toBeGreaterThan(before * 0.5)
    expect(model.frame.silent).toBe(false)
    expect(model.frame.onset).toBe(0)
    expect(Array.from(model.waveform)).toEqual(lastSamples)
  })

  it('sets silent only once everything has settled', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, sum(sine(60, 0.5), sine(2000, 0.3), sine(9000, 0.2)), 60, 2)

    let silentAfterSec = -1
    for (let f = 1; f <= 60 * 5; f++) {
      const frame = model.update(false, 1 / 60)
      const settled =
        Math.max(...frame.spectrum, frame.bass, frame.mid, frame.treble, frame.level) <
        SILENCE_EPSILON
      expect(frame.silent).toBe(settled)
      if (frame.silent && silentAfterSec < 0) silentAfterSec = f / 60
    }
    // Neither instant nor endless: a decay, then rest.
    expect(silentAfterSec).toBeGreaterThan(0.5)
    expect(silentAfterSec).toBeLessThan(3)
  })

  it('goes silent on a dry tap that keeps reading true', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    const clock = run(model, sine(440, 0.5), 60, 1)
    expect(model.frame.silent).toBe(false)
    run(model, silence, 60, 4, undefined, clock)
    expect(model.frame.silent).toBe(true)
  })

  it('comes straight back from silence when sound returns', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, silence, 60, 1)
    expect(model.frame.silent).toBe(true)
    run(model, sine(440, 0.5), 60, 0.1)
    expect(model.frame.silent).toBe(false)
  })
})

describe('clock and reset', () => {
  it('accumulates clamped dt and restarts on request', () => {
    const model = createAnalysisModel()
    model.update(false, 0.05)
    model.update(false, 0.05)
    model.update(false, 3)
    expect(model.frame.timeSec).toBeCloseTo(0.2, 9)
    model.update(false, -1)
    expect(model.frame.timeSec).toBeCloseTo(0.2, 9)
    model.restartClock()
    expect(model.frame.timeSec).toBe(0)
  })

  it('reset returns to rest', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    run(model, clicks(4), 60, 1)
    model.reset()
    expect(model.frame.silent).toBe(true)
    expect(model.frame.level).toBe(0)
    expect(model.frame.onset).toBe(0)
    expect(model.frame.timeSec).toBe(0)
    expect(Math.max(...model.frame.spectrum)).toBe(0)
    expect(Math.max(...model.waveform)).toBe(0)
  })

  it('places bands by the sample rate it is given', () => {
    const at48 = createAnalysisModel({ sampleRateHz: 48000 })
    const misread = createAnalysisModel({ sampleRateHz: 48000 })
    misread.setSampleRate(96000)
    run(at48, sine(1000), 60, 1)
    run(misread, sine(1000), 60, 1)
    const peak = (frame: AnalysisFrame): number => {
      let best = 0
      for (let i = 1; i < ANALYSIS_BANDS; i++)
        if (frame.spectrum[i] > frame.spectrum[best]) best = i
      return best
    }
    // Read at the wrong rate, the same bins land an octave higher on the axis.
    expect(peak(misread.frame)).toBeGreaterThan(peak(at48.frame))
  })
})

describe('allocation', () => {
  const originals = { Float32Array, Float64Array }

  afterEach(() => {
    globalThis.Float32Array = originals.Float32Array
    globalThis.Float64Array = originals.Float64Array
  })

  it('constructs no typed arrays per frame', () => {
    const model = createAnalysisModel({ sampleRateHz: RATE })
    const signal = sum(clicks(4), sine(220, 0.3))
    const clock = run(model, signal, 60, 0.5)

    // Fill the windows up front, so the harness's own work isn't counted.
    const windows = Array.from({ length: 120 }, (_, f) => {
      const buffer = new Float32Array(SPECTRUM_FFT_SIZE)
      fill(buffer, signal, Math.round(clock.sample + (f + 1) * (RATE / 60)))
      return buffer
    })

    let constructed = 0
    const counting = <T extends object>(target: T): T =>
      new Proxy(target, {
        construct(base, args, newTarget) {
          constructed++
          return Reflect.construct(base as never, args, newTarget)
        }
      })
    globalThis.Float32Array = counting(originals.Float32Array)
    globalThis.Float64Array = counting(originals.Float64Array)

    // The spy itself works: a construction through the global is counted.
    new Float32Array(1)
    expect(constructed).toBe(1)
    constructed = 0

    for (let f = 0; f < windows.length; f++) {
      model.waveform.set(windows[f])
      model.update(f % 10 !== 9, 1 / 60) // every tenth read is a dry tap
    }
    expect(constructed).toBe(0)
  })
})
