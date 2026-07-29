import { OfflineAudioContext } from 'node-web-audio-api'
import { describe, expect, it } from 'vitest'
import { decodedSourceEndTimeSec } from '../../../src/renderer/audio/gaplessTiming'
import {
  continuousGaplessSignal,
  GAPLESS_LEFT_SAMPLES,
  GAPLESS_SAMPLE_RATE
} from '../../fixtures/audio/gaplessPcm'

const LEAD_IN_SAMPLES = 19
const TOLERANCE = 1e-7

function addSource(
  context: OfflineAudioContext,
  samples: Float32Array,
  startTimeSec: number
): void {
  const buffer = context.createBuffer(1, samples.length, GAPLESS_SAMPLE_RATE)
  buffer.copyToChannel(new Float32Array(samples), 0)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start(startTimeSec)
}

async function renderReference(signal: Float32Array): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, LEAD_IN_SAMPLES + signal.length, GAPLESS_SAMPLE_RATE)
  addSource(context, signal, LEAD_IN_SAMPLES / GAPLESS_SAMPLE_RATE)
  const rendered = await context.startRendering()
  const samples = new Float32Array(rendered.length)
  rendered.copyFromChannel(samples, 0)
  return samples
}

async function renderSplit(signal: Float32Array, joinShiftSamples = 0): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, LEAD_IN_SAMPLES + signal.length, GAPLESS_SAMPLE_RATE)
  const left = signal.slice(0, GAPLESS_LEFT_SAMPLES)
  const right = signal.slice(GAPLESS_LEFT_SAMPLES)
  const currentStartTimeSec = LEAD_IN_SAMPLES / GAPLESS_SAMPLE_RATE
  const exactBoundarySec = decodedSourceEndTimeSec(
    currentStartTimeSec,
    left.length / GAPLESS_SAMPLE_RATE,
    0
  )

  addSource(context, left, currentStartTimeSec)
  addSource(context, right, exactBoundarySec + joinShiftSamples / GAPLESS_SAMPLE_RATE)
  const rendered = await context.startRendering()
  const samples = new Float32Array(rendered.length)
  rendered.copyFromChannel(samples, 0)
  return samples
}

function maximumErrorAroundJoin(actual: Float32Array, expected: Float32Array): number {
  const join = LEAD_IN_SAMPLES + GAPLESS_LEFT_SAMPLES
  let maximum = 0
  for (let sample = join - 3; sample <= join + 3; sample += 1) {
    maximum = Math.max(maximum, Math.abs(actual[sample] - expected[sample]))
  }
  return maximum
}

describe('sample-accurate decoded boundary', () => {
  it('renders a split continuous signal with no missing or duplicated join sample', async () => {
    const signal = continuousGaplessSignal()
    const reference = await renderReference(signal)
    const split = await renderSplit(signal)

    expect(maximumErrorAroundJoin(split, reference)).toBeLessThanOrEqual(TOLERANCE)
  })

  it.each([-1, 1])('detects a boundary shifted by %i sample', async (shift) => {
    const signal = continuousGaplessSignal()
    const reference = await renderReference(signal)
    const shifted = await renderSplit(signal, shift)

    expect(maximumErrorAroundJoin(shifted, reference)).toBeGreaterThan(TOLERANCE)
  })
})
