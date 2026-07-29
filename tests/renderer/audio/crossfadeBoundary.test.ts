import { OfflineAudioContext } from 'node-web-audio-api'
import { describe, expect, it } from 'vitest'
import { equalPowerCurve } from '../../../src/renderer/audio/equalPower'

async function renderEnvelope(
  direction: 'in' | 'out',
  sampleRate: number,
  crossfadeSec: number
): Promise<{ samples: Float32Array; overlapStart: number; overlapSamples: number }> {
  const leadSamples = Math.round(sampleRate * 0.1)
  const overlapSamples = Math.round(sampleRate * crossfadeSec)
  const overlapStart = leadSamples
  const context = new OfflineAudioContext(1, leadSamples + overlapSamples + 1, sampleRate)
  const sourceSamples = direction === 'in' ? overlapSamples + 1 : leadSamples + overlapSamples
  const buffer = context.createBuffer(1, sourceSamples, sampleRate)
  buffer.copyToChannel(
    Float32Array.from({ length: sourceSamples }, () => 1),
    0
  )

  const source = context.createBufferSource()
  const transition = context.createGain()
  source.buffer = buffer
  transition.gain.value = direction === 'in' ? 0 : 1
  source.connect(transition)
  transition.connect(context.destination)
  transition.gain.setValueCurveAtTime(
    equalPowerCurve(direction),
    overlapStart / sampleRate,
    overlapSamples / sampleRate
  )
  source.start(direction === 'in' ? overlapStart / sampleRate : 0)

  const rendered = await context.startRendering()
  const samples = new Float32Array(rendered.length)
  rendered.copyFromChannel(samples, 0)
  return { samples, overlapStart, overlapSamples }
}

describe('equal-power decoded overlap', () => {
  it.each([
    { sampleRate: 44_100, crossfadeSec: 0.25 },
    { sampleRate: 48_000, crossfadeSec: 0.75 }
  ])(
    'renders complementary $crossfadeSec second envelopes at $sampleRate Hz',
    async ({ sampleRate, crossfadeSec }) => {
      const outgoing = await renderEnvelope('out', sampleRate, crossfadeSec)
      const incoming = await renderEnvelope('in', sampleRate, crossfadeSec)
      const midpoint = outgoing.overlapStart + Math.floor(outgoing.overlapSamples / 2)
      const last = outgoing.overlapStart + outgoing.overlapSamples - 1

      // The native test renderer applies AudioParam automation per render
      // quantum, so endpoint observations allow its sub-percent interpolation
      // offset while midpoint power remains the tighter invariant.
      expect(outgoing.samples[outgoing.overlapStart]).toBeCloseTo(1, 2)
      expect(incoming.samples[incoming.overlapStart]).toBeCloseTo(0, 2)
      expect(outgoing.samples[midpoint]).toBeCloseTo(Math.SQRT1_2, 3)
      expect(incoming.samples[midpoint]).toBeCloseTo(Math.SQRT1_2, 3)
      expect(outgoing.samples[midpoint] ** 2 + incoming.samples[midpoint] ** 2).toBeCloseTo(1, 3)
      expect(outgoing.samples[last]).toBeCloseTo(0, 2)
      expect(incoming.samples[last]).toBeCloseTo(1, 2)
    }
  )
})
