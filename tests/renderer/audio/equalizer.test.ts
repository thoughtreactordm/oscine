import { describe, expect, it, vi } from 'vitest'
import {
  EqualizerRouter,
  EQUALIZER_BAND_LIMIT,
  FLAT_EQUALIZER_SPEC,
  type BiquadCapableContext,
  type EqAudioNode,
  type EqBiquadFilterNode,
  type EqGainNode,
  type EqualizerBand,
  type EqualizerSpec
} from '../../../src/renderer/audio/equalizer'

/**
 * A parameter that records how it was written. `.value =` is the zipper-noise
 * mistake the router must never make after construction; `setTargetAtTime` is
 * the ramp it must always use instead. Both are counted so a test can assert the
 * distinction directly, and the target is folded into `value` so parked and
 * clamped values are readable off the node.
 */
class FakeParam {
  #value: number
  directWrites = 0
  readonly targets: { target: number; timeConstant: number }[] = []

  constructor(initial: number) {
    this.#value = initial
  }

  get value(): number {
    return this.#value
  }

  set value(next: number) {
    this.#value = next
    this.directWrites += 1
  }

  setTargetAtTime(target: number, _startTime: number, timeConstant: number): void {
    this.targets.push({ target, timeConstant })
    this.#value = target
  }
}

class FakeNode implements EqAudioNode {
  readonly outputs: EqAudioNode[] = []

  connect(destination: EqAudioNode): EqAudioNode {
    this.outputs.push(destination)
    return destination
  }

  disconnect(): void {
    this.outputs.length = 0
  }
}

class FakeGain extends FakeNode implements EqGainNode {
  readonly gain = new FakeParam(1)
}

class FakeBiquad extends FakeNode implements EqBiquadFilterNode {
  type = 'peaking'
  readonly frequency = new FakeParam(350)
  readonly gain = new FakeParam(0)
  readonly Q = new FakeParam(1)
  readonly failRamp: boolean

  constructor(failRamp: boolean) {
    super()
    this.failRamp = failRamp
    if (failRamp) {
      this.frequency.setTargetAtTime = () => {
        throw new Error('wedged context')
      }
    }
  }
}

class FakeContext implements BiquadCapableContext {
  state = 'running'
  currentTime = 0
  sampleRate: number
  readonly destination = new FakeNode()
  readonly gains: FakeGain[] = []
  readonly biquads: FakeBiquad[] = []
  #failRamp: boolean

  constructor(sampleRate = 48000, failRamp = false) {
    this.sampleRate = sampleRate
    this.#failRamp = failRamp
  }

  createGain(): EqGainNode {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }

