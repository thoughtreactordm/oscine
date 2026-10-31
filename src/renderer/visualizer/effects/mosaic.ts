import { ANALYSIS_BANDS, type AnalysisFrame } from '../analysisFrame'
import type { CoverBitmap } from '../cover'
import { PaletteSlot, type Palette } from '../palette'
import {
  createCoverFit,
  drawFittedRegion,
  fitCover,
  type Draw2D,
  type Effect2DInstance,
  type Quality2D,
  type Stage2D
} from './draw2d'

/**
 * **Mosaic** — W23-7, D35.9: the cover cut into a grid of tiles, each driven
 * by one spectrum band, that lift, tilt and settle. The first `grow` effect
 * (D35.12), proving that contract on the 2D tier before the GPU tier exists.
 *
 * **At emergence 0 the tiles close up into exactly the wash.** Each tile is a
 * 1:1 copy of its own rectangle of `stage.wash` at an integer translation,
 * with nothing else drawn, and the rectangles tile the canvas without a gap or
 * an overlap ({@link layoutMosaicTiles}) — so the canvas holds the wash's
 * pixels, bit for bit. As emergence rises:
 *
 * - the tile's displacement scales up from zero: it lifts, grows, turns about
 *   its centre and foreshortens along a fixed axis of its own, as if tilting
 *   towards the viewer;
 * - the cover itself, fitted like the wash (object-cover, the wash's scale)
 *   but sharp, is laid over each tile, so the blurred field resolves into the
 *   image as it starts to move — "the cover on the stage visibly starts to
 *   move";
 * - a lifted tile catches a sheen of `--ui-text-highlighted`.
 *
 * Emergence and the flash guard's intensity are separate multipliers and both
 * apply to everything the effect adds to the wash (R17: `grow` effects are not
 * exempt). The wash itself is the rest state and is drawn as is.
 *
 * Each tile's lift is a slightly underdamped spring on its band, so a beat
 * lifts it and it settles with a little overshoot. The spring is integrated in
 * fixed substeps of clamped time, so it is frame-rate independent. Everything
 * is sized for {@link MAX_TILES} in `create`; a frame allocates nothing, and
 * costs one `drawImage` per tile plus one per cover slot once emergent.
 */

export const MAX_TILES = 256

/** Rows on the shorter side, by quality; columns follow the aspect. */
const ROWS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 6, auto: 8, high: 11 }

/** The sharp cover's opacity over the wash at full emergence. */
const COVER_ALPHA = 0.55
/** At full lift: growth, turn (radians), foreshortening, and rise (× shorter side). */
const LIFT_SCALE = 0.16
const LIFT_TURN = 0.14
const LIFT_FORESHORTEN = 0.3
const LIFT_RISE = 0.018
const SHEEN_ALPHA = 0.2
/** Tiles lifted past this draw in a second pass, over their resting neighbours. */
const LIFT_SPLIT = 0.04
/** The spring: natural frequency (rad/s), damping ratio, and integration step. */
const SPRING_OMEGA = 13
const SPRING_DAMPING = 0.45
const SPRING_STEP_SEC = 1 / 240
/** The golden-ratio fraction that staggers each row's band choice. */
const ROW_STAGGER = 0.618033988749895

export interface MosaicGrid {
  readonly cols: number
  readonly rows: number
}

/** The grid for a canvas: roughly square tiles, never more than {@link MAX_TILES}. */
export function mosaicGrid(width: number, height: number, quality: Quality2D): MosaicGrid {
  if (!(width > 0 && height > 0)) return { cols: 1, rows: 1 }
  const across = ROWS_BY_QUALITY[quality]
  let rows: number
  let cols: number
  if (width >= height) {
    rows = across
    cols = Math.max(1, Math.round((across * width) / height))
  } else {
    cols = across
    rows = Math.max(1, Math.round((across * height) / width))
  }
  while (cols * rows > MAX_TILES) {
    if (cols >= rows) cols--
    else rows--
  }
  return { cols, rows }
}

/**
 * Fill `out` with each tile's integer rectangle, four entries per tile
 * (x, y, width, height), row-major. Edges are rounded from one shared grid, so
 * neighbours share their edge exactly: the tiles cover the canvas with no gap
 * and no overlap at any size. Returns the tile count.
 */
