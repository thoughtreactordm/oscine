import { expect } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import { STROKE_FLOATS, type StrokeSource } from '../../../src/renderer/visualizer/effects/strokes'

/**
 * W23-16: shared driving for the stroke models (Whorl, Trace) — a synthetic
 * section of music, and the checks every stroke record must pass, since the
 * renderer draws them as they are.
 */

export interface MutableFrame {
  waveform: Float32Array<ArrayBuffer>
  spectrum: Float32Array
  bass: number
  mid: number
  treble: number
  level: number
  onset: number
  silent: boolean
  timeSec: number
}

export function makeFrame(): MutableFrame {
  return {
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(ANALYSIS_BANDS),
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    onset: 0,
    silent: true,
    timeSec: 0
  }
}

/** A lively frame (as `effects2d.test.ts` drives the 2D effects), loud or quiet. */
export function section(frame: MutableFrame, timeSec: number, dtSec: number, loud: boolean): void {
  frame.timeSec = timeSec
  const beat = 0.5 + 0.5 * Math.sin(timeSec * Math.PI * 4)
  const gain = loud ? 1 : 0.2
  for (let index = 0; index < frame.waveform.length; index++) {
    frame.waveform[index] =
      gain * 0.6 * beat * Math.sin((index / 1024) * Math.PI * 2 * 9 + timeSec * 7)
  }
  for (let band = 0; band < ANALYSIS_BANDS; band++) {
    frame.spectrum[band] = Math.max(
      0,
      beat * (1 - band / ANALYSIS_BANDS) + 0.1 * Math.sin(band + timeSec * 5)
    )
  }
  frame.bass = beat
  frame.mid = beat * 0.6
  frame.treble = beat * 0.3
  frame.level = loud ? 0.85 : 0.2
  frame.onset = loud && timeSec % 0.25 < dtSec ? 1 : 0
  frame.silent = false
}

/** 144 Hz, 60 Hz, a capped rate, and the 0.1 s clamp. */
export const DTS = [1 / 144, 1 / 60, 1 / 30, 0.1]

export interface StrokeModel extends StrokeSource {
  update(audio: AnalysisFrame, intensity: number, width: number, height: number, dt: number): void
}

export interface RunOptions {
  loud?: boolean
  dt?: number
  intensity?: number
  width?: number
  height?: number
}

export function run(
  model: StrokeModel,
  seconds: number,
  { loud = true, dt = 1 / 60, intensity = 1, width = 1920, height = 1080 }: RunOptions = {}
): void {
  const frame = makeFrame()
  let time = 0
  for (let n = 0; n < Math.round(seconds / dt); n++) {
    time += dt
    section(frame, time, dt, loud)
    model.update(frame, intensity, width, height, dt)
  }
}

export function field(source: StrokeSource, stroke: number, offset: number): number {
  return source.instances[stroke * STROKE_FLOATS + offset]
}

/** Fifteen seconds of mixed sections at mixed frame rates; every stroke in range, every frame. */
export function expectSaneStrokes(model: StrokeModel, maxStrokes: number): void {
  const frame = makeFrame()
  let time = 0
  for (let n = 0; n < 900; n++) {
    const dt = DTS[n % DTS.length]
    time += dt
    section(frame, time, dt, n % 300 < 200)
    model.update(frame, 1, 1920, 1080, dt)
    expect(model.count).toBeLessThanOrEqual(maxStrokes)
    for (let i = 0; i < model.count; i++) {
      for (let f = 0; f < STROKE_FLOATS; f++) {
        expect(Number.isFinite(field(model, i, f))).toBe(true)
      }
      const row = field(model, i, 3)
      expect(Number.isInteger(row) && row >= 0 && row < model.rows).toBe(true)
      expect(field(model, i, 4)).toBeGreaterThanOrEqual(1)
      expect(field(model, i, 5)).toBeGreaterThanOrEqual(0)
      expect(field(model, i, 5)).toBeLessThanOrEqual(1)
    }
  }
  for (const value of model.shapes) expect(Number.isFinite(value)).toBe(true)
}
