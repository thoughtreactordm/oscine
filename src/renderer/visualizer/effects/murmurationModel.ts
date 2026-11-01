import type { AnalysisFrame } from '../analysisFrame'
import { follow } from './draw2d'
import { dominantBand } from './rainfallModel'

/**
 * Murmuration's per-frame parameters — **W23-12, D35.9, D35.11**. The shaders
 * are in `murmuration.ts`. This file holds everything that decides *how much*
 * and *when*, pure and DOM-free, so the card's properties can be tested
 * without a GPU.
 *
 * **The flock** is a few thousand particles whose state lives on the GPU. A
 * transform feedback pass integrates each particle once a frame, and no CPU
 * loop touches them. Each particle follows a curl-noise flow field with some
 * inertia. A soft elliptical boundary around a wandering centre keeps the
 * particles together as one cloud: inside it they only follow the flow, and
 * outside it a spring pulls them back. The centre, the ellipse's radii and its
 * angle all drift slowly on a clock of the model's own ({@link flockShape}),
 * so the cloud stretches and turns rather than sitting still.
 *
 * **Bass** sets the flow speed, through a follower, so a kick drum speeds the
 * whole flock up smoothly rather than jolting it.
 *
 * **Onsets scatter the flock.** The flash guard's onset is already an envelope
 * (D35.8). `scatter` follows it up as it rises and decays over
 * {@link SCATTER_TAU_SEC}. Each time the envelope starts rising again, a new
 * scatter point is picked from the band that rose most: low bands below the
 * flock's centre, highs above it, on a random side. While `scatter` is up,
 * particles near the point are pushed outward and the boundary spring
 * slackens. As it decays, the spring pulls the cloud back together. Every push
 * is an acceleration, so it changes positions smoothly and never brightness:
 * the flock can't strobe.
 *
 * **Count** follows the internal target's pixel count ({@link particleCount}).
 * That count is what the quality tier sets: `low` caps it at about a megapixel,
 * `auto` at 1080p (lower while backed off), and `high` leaves it native. So
 * the flock thins with the tier without the effect being recreated, including
 * during `auto`'s backoff.
 *
 * Every follower is an exact exponential in `dtSec`. Nothing is allocated per
 * update.
 */

/** Particles per megapixel of internal target, and the bounds. */
export const PARTICLES_PER_MEGAPIXEL = 2400
export const MIN_PARTICLES = 2000
export const MAX_PARTICLES = 8192

/** Flow speed in stage heights a second: silent bass to full bass. */
export const SPEED_MIN = 0.1
export const SPEED_MAX = 0.34
const SPEED_TAU_SEC = 0.35

/** How long the scatter takes to decay once the onset envelope falls. */
export const SCATTER_TAU_SEC = 0.5
/** A rise smaller than this is noise in the envelope, not an onset. */
const RISE_EPSILON = 1e-4
/** The scatter point's distance from the centre, as a share of the mean radius. */
export const SCATTER_OFFSET = 0.55

/** The ellipse's mean radius, in stage heights, and how much its axes breathe. */
export const FLOCK_RADIUS = 0.24
export const FLOCK_STRETCH = 0.35
/** The farthest the centre wanders from the middle, as a share of half the stage. */
export const FLOCK_WANDER_X = 0.5
export const FLOCK_WANDER_Y = 0.32
/** How fast the flock's own clock runs, against seconds: faster with more bass. */
const CLOCK_MIN = 0.7
const CLOCK_MAX = 1.3

export interface FlockShape {
  /** The centre, in stage units: x in ±aspect/2, y in ±0.5, y up. */
  x: number
  y: number
  /** Semi-axes, in stage heights. */
  radiusX: number
  radiusY: number
  /** The ellipse's angle, radians. */
  angle: number
}

export interface MurmurationParams extends FlockShape {
  /** Flow speed, stage heights a second. */
  speed: number
  /** 0..1, the scatter's strength. */
  scatter: number
  /** Where the current scatter pushes from, stage units. */
  scatterX: number
  scatterY: number
  /** The model's clock, seconds; drives the flow field's evolution. */
  time: number
  /** How much of the flock to show (the flash guard, D35.8). */
  present: number
}

