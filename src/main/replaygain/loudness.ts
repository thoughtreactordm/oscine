/**
 * ReplayGain 2.0 / EBU R128 analysis over decoded PCM.
 *
 * The K-weighting filter and gated 400 ms blocks follow ITU-R BS.1770. Gains
 * target -18 LUFS, the ReplayGain 2.0 reference level. Peaks are sample peaks
 * expressed as a linear ratio, matching the tag contract.
 */

export type LoudnessHistogram = Array<[bin: number, count: number]>

export interface ReplayGainAnalysis {
  trackGainDb: number
  trackPeak: number
  histogram: LoudnessHistogram
}

const TARGET_LUFS = -18
const ABSOLUTE_GATE_LUFS = -70
const HISTOGRAM_BINS_PER_LU = 10

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function shelf(sampleRate: number): Biquad {
  const frequency = 1681.974450955533
  const gain = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan((Math.PI * frequency) / sampleRate)
  const vh = 10 ** (gain / 20)
  const vb = vh ** 0.4996667741545416
  const denominator = 1 + k / q + k * k
  return {
    b0: (vh + (vb * k) / q + k * k) / denominator,
    b1: (2 * (k * k - vh)) / denominator,
    b2: (vh - (vb * k) / q + k * k) / denominator,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator
  }
}

function highPass(sampleRate: number): Biquad {
  const frequency = 38.13547087602444
  const q = 0.5003270373238773
  const k = Math.tan((Math.PI * frequency) / sampleRate)
  const denominator = 1 + k / q + k * k
  return {
    b0: 1 / denominator,
    b1: -2 / denominator,
    b2: 1 / denominator,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator
  }
}

function filter(input: Float32Array, coefficients: Biquad): Float64Array {
  const output = new Float64Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < input.length; index++) {
    const x0 = input[index]
    const y0 =
      coefficients.b0 * x0 +
      coefficients.b1 * x1 +
      coefficients.b2 * x2 -
      coefficients.a1 * y1 -
      coefficients.a2 * y2
    output[index] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return output
}

function kWeight(input: Float32Array, sampleRate: number): Float64Array {
  const first = filter(input, shelf(sampleRate))
  // Avoid another public overload just for Float64 input: the filter math is
  // repeated here so the first stage is not rounded back to Float32.
  const coefficients = highPass(sampleRate)
  const output = new Float64Array(first.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < first.length; index++) {
    const x0 = first[index]
    const y0 =
      coefficients.b0 * x0 +
      coefficients.b1 * x1 +
      coefficients.b2 * x2 -
      coefficients.a1 * y1 -
      coefficients.a2 * y2
    output[index] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return output
}

function energyToLufs(energy: number): number {
  return -0.691 + 10 * Math.log10(energy)
}

function lufsToEnergy(lufs: number): number {
  return 10 ** ((lufs + 0.691) / 10)
}

function histogramFromEnergies(energies: readonly number[]): LoudnessHistogram {
  const bins = new Map<number, number>()
  for (const energy of energies) {
    if (!(energy > 0)) continue
    const bin = Math.round(energyToLufs(energy) * HISTOGRAM_BINS_PER_LU)
    bins.set(bin, (bins.get(bin) ?? 0) + 1)
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0])
}

/**
 * BS.1770 channel-energy weights for Web Audio's canonical channel order.
 * Stereo/mono are overwhelmingly common, but handling 4.0/5.0/5.1/7.1 here
 * avoids treating an LFE channel as programme loudness.
 */
function channelWeights(channelCount: number): number[] {
  if (channelCount === 4) return [1, 1, 1.41, 1.41]
  if (channelCount === 5) return [1, 1, 1, 1.41, 1.41]
  if (channelCount === 6) return [1, 1, 1, 0, 1.41, 1.41]
  if (channelCount === 8) return [1, 1, 1, 0, 1.41, 1.41, 1.41, 1.41]
  return Array.from({ length: channelCount }, () => 1)
}

export function integratedLoudness(histogram: readonly [number, number][]): number | null {
  const aboveAbsolute = histogram.filter(
    ([bin]) => bin / HISTOGRAM_BINS_PER_LU >= ABSOLUTE_GATE_LUFS
  )
  if (aboveAbsolute.length === 0) return null

  const mean = (bins: readonly [number, number][]): number => {
    let energy = 0
    let count = 0
    for (const [bin, occurrences] of bins) {
      energy += lufsToEnergy(bin / HISTOGRAM_BINS_PER_LU) * occurrences
      count += occurrences
    }
    return energy / count
  }

  const relativeGate = energyToLufs(mean(aboveAbsolute)) - 10
  const gated = aboveAbsolute.filter(([bin]) => bin / HISTOGRAM_BINS_PER_LU >= relativeGate)
  return energyToLufs(mean(gated))
}

export function mergeHistograms(
  histograms: readonly (readonly [number, number][])[]
): LoudnessHistogram {
  const merged = new Map<number, number>()
  for (const histogram of histograms) {
    for (const [bin, count] of histogram) {
      merged.set(bin, (merged.get(bin) ?? 0) + count)
    }
  }
  return [...merged.entries()].sort((a, b) => a[0] - b[0])
}

export function analyzePcm(
  channels: readonly Float32Array[],
  sampleRate: number
): ReplayGainAnalysis {
  if (channels.length === 0 || channels[0].length === 0 || !(sampleRate > 0)) {
    throw new Error('Decoded audio contains no samples.')
  }

  const length = Math.min(...channels.map((channel) => channel.length))
  let peak = 0
  const weighted = channels.map((channel) => {
    for (let index = 0; index < length; index++) {
      peak = Math.max(peak, Math.abs(channel[index]))
    }
    return kWeight(channel.subarray(0, length), sampleRate)
  })
  const weights = channelWeights(channels.length)

  const windowLength = Math.min(length, Math.max(1, Math.round(sampleRate * 0.4)))
  const step = Math.max(1, Math.round(sampleRate * 0.1))
  const energies: number[] = []
  for (let start = 0; start + windowLength <= length; start += step) {
    let energy = 0
    for (let channelIndex = 0; channelIndex < weighted.length; channelIndex++) {
      const channel = weighted[channelIndex]
      let channelEnergy = 0
      for (let index = start; index < start + windowLength; index++) {
        channelEnergy += channel[index] * channel[index]
      }
      energy += (weights[channelIndex] * channelEnergy) / windowLength
    }
    energies.push(energy)
  }

  const histogram = histogramFromEnergies(energies)
  const loudness = integratedLoudness(histogram)
  if (loudness === null) throw new Error('Audio is silent; loudness is undefined.')

  return {
    trackGainDb: TARGET_LUFS - loudness,
    trackPeak: peak,
    histogram
  }
}

export function gainFromHistogram(histogram: readonly [number, number][]): number | null {
  const loudness = integratedLoudness(histogram)
  return loudness === null ? null : TARGET_LUFS - loudness
}