  createBiquadFilter(): EqBiquadFilterNode {
    const biquad = new FakeBiquad(this.#failRamp)
    this.biquads.push(biquad)
    return biquad
  }
}

/** The five gains the chain owns, resolved from the returned input by topology. */
function roles(ctx: FakeContext, input: EqAudioNode) {
  const in_ = input as unknown as FakeGain
  const [preamp, dry] = in_.outputs as FakeGain[]
  const wet = ctx.biquads[EQUALIZER_BAND_LIMIT - 1].outputs[0] as FakeGain
  const output = wet.outputs[0] as FakeGain
  return { input: in_, preamp, dry, wet, output }
}

function band(overrides: Partial<EqualizerBand> = {}): EqualizerBand {
  return {
    id: overrides.id ?? 'b',
    type: overrides.type ?? 'peaking',
    frequencyHz: overrides.frequencyHz ?? 1000,
    gainDb: overrides.gainDb ?? 6,
    q: overrides.q ?? 1,
    enabled: overrides.enabled ?? true
  }
}

function spec(bands: EqualizerBand[], overrides: Partial<EqualizerSpec> = {}): EqualizerSpec {
  return { enabled: overrides.enabled ?? true, preampDb: overrides.preampDb ?? 0, bands }
}

describe('EqualizerRouter', () => {
  it('defaults to a flat, disabled spec so it changes nothing audible', () => {
    const router = new EqualizerRouter()
    expect(router.spec).toBe(FLAT_EQUALIZER_SPEC)
    expect(router.spec.enabled).toBe(false)
    expect(router.spec.preampDb).toBe(0)
    expect(router.spec.bands).toHaveLength(0)

    const ctx = new FakeContext()
    const { wet, dry } = roles(ctx, router.attach(ctx))
    // Bypassed by construction: the clean input passes through dry, the biquads
    // never reach the output.
    expect(dry.gain.value).toBe(1)
    expect(wet.gain.value).toBe(0)
  })

  it('builds exactly 12 biquads plus preamp, dry, wet and output, and returns the input', () => {
    const router = new EqualizerRouter()
    const ctx = new FakeContext()

    const input = router.attach(ctx)

    // input, preamp, wet, dry, output.
    expect(ctx.gains).toHaveLength(5)
    expect(ctx.biquads).toHaveLength(EQUALIZER_BAND_LIMIT)
    expect(input as unknown).toBe(ctx.gains[0])
  })

  it('wires the documented chain and reaches destination exactly once', () => {
    const router = new EqualizerRouter()
    const ctx = new FakeContext()

    const { input, preamp, dry, wet, output } = roles(ctx, router.attach(ctx))

    // input → preamp → biquad0 → … → biquad11 → wet → output → destination,
    // and input → dry → output.
    expect(input.outputs).toEqual([preamp, dry])
    expect(preamp.outputs).toEqual([ctx.biquads[0]])
    for (let i = 0; i < EQUALIZER_BAND_LIMIT - 1; i += 1) {
      expect(ctx.biquads[i].outputs).toEqual([ctx.biquads[i + 1]])
    }
    expect(ctx.biquads[EQUALIZER_BAND_LIMIT - 1].outputs).toEqual([wet])
    expect(wet.outputs).toEqual([output])
    expect(dry.outputs).toEqual([output])
    expect(output.outputs).toEqual([ctx.destination])

    const toDestination = [...ctx.gains, ...ctx.biquads].filter((node) =>
      node.outputs.includes(ctx.destination)
    )
    expect(toDestination).toEqual([output])
  })

  it('parks the biquads a spec does not use at flat peaking', () => {
    const router = new EqualizerRouter()
    router.setSpec(
      spec([
        band({ id: '0', type: 'lowshelf', frequencyHz: 100, gainDb: 4, q: 0.7 }),
        band({ id: '1', frequencyHz: 1000, gainDb: -3, q: 2 }),
        band({ id: '2', type: 'highshelf', frequencyHz: 8000, gainDb: 5, q: 0.7 })
      ])
    )
    const ctx = new FakeContext()

    router.attach(ctx)

    expect(ctx.biquads[0].type).toBe('lowshelf')
    expect(ctx.biquads[1].gain.value).toBe(-3)
    expect(ctx.biquads[2].type).toBe('highshelf')
    for (let i = 3; i < EQUALIZER_BAND_LIMIT; i += 1) {
      // A parked band left at a stale gain would be an audible bug.
      expect(ctx.biquads[i].type).toBe('peaking')
      expect(ctx.biquads[i].gain.value).toBe(0)
      expect(ctx.biquads[i].Q.value).toBe(1)
    }
  })

  it('parks a band that exists but is disabled', () => {
    const router = new EqualizerRouter()
    router.setSpec(spec([band({ id: '0', gainDb: 9, enabled: false })]))
    const ctx = new FakeContext()

    router.attach(ctx)

    expect(ctx.biquads[0].type).toBe('peaking')
    expect(ctx.biquads[0].gain.value).toBe(0)
  })

  it('creates and destroys no nodes when a band is added or removed', () => {
    const router = new EqualizerRouter()
    const ctx = new FakeContext()
    router.attach(ctx)
    const gains = ctx.gains.length
    const biquads = ctx.biquads.length

    router.setSpec(spec([band({ id: '0' }), band({ id: '1' }), band({ id: '2' })]))
    router.setSpec(spec([band({ id: '0' })]))

    expect(ctx.gains).toHaveLength(gains)
    expect(ctx.biquads).toHaveLength(biquads)
  })

  it('ramps every parameter and never assigns a biquad value directly after construction', () => {
    const router = new EqualizerRouter()
    const ctx = new FakeContext()
    router.attach(ctx)
    const writesAtConstruction = ctx.biquads.map((b) => ({
      frequency: b.frequency.directWrites,
      gain: b.gain.directWrites,
      Q: b.Q.directWrites
    }))

    router.setSpec(spec([band({ id: '0', frequencyHz: 2000, gainDb: 5, q: 3 })], { preampDb: -2 }))

    ctx.biquads.forEach((b, i) => {
      expect(b.frequency.directWrites).toBe(writesAtConstruction[i].frequency)
      expect(b.gain.directWrites).toBe(writesAtConstruction[i].gain)
      expect(b.Q.directWrites).toBe(writesAtConstruction[i].Q)
      expect(b.frequency.targets.length).toBeGreaterThan(0)
      expect(b.gain.targets.length).toBeGreaterThan(0)
      expect(b.Q.targets.length).toBeGreaterThan(0)
    })
    const { preamp } = roles(ctx, ctx.gains[0])
    expect(preamp.gain.targets.at(-1)?.target).toBeCloseTo(Math.pow(10, -2 / 20))
  })

  it('clamps out-of-range band values', () => {
    const router = new EqualizerRouter()
    router.setSpec(
      spec([
        band({ id: '0', frequencyHz: 5, gainDb: 400, q: 100 }),
        band({ id: '1', frequencyHz: 30000, gainDb: -400, q: 0.001 })
      ])
    )
    const ctx = new FakeContext(48000)

    router.attach(ctx)

    expect(ctx.biquads[0].frequency.value).toBe(20)
    expect(ctx.biquads[0].gain.value).toBe(24)
    expect(ctx.biquads[0].Q.value).toBe(18)
    // 30 kHz is above the 20 kHz ceiling; Nyquist is higher here so 20 kHz wins.
    expect(ctx.biquads[1].frequency.value).toBe(20000)
    expect(ctx.biquads[1].gain.value).toBe(-24)
    expect(ctx.biquads[1].Q.value).toBeCloseTo(0.1)
  })

  it('clamps a frequency above Nyquist rather than passing it to a biquad', () => {
    const router = new EqualizerRouter()
    router.setSpec(spec([band({ id: '0', frequencyHz: 18000 })]))
    // Nyquist is 4 kHz here; 18 kHz would make a biquad produce NaN.
    const ctx = new FakeContext(8000)

    router.attach(ctx)

    expect(ctx.biquads[0].frequency.value).toBe(4000)
    expect(Number.isNaN(ctx.biquads[0].frequency.value)).toBe(false)
  })

  it('reaches every attached context, including one attached afterwards', () => {
    const router = new EqualizerRouter()
    const first = new FakeContext()
    router.attach(first)

    router.setSpec(spec([band({ id: '0', gainDb: 6 })]))
    expect(first.biquads[0].gain.value).toBe(6)

    const later = new FakeContext()
    router.attach(later)
    // The context built after the spec was set still gets it.
    expect(later.biquads[0].gain.value).toBe(6)

    router.setSpec(spec([band({ id: '0', gainDb: -4 })]))
    expect(first.biquads[0].gain.value).toBe(-4)
    expect(later.biquads[0].gain.value).toBe(-4)
  })

  it('prunes a closed context and never touches it again', () => {
    const router = new EqualizerRouter()
    const closed = new FakeContext()
    const live = new FakeContext()
    router.attach(closed)
    router.attach(live)
    const targetsBefore = closed.biquads[0].gain.targets.length
    closed.state = 'closed'

    router.setSpec(spec([band({ id: '0', gainDb: 6 })]))

    expect(closed.biquads[0].gain.targets).toHaveLength(targetsBefore)
    expect(live.biquads[0].gain.value).toBe(6)
  })

  it('keeps updating the other contexts when one throws', () => {
    const router = new EqualizerRouter()
    const broken = new FakeContext(48000, true)
    const working = new FakeContext()
    router.attach(broken)
    router.attach(working)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => router.setSpec(spec([band({ id: '0', gainDb: 6 })]))).not.toThrow()

    expect(working.biquads[0].gain.value).toBe(6)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