export function layoutMosaicTiles(
  width: number,
  height: number,
  cols: number,
  rows: number,
  out: Int32Array
): number {
  let tile = 0
  for (let row = 0; row < rows; row++) {
    const y0 = Math.round((row * height) / rows)
    const y1 = Math.round(((row + 1) * height) / rows)
    for (let col = 0; col < cols; col++) {
      const x0 = Math.round((col * width) / cols)
      const x1 = Math.round(((col + 1) * width) / cols)
      const at = tile * 4
      out[at] = x0
      out[at + 1] = y0
      out[at + 2] = x1 - x0
      out[at + 3] = y1 - y0
      tile++
    }
  }
  return tile
}

/**
 * The band a tile reads: the log spectrum runs left to right across the
 * columns, as in Bars, and each row is staggered by a golden-ratio fraction of
 * a column so a column's tiles read neighbouring bands rather than one.
 */
export function mosaicBand(col: number, row: number, cols: number): number {
  const stagger = (row * ROW_STAGGER) % 1
  const band = Math.floor(((col + stagger) / cols) * ANALYSIS_BANDS)
  return band < 0 ? 0 : band >= ANALYSIS_BANDS ? ANALYSIS_BANDS - 1 : band
}

/**
 * The affine transform `(a, b, c, d, e, f)` that draws a tile's `w`×`h`
 * rectangle — at `(0, 0, w, h)` in its own space — lifted by `lift` (0..1,
 * already scaled by emergence and intensity). The tile grows by
 * {@link LIFT_SCALE}, turns by `turn` radians, foreshortens along the unit
 * axis `(axisX, axisY)` and rises by `risePx`, all about its centre. At
 * `lift = 0` it is exactly the translation to `(x, y)`: no rounding enters.
 */
export function tileTransform(
  out: Float64Array,
  x: number,
  y: number,
  w: number,
  h: number,
  lift: number,
  turn: number,
  axisX: number,
  axisY: number,
  risePx: number
): void {
  if (lift === 0) {
    out[0] = 1
    out[1] = 0
    out[2] = 0
    out[3] = 1
    out[4] = x
    out[5] = y
    return
  }
  // Foreshortening: I − (1 − q)·aaᵀ, q = 1 − lift·F.
  const squeeze = lift * LIFT_FORESHORTEN
  const s00 = 1 - squeeze * axisX * axisX
  const s01 = -squeeze * axisX * axisY
  const s11 = 1 - squeeze * axisY * axisY
  // Then turn, then grow.
  const angle = turn * lift
  const grow = 1 + lift * LIFT_SCALE
  const cos = Math.cos(angle) * grow
  const sin = Math.sin(angle) * grow
  const a = cos * s00 - sin * s01
  const b = sin * s00 + cos * s01
  const c = cos * s01 - sin * s11
  const d = sin * s01 + cos * s11
  // About the centre: the centre maps to itself, lifted.
  const hw = w / 2
  const hh = h / 2
  out[0] = a
  out[1] = b
  out[2] = c
  out[3] = d
  out[4] = x + hw - (a * hw + c * hh)
  out[5] = y + hh - (b * hw + d * hh) - risePx * lift
}

