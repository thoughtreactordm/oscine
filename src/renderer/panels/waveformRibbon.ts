/**
 * Shaping for the now-playing waveform ribbon.
 *
 * Every function here is arithmetic over `Float32Array`s: no canvas, no Web
 * Audio, no DOM. That is not tidiness — `tests/renderer` runs under plain Node
 * with neither an `AudioContext` nor a canvas, so anything that wants a test has
 * to live on this side of the line. The component is then thin enough to be
 * read rather than tested: poll, shape, stroke.
 *
 * Buffers are caller-owned and written in place throughout. The shaper runs
 * inside a `requestAnimationFrame` loop, and a per-frame allocation of a few
 * hundred floats is a garbage-collection pause the user sees as a stutter in
 * the one element on screen whose whole job is to be smooth.
 */

/**
 * Per-frame easing rates, as the fraction of the remaining distance closed each
 * frame.
 *
 * Asymmetric on purpose, and this is the difference between a ribbon that reads
 * as music and one that reads as a random-number generator. Rising fast keeps
 * the attack of a snare legible; falling slowly gives the shape somewhere to
 * fall *from*, so the eye tracks a decaying note instead of watching the whole
 * strip flicker at frame rate.
 */
const DEFAULT_ATTACK = 0.55
const DEFAULT_RELEASE = 0.12

/** Bins closer than this to zero are indistinguishable once blurred. */
const SETTLED_EPSILON = 0.001

/**
 * Fill `into` with the peak magnitude of `samples` under each bin.
 *
 * Peak rather than RMS. RMS is the truer loudness figure and the wrong one
 * here: averaging inside the bin and then blurring across bins is two low-pass
 * filters in series, and what comes out the far end is a smooth sausage that
 * looks the same for a string quartet and a drum solo. The peak survives both.
 *
 * Bins are laid out over the whole window even when they do not divide it
 * evenly; the last bin absorbs the remainder rather than being dropped.
 */
export function fillBinPeaks(samples: Float32Array, into: Float32Array): void {
  const bins = into.length
  if (bins === 0) return
  if (samples.length === 0) {
    into.fill(0)
    return
  }

  const span = samples.length / bins
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor(bin * span)
    // At least one sample per bin, so a window narrower than the bin count
    // still produces a shape rather than a row of zeros.
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((bin + 1) * span)))
    let peak = 0
    for (let index = start; index < end; index += 1) {
      const magnitude = Math.abs(samples[index])
      if (magnitude > peak) peak = magnitude
    }
    into[bin] = peak
  }
}

/**
 * Box-blur `values` across neighbouring bins, in place.
 *
 * The CSS blur that lands on this thing later is a *screen-space* blur: it
 * softens the edge of the shape without changing the shape. Two adjacent bins
 * an octave apart in level still meet at a cliff, and a blurred cliff is a
 * blurred cliff. Smoothing the values first is what makes the outline read as
 * one continuous ribbon.
 *
 * `scratch` must be at least as long as `values`. Edges clamp rather than wrap:
 * the two ends of the strip are not neighbours, and joining them would drag a
 * kick drum on the left into the silence on the right.
 */
export function blurBins(values: Float32Array, scratch: Float32Array, radius: number): void {
  if (radius < 1 || values.length === 0) return

  const last = values.length - 1
  for (let bin = 0; bin <= last; bin += 1) {
    let total = 0
    let count = 0
    const from = Math.max(0, bin - radius)
    const to = Math.min(last, bin + radius)
    for (let neighbour = from; neighbour <= to; neighbour += 1) {
      total += values[neighbour]
      count += 1
    }
    scratch[bin] = total / count
  }
  values.set(scratch.subarray(0, values.length))
}

/**
 * Ease `current` toward `target` in place, and report whether anything is still
 * visibly above zero.
 *
 * The return value is what lets the render loop stop. A ribbon that has decayed
 * to flat is indistinguishable from one that is not being drawn, so continuing
 * to schedule frames for it is pure battery cost on a machine that is, by
 * definition, sitting idle.
 */
export function easeBins(
  current: Float32Array,
  target: Float32Array,
  attack = DEFAULT_ATTACK,
  release = DEFAULT_RELEASE
): boolean {
  let active = false
  for (let bin = 0; bin < current.length; bin += 1) {
    const goal = target[bin]
    const rate = goal > current[bin] ? attack : release
    const next = current[bin] + (goal - current[bin]) * rate
    // Snap the tail to zero. A geometric decay never arrives, and without this
    // the loop below would report "still active" forever on a paused track.
    current[bin] = next < SETTLED_EPSILON && goal < SETTLED_EPSILON ? 0 : next
    if (current[bin] > 0) active = true
  }
  return active
}

export interface WaveformShaperOptions {
  /** Columns across the strip. */
  bins: number
  /** Neighbour radius for `blurBins`. Zero disables spatial smoothing. */
  blurRadius?: number
  attack?: number
  release?: number
}

export interface WaveformShaper {
  /** Current shape, 0..1 per bin. Read-only by convention; do not write. */
  readonly bins: Float32Array
  /** Fold a fresh window of samples in. */
  push(samples: Float32Array): void
  /** Nothing is sounding — ease toward flat. */
  relax(): void
  /** False once the shape has fully decayed, so the caller can stop drawing. */
  readonly active: boolean
}

/**
 * A shaper with its working buffers preallocated.
 *
 * Stateful because the temporal easing is: each frame is a step from the last
 * one, and a pure function would have to be handed its own previous output.
 */
export function createWaveformShaper(options: WaveformShaperOptions): WaveformShaper {
  const count = Math.max(1, Math.floor(options.bins))
  const blurRadius = options.blurRadius ?? 1
  const attack = options.attack ?? DEFAULT_ATTACK
  const release = options.release ?? DEFAULT_RELEASE

  const bins = new Float32Array(count)
  const target = new Float32Array(count)
  const scratch = new Float32Array(count)
  const silence = new Float32Array(count)
  let active = false

  return {
    bins,
    push(samples: Float32Array): void {
      fillBinPeaks(samples, target)
      blurBins(target, scratch, blurRadius)
      active = easeBins(bins, target, attack, release)
    },
    relax(): void {
      active = easeBins(bins, silence, attack, release)
    },
    get active(): boolean {
      return active
    }
  }
}