export interface MurmurationModel {
  readonly params: Readonly<MurmurationParams>
  update(
    audio: AnalysisFrame,
    intensity: number,
    aspect: number,
    dtSec: number
  ): Readonly<MurmurationParams>
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** mulberry32: small, seedable, good enough for picking a side. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** How many particles to run for an internal target of this size. */
export function particleCount(width: number, height: number): number {
  const pixels = Math.max(0, width) * Math.max(0, height)
  const count = Math.round((pixels / 1e6) * PARTICLES_PER_MEGAPIXEL)
  return Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, count))
}

/**
 * The flock's centre and boundary at time `t` on the model's clock: slow,
 * incommensurate sines, so the path never visibly repeats. The ellipse always
 * fits inside the stage's height. Writes into `out`.
 */
export function flockShape(t: number, aspect: number, out: FlockShape): FlockShape {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  const breathe = Math.sin(t * 0.083 + 1.1)
  out.radiusX = FLOCK_RADIUS * (1 + FLOCK_STRETCH * breathe)
  out.radiusY = FLOCK_RADIUS * (1 - FLOCK_STRETCH * breathe)
  out.angle = 0.6 * Math.sin(t * 0.047) + 0.25 * Math.sin(t * 0.119 + 2)
  const roomX = Math.max(0, a / 2 - FLOCK_RADIUS * (1 + FLOCK_STRETCH))
  const roomY = Math.max(0, 0.5 - FLOCK_RADIUS * (1 + FLOCK_STRETCH))
  out.x = roomX * FLOCK_WANDER_X * 2 * (0.7 * Math.sin(t * 0.061) + 0.3 * Math.sin(t * 0.137 + 0.5))
  out.y = roomY * FLOCK_WANDER_Y * 2 * (0.7 * Math.sin(t * 0.073 + 2.3) + 0.3 * Math.sin(t * 0.17))
  // The sums above reach ±1 at most, so the centre stays within the room.
  return out
}

/**
 * The scatter point's angle about the centre for a band: the lowest band
 * straight down, the highest straight up, swept round on the side given.
 */
export function scatterAngle(band: number, bands: number, side: 1 | -1): number {
  const t = bands > 1 && band >= 0 ? band / (bands - 1) : 0.5
  // −π/2 (down) to +π/2 (up), through the right; mirrored for the left.
  const right = -Math.PI / 2 + Math.PI * clamp01(t)
  return side === 1 ? right : Math.PI - right
}

export function createMurmurationModel(seed = 0x5ca77e4): MurmurationModel {
  const params: MurmurationParams = {
    x: 0,
    y: 0,
    radiusX: FLOCK_RADIUS,
    radiusY: FLOCK_RADIUS,
    angle: 0,
    speed: SPEED_MIN,
    scatter: 0,
    scatterX: 0,
    scatterY: 0,
    time: 0,
    present: 1
  }
  const random = createRandom(seed)
  let previousSpectrum: Float32Array | null = null
  let lastOnset = 0
  let rising = false
  let bass = 0
  // Offsets from the centre: the point rides with the flock while it scatters.
  let offsetX = 0
  let offsetY = 0

  return {
    params,

    update(audio, intensity, aspect, dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      const spectrum = audio.spectrum
      if (!previousSpectrum || previousSpectrum.length !== spectrum.length) {
        previousSpectrum = new Float32Array(spectrum)
      }

      bass += (clamp01(audio.bass) - bass) * follow(dt, SPEED_TAU_SEC)
      params.speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * bass
      params.time += dt * (CLOCK_MIN + (CLOCK_MAX - CLOCK_MIN) * bass)
      flockShape(params.time, aspect, params)

      const onset = clamp01(audio.onset)
      const rise = onset - lastOnset
      if (rise > RISE_EPSILON) {
        if (!rising) {
          const band = dominantBand(spectrum, previousSpectrum)
          const angle = scatterAngle(band, spectrum.length, random() < 0.5 ? -1 : 1)
          const radius = SCATTER_OFFSET * 0.5 * (params.radiusX + params.radiusY)
          offsetX = Math.cos(angle) * radius
          offsetY = Math.sin(angle) * radius
          rising = true
        }
      } else {
        rising = false
      }
      lastOnset = onset
      previousSpectrum.set(spectrum)

      // Up with the envelope (already rate-limited by the guard), down slowly.
      params.scatter -= params.scatter * follow(dt, SCATTER_TAU_SEC)
      if (onset > params.scatter) params.scatter = onset
      params.scatterX = params.x + offsetX
      params.scatterY = params.y + offsetY
      params.present = clamp01(intensity)
      return params
    }
  }
}
