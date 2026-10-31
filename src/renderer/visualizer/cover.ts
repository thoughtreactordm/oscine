import { gammaDecode, gammaEncode, oklabToLinearRgbInto } from '@shared/theme'
import { MAX_FRAME_DT_SEC } from './analysisFrame'
import { PALETTE_LERP_SEC, PaletteSlot } from './palette'

/**
 * The cover as a visualizer input — **W23-3, D35.11**, the tier-independent half.
 *
 * Three pure pieces live here: the swatch downsample, the synthetic stand-in
 * used when there is no cover, and the two-slot crossfade between covers. The
 * fetch/decode glue is in `coverDecode.ts` and the per-track bookkeeping that
 * drives these pieces in `coverSource.ts`; W23-8 adds the WebGL upload on top
 * and is the only thing that ever fills {@link CoverSlot.texture}.
 *
 * Like `palette.ts` this is `@renderer`-free and DOM-free. It never names
 * `ImageBitmap` — `tests/` compiles without the DOM lib — so a slot is generic
 * over {@link CoverBitmap}, which an `ImageBitmap` satisfies; `coverDecode.ts`
 * pins the stage's concrete types.
 */

/** What the cover model needs of a bitmap. An `ImageBitmap` is one. */
export interface CoverBitmap {
  readonly width: number
  readonly height: number
  close(): void
}

export interface CoverSlot<Bitmap extends CoverBitmap = CoverBitmap, Texture = unknown> {
  /** 2D effects draw this. */
  readonly bitmap: Bitmap
  /** WebGL effects sample this; null on the 2D tier (and always, until W23-8). */
  texture: Texture | null
  /** width / height. */
  readonly aspect: number
  /** {@link SWATCH_COUNT} linear-RGB triplets, row-major from the top-left cell. */
  readonly swatches: Float32Array
  /** True when generated from the palette because there is no usable cover. */
  readonly synthetic: boolean
}

export interface CoverInput<Slot extends CoverSlot = CoverSlot> {
  readonly current: Slot
  /** Present only while crossfading between covers. */
  readonly previous: Slot | null
  /** 0 = previous, 1 = current. */
  readonly mix: number
}

/* -------------------------------------------------------------------------- */
/* Swatches                                                                    */
/* -------------------------------------------------------------------------- */

/** The swatch grid is this many cells on a side. */
export const SWATCH_GRID = 4
export const SWATCH_COUNT = SWATCH_GRID * SWATCH_GRID

/** sRGB byte → linear light, so a 640² average costs no `pow`. */
const DECODE_LUT = (() => {
  const lut = new Float32Array(256)
  for (let i = 0; i < 256; i++) lut[i] = gammaDecode(i / 255)
  return lut
})()

/**
 * Box-average RGBA pixels into a 4×4 grid of linear-RGB swatches, written into
 * `out` (length `SWATCH_COUNT * 3`) and returned.
 *
 * Averaged in linear light, so a cell split between red and blue comes out the
 * colour the two would actually blend to, and weighted by alpha, so a
 * transparent PNG's empty margin does not drag its swatches towards black. A
 * cell with no opaque pixel at all is black. An image narrower than the grid
 * gives each cell at least its nearest pixel.
 */
export function computeSwatchesInto(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  out: Float32Array
): Float32Array {
  for (let cy = 0; cy < SWATCH_GRID; cy++) {
    const y0 = Math.min(height - 1, Math.floor((cy * height) / SWATCH_GRID))
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / SWATCH_GRID))
    for (let cx = 0; cx < SWATCH_GRID; cx++) {
      const x0 = Math.min(width - 1, Math.floor((cx * width) / SWATCH_GRID))
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / SWATCH_GRID))
      let r = 0
      let g = 0
      let b = 0
      let weight = 0
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4
        for (let x = x0; x < x1; x++, i += 4) {
          const a = (pixels[i + 3] ?? 0) / 255
          r += (DECODE_LUT[pixels[i] ?? 0] ?? 0) * a
          g += (DECODE_LUT[pixels[i + 1] ?? 0] ?? 0) * a
          b += (DECODE_LUT[pixels[i + 2] ?? 0] ?? 0) * a
          weight += a
        }
      }
      const o = (cy * SWATCH_GRID + cx) * 3
      const scale = weight > 0 ? 1 / weight : 0
      out[o] = r * scale
      out[o + 1] = g * scale
      out[o + 2] = b * scale
    }
  }
  return out
}

