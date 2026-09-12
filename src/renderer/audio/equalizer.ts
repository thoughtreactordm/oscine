/**
 * A parametric EQ filter chain, one per `AudioContext` the audio module owns.
 *
 * The EQ is deliberately not part of `AudioEngine`, for the same reason the
 * output device is not (see `outputDevice.ts`): there is no master bus in this
 * app. The graph terminates in two places — the decoded path's master gain and
 * the streaming path's — and up to three contexts are live at once: the pool
 * hands one pooled context to both decoded scheduler slots, and each streaming
 * engine builds its own. An engine-level EQ would be per-slot, which during a
 * crossfade is twice the biquads and two parameter targets to keep in sync for
 * no benefit, and would rebuild the chain at every gapless boundary. Placed per
 * context — one chain between the master gains and `destination` — it survives
 * both, and matches how the sink is already handled.
 *
 * The router below is the shape that matches: one desired spec, applied to every
 * live chain, and applied again to each new context as it is attached.
 */

import {
  EQUALIZER_BAND_LIMIT,
  FLAT_EQUALIZER_SPEC,
  type EqualizerBand,
  type EqualizerSpec
} from '@shared/audio/equalizer'
import { dbToLinear } from './normalization'

// The spec vocabulary now lives in `@shared/audio/equalizer` so the settings
// layer can validate a stored curve before it reaches these biquads; the router
// re-exports it so `index.ts`, `eqResponse.ts` and every existing importer that
// reaches for `./equalizer` are unaffected.
export {
  EQUALIZER_BAND_LIMIT,
  FLAT_EQUALIZER_SPEC,
  type EqualizerBand,
  type EqualizerSpec
} from '@shared/audio/equalizer'

/**
 * ~10ms. A raw `.value =` on `frequency`, `gain` or `Q` steps the parameter
 * within one render quantum — audible as zipper noise while a handle is dragged
 * at pointer-move rate — so every parameter change is a `setTargetAtTime` glide
 * instead.
 */
const PARAM_RAMP_TIME_CONSTANT = 0.01

/**
 * 0.015, the constant both playback paths already use for volume. Dry/wet is
 * ramped rather than reconnected so enable/disable and A/B compare are
 * click-free; disconnecting a live node gives a click.
 */
const BYPASS_RAMP_TIME_CONSTANT = 0.015

/** Frequency a parked biquad sits at. Inaudible at 0 dB, so any value is flat. */
const PARKED_FREQUENCY_HZ = 1000

/**
 * The time-domain window the clip tap reads each frame — a power of two large
 * enough to cover a display frame's worth of samples at 48 kHz (~800), so no
 * sample slips between two `rAF` reads unseen. Small: the indicator wants a peak,
 * not a spectrum.
 */
const CLIP_ANALYSER_FFT_SIZE = 1024

/** The slice of Web Audio the chain needs. Keeps the router testable with no Web Audio. */
export interface EqAudioParam {
  value: number
  setTargetAtTime(target: number, startTime: number, timeConstant: number): void
}

export interface EqAudioNode {
  connect(destination: EqAudioNode): unknown
  /** No argument tears down every edge; a node argument drops just that one edge. */
  disconnect(destination?: EqAudioNode): void
}

/**
 * The read-only sliver of `AnalyserNode` the clip tap uses. Only the time-domain
 * read and `fftSize` — no frequency data, so the fake in the tests is three lines.
 */
export interface EqAnalyserNode extends EqAudioNode {
  fftSize: number
  getFloatTimeDomainData(array: Float32Array): void
}

export interface EqGainNode extends EqAudioNode {
  readonly gain: EqAudioParam
}

export interface EqBiquadFilterNode extends EqAudioNode {
  type: string
  readonly frequency: EqAudioParam
  readonly gain: EqAudioParam
  readonly Q: EqAudioParam
}

/**
 * The slice of `AudioContext` this module needs — the peer of
 * `SinkCapableContext`. A real `AudioContext` satisfies it structurally.
 */
export interface BiquadCapableContext {
  readonly state: string
  readonly currentTime: number
  readonly sampleRate: number
  readonly destination: EqAudioNode
  createGain(): EqGainNode
  createBiquadFilter(): EqBiquadFilterNode
  createAnalyser(): EqAnalyserNode
}

/**
 * One built EQ chain and the nodes `setSpec` re-targets:
 *
 *   input → preamp → [12 biquads, serial] → wet ─┐
 *         └───────────────────────────────── dry ┴→ output → destination
 */
interface EqChain {
  context: BiquadCapableContext
  input: EqGainNode
  preamp: EqGainNode
  biquads: EqBiquadFilterNode[]
  dry: EqGainNode
  wet: EqGainNode
  output: EqGainNode
  /** The clip tap, present only while at least one `ClipTap` is subscribed. */
  analyser: EqAnalyserNode | null
}

