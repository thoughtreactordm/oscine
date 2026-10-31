import type { WaveformBuffer } from '../audio/AudioEngine'
import { FALLBACK_SAMPLE_RATE_HZ } from '../audio/eqResponse'
import {
  SPECTRUM_CEIL_DB,
  SPECTRUM_FFT_SIZE,
  SPECTRUM_FLOOR_DB,
  applyHannInto,
  createFftScratch,
  fftMagnitudesInto,
  resampleLogAxisInto
} from '../panels/tools/spectrumModel'

/**
 * The stage visualizer's analysis frame — **W23-1, D35.2**.
 *
 * The host polls `readWaveform` once per rendered frame into {@link
 * AnalysisModel.waveform} and calls {@link AnalysisModel.update}; every effect
 * then reads the one {@link AnalysisFrame} it produces. That is all the audio an
 * effect ever sees (D35: a visualizer is a reader of the tap, never a node).
 *
 * Two rules shape the code:
 *
 * - **Allocation-free.** Every buffer is made once, in {@link createAnalysisModel},
 *   and `update` writes into them through `spectrumModel`'s `…Into` variants.
 *   At 60 fps across a whole stage a per-frame typed array is GC jank.
 * - **Frame-rate independent.** Every time constant is in seconds and applied as
 *   `1 − e^(−dt/τ)`, so a steady input reaches the same values at 30 fps as at
 *   60. `dtSec` is clamped to {@link MAX_FRAME_DT_SEC} so a stall doesn't jump.
 *
 * Like `spectrumModel` this is `@renderer`-free and DOM-free (relative imports,
 * no injected globals), so Vitest covers it under plain Node.
 */

/** The number of log-spaced spectrum bands an effect gets. */
export const ANALYSIS_BANDS = 64
/** The lowest band's centre. Below this a 1024-point FFT has no resolution to give. */
export const ANALYSIS_MIN_HZ = 30
/** The highest band's centre. */
export const ANALYSIS_MAX_HZ = 16000

/** `bass` is the power from {@link ANALYSIS_MIN_HZ} up to this. */
export const BASS_MAX_HZ = 250
/** `treble` is the power from this up to {@link ANALYSIS_MAX_HZ}; between the two is `mid`. */
export const TREBLE_MIN_HZ = 4000

/** The longest step `update` honours; a stalled frame advances by this much and no more. */
export const MAX_FRAME_DT_SEC = 0.1

/** No second onset inside this window of the last one. */
export const ONSET_REFRACTORY_SEC = 0.1

/** Smoothed values all under this, and the frame reads as `silent`. */
export const SILENCE_EPSILON = 0.01

// Attack / release time constants, in seconds. Fast to rise, slow to fall.
const SPECTRUM_ATTACK_SEC = 0.03
const SPECTRUM_RELEASE_SEC = 0.2
const ENERGY_ATTACK_SEC = 0.05
const ENERGY_RELEASE_SEC = 0.25
const LEVEL_ATTACK_SEC = 0.05
const LEVEL_RELEASE_SEC = 0.3

// RMS is mapped onto 0..1 over this range. A full-scale sine's RMS is −3 dBFS.
const LEVEL_FLOOR_DB = -60
const LEVEL_CEIL_DB = -6

/*
 * Band energies are the summed bin power over each range, in dB, mapped onto
 * 0..1 over this window — so a tone reads the same whichever range it is in.
 * (A mean over the log bands would not: below ~250 Hz many bands share one FFT
 * bin, so a bass tone would light a dozen bands and a treble tone two.)
 */
const ENERGY_FLOOR_DB = -50
const ENERGY_CEIL_DB = 0

/*
 * Auto-gain. A slow follower tracks the frame's loudest band (0..1) and every
 * displayed value is multiplied so that follower sits at the target. A gain on
 * the 0..1 scale (rather than a dB offset) keeps the floor pinned at 0: a quiet
 * master narrows the window above the floor instead of lifting the noise. It is
 * there to keep the picture lively, not to process loudness — ReplayGain already
 * sits ahead of the tap.
 */