export function computeSwatches(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): Float32Array {
  return computeSwatchesInto(pixels, width, height, new Float32Array(SWATCH_COUNT * 3))
}

/* -------------------------------------------------------------------------- */
/* Synthetic stand-in                                                          */
/* -------------------------------------------------------------------------- */

/** The stand-in's edge. Small: every cover effect blurs or bends it anyway. */
export const SYNTHETIC_COVER_EDGE = 256

/** The ramp span the field is drawn over: primary-200 at the glow to primary-900. */
const FIELD_LIGHT_SLOT = PaletteSlot.primary200
const FIELD_DARK_SLOT = PaletteSlot.primary900

/**
 * The stand-in's soft field at `(u, v)` in 0..1, as a position along the
 * primary ramp: 0 is the light end, 1 the dark.
 *
 * A glow off-centre towards the top-left falling away to the far corner, with
 * one slow diagonal ripple so a mirrored, tiled or tunnelled stand-in still
 * shows the effect's geometry instead of a flat wash. Low-frequency throughout:
 * there is nothing for a blur to destroy and nothing for a smear to alias.
 */
export function syntheticCoverField(u: number, v: number): number {
  const dx = u - 0.32
  const dy = v - 0.28
  const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 0.95)
  const falloff = r * r * (3 - 2 * r)
  const ripple = 0.08 * Math.sin(2 * Math.PI * (u + 0.6 * v) + 0.8)
  const t = 0.08 + 0.84 * falloff + ripple
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** The field quantised to a byte per pixel, per edge; it never changes, only its colours do. */
const fieldCache = new Map<number, Uint8Array>()

function quantisedField(edge: number): Uint8Array {
  let field = fieldCache.get(edge)
  if (!field) {
    field = new Uint8Array(edge * edge)
    for (let y = 0; y < edge; y++) {
      for (let x = 0; x < edge; x++) {
        field[y * edge + x] = Math.round(
          syntheticCoverField((x + 0.5) / edge, (y + 0.5) / edge) * 255
        )
      }
    }
    fieldCache.set(edge, field)
  }
  return field
}

const rampLut = new Uint8ClampedArray(256 * 3)
const rampScratch = new Float64Array(3)

/**
 * Paint the stand-in into `out` (RGBA, `edge²·4` bytes, opaque) from the
 * palette's OKLab slots, and return it.
 *
 * The ramp is interpolated in OKLab between adjacent steps, like the palette
 * itself moves, then built into a 256-entry table so the per-pixel work is a
 * lookup. Cheap enough to regenerate while a palette lerps.
 */