/**
 * A live subscription to the EQ output's peak level, for the R11 clip indicator.
 *
 * The analyser it reads is attached lazily to every chain on the first tap and
 * torn down on the last, so an operator who never opens the equalizer pane pays
 * for nothing. It taps `output` — after the pre-amp, the bands and the dry/wet
 * mix — so it sees exactly what the EQ sends on toward the device, which is the
 * only clipping it can honestly claim.
 */
export interface ClipTap {
  /** The largest output sample magnitude across every live chain, this instant. */
  peak(): number
  /** Release this tap; the analysers come down when the last tap goes. Idempotent. */
  release(): void
}

/** The largest sample magnitude in a time-domain buffer — full scale is 1.0. */
export function peakMagnitude(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

function clampFrequencyHz(hz: number, nyquistHz: number): number {
  const maxHz = Math.min(20000, nyquistHz)
  if (!Number.isFinite(hz)) return Math.min(PARKED_FREQUENCY_HZ, maxHz)
  return Math.min(maxHz, Math.max(20, hz))
}

function clampGainDb(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.min(24, Math.max(-24, db))
}

function clampQ(q: number): number {
  if (!Number.isFinite(q)) return 1
  return Math.min(18, Math.max(0.1, q))
}

export class EqualizerRouter {
  readonly #chains = new Set<EqChain>()
  #spec: EqualizerSpec = FLAT_EQUALIZER_SPEC
  /** Live `ClipTap` count. The analysers exist iff this is non-zero. */
  #clipTaps = 0
  /** One reusable read buffer for every chain and every frame — no per-poll alloc. */
  readonly #clipSamples = new Float32Array(CLIP_ANALYSER_FFT_SIZE)

  get spec(): EqualizerSpec {
    return this.#spec
  }

  /**
   * Build a chain on a freshly created context and target it at the current
   * spec, then return the node to connect INTO — the chain's input.
   *
   * The twelve biquads are allocated once, here, and never again: `setSpec`
   * re-targets them, so adding or removing a band never touches a running graph.
   * Unused biquads are parked flat (peaking, 0 dB, Q 1) rather than removed.
   *
   * The initial spec is written straight to `.value`, not ramped: nothing is
   * playing through a context on the frame it is created, so there is no glide
   * to protect. Every write after this one goes through `setTargetAtTime`.
   */
  attach(context: BiquadCapableContext): AudioNode {
    this.#prune()

    const input = context.createGain()
    const preamp = context.createGain()
    const wet = context.createGain()
    const dry = context.createGain()
    const output = context.createGain()
    const biquads = Array.from({ length: EQUALIZER_BAND_LIMIT }, () => context.createBiquadFilter())

    input.connect(preamp)
    let node: EqAudioNode = preamp
    for (const biquad of biquads) {
      node.connect(biquad)
      node = biquad
    }
    node.connect(wet)
    wet.connect(output)
    input.connect(dry)
    dry.connect(output)
    output.connect(context.destination)

    const chain: EqChain = { context, input, preamp, biquads, dry, wet, output, analyser: null }
    this.#chains.add(chain)
    this.#applyImmediate(chain, this.#spec)
    // A context built while the pane is open joins the tap; one built while it is
    // shut stays analyser-free until the first subscription. Either way the tap
    // hangs off `output`, which is already wired to `destination` above.
    if (this.#clipTaps > 0) this.#attachAnalyser(chain)
    // The one bridge from the minimal node world the router is built and tested
    // in to the real Web Audio graph: at runtime `input` is the `GainNode` the
    // context actually created, and the caller connects a real master gain into
    // it. Tests pass a fake context and read the fake nodes back off it.
    return input as unknown as AudioNode
  }

  /**
   * Point every live chain at a spec. Clamped here — the router is what protects
   * the audio device, and a `frequencyHz` above Nyquist makes a biquad produce
   * NaN, which is silence until the context is rebuilt. Failures are reported,
   * never thrown: one context failing must not leave the others on a stale spec.
   */
  setSpec(spec: EqualizerSpec): void {
    this.#spec = spec
    this.#prune()
    for (const chain of this.#chains) {
      try {
        this.#applyRamped(chain, spec)
      } catch (error) {
        // Not rethrown: see the class comment. A single wedged context must not
        // strand the rest on the previous curve.
        console.warn('[audio] could not apply the equalizer spec to a context:', error)
      }
    }
  }

  /**
   * Begin observing the EQ output's peak level. The first tap attaches an
   * analyser to every live chain; the last one released tears them all down.
   *
   * The returned `release` is idempotent — a leaked poll releasing twice must not
   * drive the count negative and strand the analysers attached — so the pane can
   * call it from an unmount hook without bookkeeping.
   */
  subscribeClip(): ClipTap {
    this.#prune()
    this.#clipTaps += 1
    if (this.#clipTaps === 1) {
      for (const chain of this.#chains) this.#attachAnalyser(chain)
    }
    let released = false
    return {
      peak: () => this.#readClipPeak(),
      release: () => {
        if (released) return
        released = true
        this.#clipTaps -= 1
        if (this.#clipTaps === 0) {
          for (const chain of this.#chains) this.#detachAnalyser(chain)
        }
      }
    }
  }

  /** Hang a clip-reading analyser off a chain's output, once. */
  #attachAnalyser(chain: EqChain): void {
    if (chain.analyser) return
    const analyser = chain.context.createAnalyser()
    analyser.fftSize = CLIP_ANALYSER_FFT_SIZE
    // A leaf tap: `output` already reaches `destination`, so the analyser only
    // listens and is left unconnected onward — the same shape the waveform
    // analysers use (see `DecodedAudioEngine`), so it never becomes a second
    // route out.
    chain.output.connect(analyser)
    chain.analyser = analyser
  }

  /** Remove a chain's clip tap, dropping just the `output → analyser` edge. */
  #detachAnalyser(chain: EqChain): void {
    if (!chain.analyser) return
    // Disconnect the specific edge, not `output` wholesale — `output → destination`
    // must survive, or detaching the indicator would silence the chain.
    chain.output.disconnect(chain.analyser)
    chain.analyser = null
  }

  /** The largest output sample across every live chain's analyser, right now. */
  #readClipPeak(): number {
    this.#prune()
    let peak = 0
    for (const chain of this.#chains) {
      if (!chain.analyser) continue
      chain.analyser.getFloatTimeDomainData(this.#clipSamples)
      const chainPeak = peakMagnitude(this.#clipSamples)
      if (chainPeak > peak) peak = chainPeak
    }
    return peak
  }

  /** Snap a newly built chain to the spec with direct assignments. */
  #applyImmediate(chain: EqChain, spec: EqualizerSpec): void {
    chain.input.gain.value = 1
    chain.output.gain.value = 1
    chain.preamp.gain.value = dbToLinear(spec.preampDb)
    const [wet, dry] = mix(spec.enabled)
    chain.wet.gain.value = wet
    chain.dry.gain.value = dry
    const nyquistHz = chain.context.sampleRate / 2
    chain.biquads.forEach((biquad, index) => {
      const band = spec.bands[index]
      const target = bandTarget(band, nyquistHz)
      biquad.type = target.type
      biquad.frequency.value = target.frequencyHz
      biquad.gain.value = target.gainDb
      biquad.Q.value = target.q
    })
  }

  /** Glide a live chain to the spec. No direct `.value` writes past construction. */
  #applyRamped(chain: EqChain, spec: EqualizerSpec): void {
    const now = chain.context.currentTime
    chain.preamp.gain.setTargetAtTime(dbToLinear(spec.preampDb), now, PARAM_RAMP_TIME_CONSTANT)
    const [wet, dry] = mix(spec.enabled)
    chain.wet.gain.setTargetAtTime(wet, now, BYPASS_RAMP_TIME_CONSTANT)
    chain.dry.gain.setTargetAtTime(dry, now, BYPASS_RAMP_TIME_CONSTANT)
    const nyquistHz = chain.context.sampleRate / 2
    chain.biquads.forEach((biquad, index) => {
      const band = spec.bands[index]
      const target = bandTarget(band, nyquistHz)
      // `type` cannot be ramped; it is a discrete swap. Type changes are rare and
      // operator-initiated, so the transient is accepted.
      biquad.type = target.type
      biquad.frequency.setTargetAtTime(target.frequencyHz, now, PARAM_RAMP_TIME_CONSTANT)
      biquad.gain.setTargetAtTime(target.gainDb, now, PARAM_RAMP_TIME_CONSTANT)
      biquad.Q.setTargetAtTime(target.q, now, PARAM_RAMP_TIME_CONSTANT)
    })
  }

  /**
   * Forget chains on closed contexts.
   *
   * The pool closes its context when the last slot releases and each streaming
   * platform closes its own; neither tells this router, and neither should have
   * to. Holding a closed chain would leak it and make every later `setSpec` do
   * work that can only fail.
   */
  #prune(): void {
    for (const chain of this.#chains) {
      if (chain.context.state === 'closed') this.#chains.delete(chain)
    }
  }
}

/** [wet, dry]. Enabled routes the processed path; disabled routes the clean input. */
function mix(enabled: boolean): [number, number] {
  return enabled ? [1, 0] : [0, 1]
}

/** The clamped node values for one biquad slot; a missing or disabled band parks flat. */
function bandTarget(
  band: EqualizerBand | undefined,
  nyquistHz: number
): { type: EqualizerBand['type']; frequencyHz: number; gainDb: number; q: number } {
  if (!band || !band.enabled) {
    return { type: 'peaking', frequencyHz: PARKED_FREQUENCY_HZ, gainDb: 0, q: 1 }
  }
  return {
    type: band.type,
    frequencyHz: clampFrequencyHz(band.frequencyHz, nyquistHz),
    gainDb: clampGainDb(band.gainDb),
    q: clampQ(band.q)
  }
}