const AUTO_GAIN_TARGET = 0.85
const AUTO_GAIN_MIN = 0.75
const AUTO_GAIN_MAX = 2.5
const AUTO_GAIN_ATTACK_SEC = 1
const AUTO_GAIN_RELEASE_SEC = 5
/** A frame whose loudest band is under this doesn't move the follower, so silence isn't boosted. */
const AUTO_GAIN_GATE = 0.15

/*
 * Onsets: spectral flux (the mean positive rise across the bands) against a
 * ~1 s running mean times a constant plus a floor.
 */
const FLUX_MEAN_SEC = 1
const ONSET_MEAN_FACTOR = 1.5
const ONSET_FLOOR = 0.02
/** Flux this far over the threshold reads as a full-strength onset. */
const ONSET_FULL_SCALE = 0.25

/** What every effect reads, once per rendered frame. The same object every frame, updated in place. */
export interface AnalysisFrame {
  /** `SPECTRUM_FFT_SIZE` (1024) samples, −1..1, the raw tap. Untouched when the read returned false. */
  readonly waveform: WaveformBuffer
  /** {@link ANALYSIS_BANDS} log-spaced bands, 30 Hz–16 kHz, 0..1, auto-gained and smoothed. */
  readonly spectrum: Float32Array
  /** 0..1, smoothed band energies. */
  readonly bass: number
  readonly mid: number
  readonly treble: number
  /** 0..1, smoothed RMS. */
  readonly level: number
  /** 0..1 strength of an onset this frame; 0 when there is none. */
  readonly onset: number
  /** Everything has settled under {@link SILENCE_EPSILON} — nothing sounding, and the decay is done. */
  readonly silent: boolean
  /** Seconds (of clamped `dtSec`) since the clock was last restarted. */
  readonly timeSec: number
}

export interface AnalysisModel {
  /** The buffer to hand `readWaveform`; the same array as `frame.waveform`. */
  readonly waveform: WaveformBuffer
  /** The frame `update` returns, exposed for readers that don't hold the return value. */
  readonly frame: AnalysisFrame
  /**
   * Advance one rendered frame. `read` is what `readWaveform` returned: true
   * analyses the samples now in {@link waveform}; false leaves them alone and
   * decays every smoothed value towards rest.
   */
  update(read: boolean, dtSec: number): AnalysisFrame
  /** The rate the tap runs at, which places the bands on the FFT's bins. */
  setSampleRate(hz: number): void
  /** Zero `timeSec`, for a newly created effect. */
  restartClock(): void
  /** Straight back to rest: silence, unity gain, no onset history. */
  reset(): void
}