/** A small integer hash → 0..1, for each tile's fixed turn and axis. */
function hash01(n: number): number {
  let h = (n * 0x9e3779b1) | 0
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

export function createMosaic<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const rects = new Int32Array(MAX_TILES * 4)
  const bands = new Uint8Array(MAX_TILES)
  const lift = new Float32Array(MAX_TILES)
  const speed = new Float32Array(MAX_TILES)
  const turns = new Float32Array(MAX_TILES)
  const axes = new Float32Array(MAX_TILES * 2)
  for (let tile = 0; tile < MAX_TILES; tile++) {
    turns[tile] = (hash01(tile * 2 + 1) * 2 - 1) * LIFT_TURN
    const angle = hash01(tile * 2 + 2) * Math.PI
    axes[tile * 2] = Math.cos(angle)
    axes[tile * 2 + 1] = Math.sin(angle)
  }
  const matrix = new Float64Array(6)
  const fitCurrent = createCoverFit()
  const fitPrevious = createCoverFit()

  let width = 0
  let height = 0
  let tiles = 0
  let carry = 0

  function advanceSprings(spectrum: Float32Array, dtSec: number): void {
    carry += dtSec > 0 ? dtSec : 0
    const k = SPRING_OMEGA * SPRING_OMEGA
    const c = 2 * SPRING_DAMPING * SPRING_OMEGA
    while (carry >= SPRING_STEP_SEC) {
      carry -= SPRING_STEP_SEC
      for (let tile = 0; tile < tiles; tile++) {
        // Semi-implicit Euler: velocity first, then position from it.
        speed[tile] +=
          (k * (spectrum[bands[tile]] - lift[tile]) - c * speed[tile]) * SPRING_STEP_SEC
        lift[tile] += speed[tile] * SPRING_STEP_SEC
      }
    }
  }

  function drawTile(
    tile: number,
    wash: I | null,
    current: (I & CoverBitmap) | null,
    previous: (I & CoverBitmap) | null,
    mix: number,
    coverAlpha: number,
    motion: number,
    risePx: number,
    sheen: string
  ): void {
    const at = tile * 4
    const x = rects[at]
    const y = rects[at + 1]
    const w = rects[at + 2]
    const h = rects[at + 3]
    if (w <= 0 || h <= 0) return
    let amount = lift[tile] * motion
    amount = amount < 0 ? 0 : amount > 1 ? 1 : amount
    tileTransform(
      matrix,
      x,
      y,
      w,
      h,
      amount,
      turns[tile],
      axes[tile * 2],
      axes[tile * 2 + 1],
      risePx
    )
    ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5])

    ctx.globalCompositeOperation = 'source-over'
    if (wash) {
      ctx.globalAlpha = 1
      ctx.drawImage(wash, x, y, w, h, 0, 0, w, h)
    }
    if (coverAlpha > 0) {
      if (previous && mix < 1) {
        ctx.globalAlpha = coverAlpha * (1 - mix)
        drawFittedRegion(ctx, previous, fitPrevious, x, y, w, h, 0, 0)
      }
      if (current) {
        ctx.globalAlpha = coverAlpha * mix
        drawFittedRegion(ctx, current, fitCurrent, x, y, w, h, 0, 0)
      }
    }
    if (amount > LIFT_SPLIT) {
      // Over what this tile drew, keeping its coverage.
      ctx.globalCompositeOperation = 'source-atop'
      ctx.globalAlpha = amount * SHEEN_ALPHA
      ctx.fillStyle = sheen
      ctx.fillRect(0, 0, w, h)
    }
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
      const grid = mosaicGrid(width, height, quality)
      tiles = layoutMosaicTiles(width, height, grid.cols, grid.rows, rects)
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
          bands[row * grid.cols + col] = mosaicBand(col, row, grid.cols)
        }
      }
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, width, height)
      advanceSprings(audio.spectrum, dtSec)
      if (width <= 0 || height <= 0 || tiles === 0) return

      const emergence = stage.emergence < 0 ? 0 : stage.emergence > 1 ? 1 : stage.emergence
      const intensity = stage.intensity < 0 ? 0 : stage.intensity > 1 ? 1 : stage.intensity
      // Everything the effect adds to the wash goes by both (R17).
      const motion = emergence * intensity
      const wash = stage.wash ? stage.wash.source : null
      const cover = stage.cover
      let current: (I & CoverBitmap) | null = null
      let previous: (I & CoverBitmap) | null = null
      let mix = 1
      let coverAlpha = 0
      if (cover && motion > 0) {
        current = cover.current.bitmap
        previous = cover.previous ? cover.previous.bitmap : null
        mix = previous ? (cover.mix < 0 ? 0 : cover.mix > 1 ? 1 : cover.mix) : 1
        const scale = stage.wash ? stage.wash.scale : 1
        if (fitCover(fitCurrent, current.width, current.height, 0, 0, width, height, scale)) {
          coverAlpha = COVER_ALPHA * motion
        } else {
          current = null
        }
        if (
          previous &&
          !fitCover(fitPrevious, previous.width, previous.height, 0, 0, width, height, scale)
        ) {
          previous = null
        }
      }

      const short = width < height ? width : height
      const risePx = short * LIFT_RISE
      const sheen = palette.css[PaletteSlot.textHighlighted]
      // Resting tiles, then lifted ones over them.
      for (let tile = 0; tile < tiles; tile++) {
        if (lift[tile] * motion <= LIFT_SPLIT) {
          drawTile(tile, wash, current, previous, mix, coverAlpha, motion, risePx, sheen)
        }
      }
      for (let tile = 0; tile < tiles; tile++) {
        if (lift[tile] * motion > LIFT_SPLIT) {
          drawTile(tile, wash, current, previous, mix, coverAlpha, motion, risePx, sheen)
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, width, height)
    }
  }
}