export function fillSyntheticCover(
  oklab: Float32Array,
  out: Uint8ClampedArray,
  edge: number = SYNTHETIC_COVER_EDGE
): Uint8ClampedArray {
  const span = FIELD_DARK_SLOT - FIELD_LIGHT_SLOT
  for (let k = 0; k < 256; k++) {
    const position = FIELD_LIGHT_SLOT + (span * k) / 255
    const lo = Math.min(FIELD_DARK_SLOT - 1, Math.floor(position))
    const f = position - lo
    const a = lo * 3
    const b = a + 3
    oklabToLinearRgbInto(
      (oklab[a] ?? 0) + ((oklab[b] ?? 0) - (oklab[a] ?? 0)) * f,
      (oklab[a + 1] ?? 0) + ((oklab[b + 1] ?? 0) - (oklab[a + 1] ?? 0)) * f,
      (oklab[a + 2] ?? 0) + ((oklab[b + 2] ?? 0) - (oklab[a + 2] ?? 0)) * f,
      rampScratch,
      0
    )
    for (let c = 0; c < 3; c++) {
      rampLut[k * 3 + c] = Math.round(gammaEncode(rampScratch[c] ?? 0) * 255)
    }
  }

  const field = quantisedField(edge)
  for (let p = 0, o = 0; p < field.length; p++, o += 4) {
    const k = (field[p] ?? 0) * 3
    out[o] = rampLut[k] ?? 0
    out[o + 1] = rampLut[k + 1] ?? 0
    out[o + 2] = rampLut[k + 2] ?? 0
    out[o + 3] = 255
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Two-slot crossfade                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The palette follower's natural frequency (`palette.ts`), so `mix` traces the
 * same critically damped curve the colours do and the two arrive together.
 */
const OMEGA = 6.64 / PALETTE_LERP_SEC

/** How far a from-rest palette step has travelled after `elapsed` seconds. */
function lerpProgress(elapsed: number): number {
  const x = OMEGA * elapsed
  return 1 - (1 + x) * Math.exp(-x)
}

export interface CoverCrossfade<Slot extends CoverSlot = CoverSlot> {
  /** What effects read; the same object every frame, updated in place. Null before the first slot. */
  readonly input: CoverInput<Slot> | null
  /** True while a previous slot is still showing. */
  readonly fading: boolean
  /**
   * A newly decoded cover. The first lands at once; later ones crossfade from
   * the current. Arriving mid-fade, it takes the incoming slot's place: the
   * slot that was fading in is released and the fade carries on from where it
   * was, so at most two slots are ever held.
   */
  present(slot: Slot): void
  /** Swap the current slot without a fade (a regenerated stand-in). */
  replaceCurrent(slot: Slot): void
  /** Advance one rendered frame. */
  update(dtSec: number): CoverInput<Slot> | null
  /** Release everything. */
  clear(): void
}

interface MutableInput<Slot> {
  current: Slot
  previous: Slot | null
  mix: number
}

/**
 * `release` is called exactly once for every slot the crossfade lets go of —
 * dropped mid-fade, faded out, replaced, or cleared. By default it closes the
 * bitmap; W23-8 widens it to delete the texture too.
 */
export function createCoverCrossfade<Slot extends CoverSlot = CoverSlot>(
  release: (slot: Slot) => void = (slot) => slot.bitmap.close()
): CoverCrossfade<Slot> {
  let input: MutableInput<Slot> | null = null
  let elapsed = 0

  return {
    get input() {
      return input
    },
    get fading() {
      return input?.previous != null
    },
    present(slot) {
      if (!input) {
        input = { current: slot, previous: null, mix: 1 }
        return
      }
      if (slot === input.current) return
      if (input.previous) {
        if (slot === input.previous) {
          // Back to the cover that was fading out: cut to it rather than hold it twice.
          release(input.current)
          input.current = slot
          input.previous = null
          input.mix = 1
          return
        }
        release(input.current)
        input.current = slot
        return
      }
      input.previous = input.current
      input.current = slot
      input.mix = 0
      elapsed = 0
    },
    replaceCurrent(slot) {
      if (!input) {
        input = { current: slot, previous: null, mix: 1 }
        return
      }
      if (slot === input.current) return
      release(input.current)
      input.current = slot
    },
    update(dtSec) {
      if (!input?.previous) return input
      const dt = dtSec > 0 ? Math.min(dtSec, MAX_FRAME_DT_SEC) : 0
      elapsed += dt
      if (elapsed >= PALETTE_LERP_SEC) {
        release(input.previous)
        input.previous = null
        input.mix = 1
      } else {
        input.mix = lerpProgress(elapsed)
      }
      return input
    },
    clear() {
      if (!input) return
      if (input.previous) release(input.previous)
      release(input.current)
      input = null
    }
  }
}