interface MutableFrame {
  waveform: WaveformBuffer
  spectrum: Float32Array
  bass: number
  mid: number
  treble: number
  level: number
  onset: number
  silent: boolean
  timeSec: number
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** One frame-rate-independent step of an attack/release follower. */
function follow(
  current: number,
  target: number,
  dtSec: number,
  attackSec: number,
  releaseSec: number
): number {
  const tau = target > current ? attackSec : releaseSec
  return current + (target - current) * (1 - Math.exp(-dtSec / tau))
}

/** Summed power of `magnitudes[from..to)`, as dB mapped onto 0..1 over the energy window. */
function rangeEnergy(magnitudes: Float32Array, from: number, to: number): number {
  let power = 0
  for (let bin = from; bin < to; bin++) power += magnitudes[bin] * magnitudes[bin]
  if (!(power > 0)) return 0
  return clamp01((10 * Math.log10(power) - ENERGY_FLOOR_DB) / (ENERGY_CEIL_DB - ENERGY_FLOOR_DB))
}

function clampDt(dtSec: number): number {
  if (!(dtSec > 0)) return 0
  return dtSec > MAX_FRAME_DT_SEC ? MAX_FRAME_DT_SEC : dtSec
}

export function createAnalysisModel({
  sampleRateHz = FALLBACK_SAMPLE_RATE_HZ
}: { sampleRateHz?: number } = {}): AnalysisModel {
  // Every buffer the model will ever use, allocated here and only here.
  const waveform: WaveformBuffer = new Float32Array(SPECTRUM_FFT_SIZE)
  const windowed = new Float32Array(SPECTRUM_FFT_SIZE)
  const scratch = createFftScratch(SPECTRUM_FFT_SIZE)
  const magnitudes = new Float32Array(SPECTRUM_FFT_SIZE >> 1)
  const bandsDb = new Float32Array(ANALYSIS_BANDS)
  /** This frame's bands, 0..1, before the auto-gain. */
  const raw = new Float32Array(ANALYSIS_BANDS)
  /** Last analysed frame's `raw`, for flux. */
  const previousRaw = new Float32Array(ANALYSIS_BANDS)
  const spectrum = new Float32Array(ANALYSIS_BANDS)

  const frame: MutableFrame = {
    waveform,
    spectrum,
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    onset: 0,
    silent: true,
    timeSec: 0
  }

  let rateHz = sampleRateHz > 0 ? sampleRateHz : FALLBACK_SAMPLE_RATE_HZ
  // FFT bin edges of the bass / mid / treble ranges, which move with the rate.
  let bassFrom = 0
  let midFrom = 0
  let trebleFrom = 0
  let trebleTo = 0

  function placeRanges(): void {
    const hzPerBin = rateHz / SPECTRUM_FFT_SIZE
    const bins = magnitudes.length
    const edge = (bin: number): number => Math.min(bins, Math.max(1, bin))
    bassFrom = edge(Math.ceil(ANALYSIS_MIN_HZ / hzPerBin))
    midFrom = edge(Math.ceil(BASS_MAX_HZ / hzPerBin))
    trebleFrom = edge(Math.ceil(TREBLE_MIN_HZ / hzPerBin))
    trebleTo = edge(Math.floor(ANALYSIS_MAX_HZ / hzPerBin) + 1)
  }
  placeRanges()
  let gainReference = AUTO_GAIN_TARGET
  let fluxMean = 0
  let sinceOnsetSec = ONSET_REFRACTORY_SEC

  function analyse(dt: number): void {
    applyHannInto(waveform, windowed)
    fftMagnitudesInto(windowed, magnitudes, scratch)
    resampleLogAxisInto(
      magnitudes,
      rateHz,
      bandsDb,
      ANALYSIS_MIN_HZ,
      ANALYSIS_MAX_HZ,
      SPECTRUM_FLOOR_DB
    )

    let peak = 0
    for (let i = 0; i < ANALYSIS_BANDS; i++) {
      const value = clamp01(
        (bandsDb[i] - SPECTRUM_FLOOR_DB) / (SPECTRUM_CEIL_DB - SPECTRUM_FLOOR_DB)
      )
      raw[i] = value
      if (value > peak) peak = value
    }
    if (peak > AUTO_GAIN_GATE) {
      gainReference = follow(gainReference, peak, dt, AUTO_GAIN_ATTACK_SEC, AUTO_GAIN_RELEASE_SEC)
    }
    const ratio = AUTO_GAIN_TARGET / gainReference
    const gain =
      ratio < AUTO_GAIN_MIN ? AUTO_GAIN_MIN : ratio > AUTO_GAIN_MAX ? AUTO_GAIN_MAX : ratio

    // Flux compares both frames under *this* frame's gain, so the gain's own
    // drift is never read as a rise, and a repeated poll of one render quantum
    // is exactly zero.
    let flux = 0
    for (let i = 0; i < ANALYSIS_BANDS; i++) {
      const value = clamp01(raw[i] * gain)
      const before = clamp01(previousRaw[i] * gain)
      if (value > before) flux += value - before
      previousRaw[i] = raw[i]
      spectrum[i] = follow(spectrum[i], value, dt, SPECTRUM_ATTACK_SEC, SPECTRUM_RELEASE_SEC)
    }
    flux /= ANALYSIS_BANDS

    let sumSquares = 0
    for (let i = 0; i < waveform.length; i++) sumSquares += waveform[i] * waveform[i]
    const rms = Math.sqrt(sumSquares / waveform.length)
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : LEVEL_FLOOR_DB
    const level = clamp01(
      clamp01((rmsDb - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB)) * gain
    )

    const bass = clamp01(rangeEnergy(magnitudes, bassFrom, midFrom) * gain)
    const mid = clamp01(rangeEnergy(magnitudes, midFrom, trebleFrom) * gain)
    const treble = clamp01(rangeEnergy(magnitudes, trebleFrom, trebleTo) * gain)
    frame.bass = follow(frame.bass, bass, dt, ENERGY_ATTACK_SEC, ENERGY_RELEASE_SEC)
    frame.mid = follow(frame.mid, mid, dt, ENERGY_ATTACK_SEC, ENERGY_RELEASE_SEC)
    frame.treble = follow(frame.treble, treble, dt, ENERGY_ATTACK_SEC, ENERGY_RELEASE_SEC)
    frame.level = follow(frame.level, level, dt, LEVEL_ATTACK_SEC, LEVEL_RELEASE_SEC)

    const threshold = fluxMean * ONSET_MEAN_FACTOR + ONSET_FLOOR
    frame.onset = 0
    if (flux > threshold && sinceOnsetSec >= ONSET_REFRACTORY_SEC) {
      // Never exactly 0 for a real onset, so `onset > 0` is the test for one.
      frame.onset = Math.max(Number.EPSILON, clamp01((flux - threshold) / ONSET_FULL_SCALE))
      sinceOnsetSec = 0
    }
    fluxMean = follow(fluxMean, flux, dt, FLUX_MEAN_SEC, FLUX_MEAN_SEC)
  }

  /** Nothing sounding: ease every smoothed value toward rest. `waveform` is left as it was. */
  function relax(dt: number): void {
    for (let i = 0; i < ANALYSIS_BANDS; i++) {
      spectrum[i] = follow(spectrum[i], 0, dt, SPECTRUM_ATTACK_SEC, SPECTRUM_RELEASE_SEC)
    }
    frame.bass = follow(frame.bass, 0, dt, ENERGY_ATTACK_SEC, ENERGY_RELEASE_SEC)
    frame.mid = follow(frame.mid, 0, dt, ENERGY_ATTACK_SEC, ENERGY_RELEASE_SEC)
    frame.treble = follow(frame.treble, 0, dt, ENERGY_ATTACK_SEC, ENERGY_RELEASE_SEC)
    frame.level = follow(frame.level, 0, dt, LEVEL_ATTACK_SEC, LEVEL_RELEASE_SEC)
    frame.onset = 0
    fluxMean = follow(fluxMean, 0, dt, FLUX_MEAN_SEC, FLUX_MEAN_SEC)
  }

  function settled(): boolean {
    if (frame.bass >= SILENCE_EPSILON || frame.mid >= SILENCE_EPSILON) return false
    if (frame.treble >= SILENCE_EPSILON || frame.level >= SILENCE_EPSILON) return false
    for (let i = 0; i < ANALYSIS_BANDS; i++) if (spectrum[i] >= SILENCE_EPSILON) return false
    return true
  }

  return {
    waveform,
    frame,
    update(read, dtSec) {
      const dt = clampDt(dtSec)
      frame.timeSec += dt
      sinceOnsetSec += dt
      if (read) analyse(dt)
      else relax(dt)
      frame.silent = settled()
      return frame
    },
    setSampleRate(hz) {
      if (!Number.isFinite(hz) || hz <= 0) return
      rateHz = hz
      placeRanges()
    },
    restartClock() {
      frame.timeSec = 0
    },
    reset() {
      waveform.fill(0)
      spectrum.fill(0)
      previousRaw.fill(0)
      frame.bass = 0
      frame.mid = 0
      frame.treble = 0
      frame.level = 0
      frame.onset = 0
      frame.silent = true
      frame.timeSec = 0
      gainReference = AUTO_GAIN_TARGET
      fluxMean = 0
      sinceOnsetSec = ONSET_REFRACTORY_SEC
    }
  }
}
