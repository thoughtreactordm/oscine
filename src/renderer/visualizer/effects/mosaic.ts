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
 * **Mosaic** — W23-7, D35.9: the cover as a board of two-sided tiles that flip
 * in waves. The first `grow` effect (D35.12), proving that contract on the 2D
 * tier before the GPU tier exists.
 *
 * Each tile's **front** is its own rectangle of the wash; its **back** is the
 * same rectangle of the cover, sharp, fitted like the wash. An onset launches a
 * **wave** from the column of the frame's dominant band (the log spectrum runs
 * left to right, as in Bars), and every tile the wavefront passes **toggles**
 * its face — so a busy passage keeps the board churning between blur and image
 * rather than pulsing the whole field bright on every beat. A strong onset's
 * wave crosses the board; a weak one turns a patch. A tile left showing its back
 * drifts home on its own after a few seconds, staggered, so a quiet passage
 * settles back into the wash.
 *
 * Mid-flip a tile foreshortens along its wave's direction of travel (as if
 * turning about the axis across it), comes slightly forward, and darkens
 * towards `--ui-bg`, which is what reads as a turn rather than a squash.
 *
 * **At emergence 0 the tiles close up into exactly the wash.** Each tile is a
 * 1:1 copy of its own rectangle of `stage.wash` at an integer translation, and
 * the rectangles tile the canvas without a gap or an overlap
 * ({@link layoutMosaicTiles}) — so the canvas holds the wash's pixels, bit for
 * bit. Every tile's angle is scaled by emergence × the flash guard's intensity
 * (R17: `grow` effects are not exempt), so the flips grow out of a still wash
 * and a damped guard turns the board back towards it.
 *
 * Flips are springs integrated in fixed substeps of clamped time, and wave
 * fronts move in clamped time, so the board is frame-rate independent.
 * Everything is sized for {@link MAX_TILES} and {@link MAX_WAVES} in `create`;
 * a frame allocates nothing.
 */

export const MAX_TILES = 256
export const MAX_WAVES = 6

/** Rows on the shorter side, by quality; columns follow the aspect. */
const ROWS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 6, auto: 8, high: 11 }

/** The cover's opacity on a tile's back, over the wash. */
const BACK_ALPHA = 0.85
/** Edge-on, a tile darkens this much towards `--ui-bg` and grows by this much. */
const EDGE_SHADE = 0.55
const EDGE_GROW = 0.14
/** Tiles further through a flip than this (|sin|) draw in a second pass, over flat ones. */
const TURNING = 0.05

/** Below this onset strength no wave starts. */
const WAVE_MIN_ONSET = 0.18
/** Wavefront speed, in tiles per second. */
const WAVE_SPEED = 16
/** A full-strength wave reaches this far, as a multiple of the board's longer side in tiles. */
const WAVE_REACH = 1.2
/** A weak wave still turns at least this many tiles' radius. */
const WAVE_MIN_REACH = 1.5

/** How long a tile shows its back before it turns home, and how much that is staggered. */
const HOLD_SEC = 2.4
const HOLD_JITTER_SEC = 1.6

/** The flip spring: natural frequency (rad/s), damping ratio, integration step. */
const FLIP_OMEGA = 15
const FLIP_DAMPING = 0.72
const FLIP_STEP_SEC = 1 / 240
/** Closer than this (radians) and slower than this (rad/s), and a flip snaps onto its target. */
const SETTLE_ANGLE = 1e-3
const SETTLE_SPEED = 1e-2
/** Wave origins step down the rows by the golden ratio, so successive waves start apart. */
const GOLDEN = 0.618033988749895
const TAU = Math.PI * 2

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

/** The loudest band, or -1 when every band is silent. */
export function dominantBand(spectrum: ArrayLike<number>): number {
  let best = -1
  let bestValue = 0
  for (let band = 0; band < spectrum.length; band++) {
    if (spectrum[band] > bestValue) {
      bestValue = spectrum[band]
      best = band
    }
  }
  return best
}

/** How far (in tiles) a wave of the given onset strength travels on a `cols`×`rows` board. */
export function waveReach(strength: number, cols: number, rows: number): number {
  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength
  const longer = cols > rows ? cols : rows
  const reach = s * s * longer * WAVE_REACH
  return reach > WAVE_MIN_REACH ? reach : WAVE_MIN_REACH
}

/**
 * The affine transform `(a, b, c, d, e, f)` that draws a tile's `w`×`h`
 * rectangle — at `(0, 0, w, h)` in its own space — turned `angle` radians
 * about the axis across the unit direction `(dirX, dirY)`: foreshortened to
 * |cos| along that direction and grown by {@link EDGE_GROW}·|sin|, about its
 * centre. At `angle = 0` it is exactly the translation to `(x, y)`: no rounding
 * enters.
 */
export function tileTransform(
  out: Float64Array,
  x: number,
  y: number,
  w: number,
  h: number,
  angle: number,
  dirX: number,
  dirY: number
): void {
  if (angle === 0) {
    out[0] = 1
    out[1] = 0
    out[2] = 0
    out[3] = 1
    out[4] = x
    out[5] = y
    return
  }
  const cos = Math.cos(angle)
  const squeeze = 1 - (cos < 0 ? -cos : cos)
  const sin = Math.sin(angle)
  const grow = 1 + EDGE_GROW * (sin < 0 ? -sin : sin)
  // grow · (I − squeeze·ddᵀ)
  const a = grow * (1 - squeeze * dirX * dirX)
  const b = grow * (-squeeze * dirX * dirY)
  const d = grow * (1 - squeeze * dirY * dirY)
  const hw = w / 2
  const hh = h / 2
  out[0] = a
  out[1] = b
  out[2] = b
  out[3] = d
  out[4] = x + hw - (a * hw + b * hh)
  out[5] = y + hh - (b * hw + d * hh)
}

/** A small integer hash → 0..1, for each tile's staggered hold. */
function hash01(n: number): number {
  let h = Math.imul(n + 1, 0x9e3779b1)
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
  /** Tile centres in tile units, for the wavefront test. */
  const centreX = new Float32Array(MAX_TILES)
  const centreY = new Float32Array(MAX_TILES)
  /**
   * The flip: angle and its speed (springs), the angle it is heading for, the
   * face it shows there. Doubles, so π + π wraps to exactly 0 and a settled
   * board is exactly flat again.
   */
  const angle = new Float64Array(MAX_TILES)
  const speed = new Float64Array(MAX_TILES)
  const target = new Float64Array(MAX_TILES)
  const back = new Uint8Array(MAX_TILES)
  /** Seconds left on its back before it turns home. */
  const holdLeft = new Float32Array(MAX_TILES)
  const holdFor = new Float32Array(MAX_TILES)
  /** The direction of travel of the wave that last turned it. */
  const dirX = new Float32Array(MAX_TILES).fill(1)
  const dirY = new Float32Array(MAX_TILES)
  for (let tile = 0; tile < MAX_TILES; tile++) {
    holdFor[tile] = HOLD_SEC + hash01(tile) * HOLD_JITTER_SEC
  }
  /** Active waves: origin (tile units), front radius, reach. Reach 0 = free slot. */
  const waveX = new Float32Array(MAX_WAVES)
  const waveY = new Float32Array(MAX_WAVES)
  const waveRadius = new Float32Array(MAX_WAVES)
  const waveReachOf = new Float32Array(MAX_WAVES)
  const matrix = new Float64Array(6)
  const fitCurrent = createCoverFit()
  const fitPrevious = createCoverFit()

  let width = 0
  let height = 0
  let cols = 1
  let rows = 1
  let tiles = 0
  let carry = 0
  let waveCount = 0
  let originStep = 0

  /** Turn a tile over, onwards in the same direction of spin. */
  function toggle(tile: number, fromX: number, fromY: number): void {
    const dx = centreX[tile] - fromX
    const dy = centreY[tile] - fromY
    const length = Math.sqrt(dx * dx + dy * dy)
    if (length > 1e-6) {
      dirX[tile] = dx / length
      dirY[tile] = dy / length
    }
    target[tile] += Math.PI
    back[tile] ^= 1
    holdLeft[tile] = holdFor[tile]
  }

  function launch(audio: AnalysisFrame): void {
    if (audio.onset < WAVE_MIN_ONSET) return
    const band = dominantBand(audio.spectrum)
    if (band < 0) return
    // The oldest wave gives way when every slot is busy.
    let slot = 0
    for (let n = 0; n < MAX_WAVES; n++) {
      if (waveReachOf[n] === 0) {
        slot = n
        break
      }
      if (waveRadius[n] / waveReachOf[n] > waveRadius[slot] / waveReachOf[slot]) slot = n
    }
    if (waveReachOf[slot] === 0) waveCount++
    originStep = (originStep + GOLDEN) % 1
    waveX[slot] = ((band + 0.5) / ANALYSIS_BANDS) * cols
    waveY[slot] = originStep * rows
    waveRadius[slot] = 0
    waveReachOf[slot] = waveReach(audio.onset, cols, rows)
  }

  function advanceWaves(dtSec: number): void {
    if (waveCount === 0) return
    for (let n = 0; n < MAX_WAVES; n++) {
      const reach = waveReachOf[n]
      if (reach === 0) continue
      const inner = waveRadius[n]
      const outer = Math.min(reach, inner + WAVE_SPEED * dtSec)
      for (let tile = 0; tile < tiles; tile++) {
        const dx = centreX[tile] - waveX[n]
        const dy = centreY[tile] - waveY[n]
        const distance = Math.sqrt(dx * dx + dy * dy)
        // A front at 0 also takes a tile sitting exactly on the origin.
        const passed = distance > inner || (inner === 0 && distance === 0)
        if (passed && distance <= outer) toggle(tile, waveX[n], waveY[n])
      }
      waveRadius[n] = outer
      if (outer >= reach) {
        waveReachOf[n] = 0
        waveCount--
      }
    }
  }

  function advanceTiles(dtSec: number): void {
    for (let tile = 0; tile < tiles; tile++) {
      if (back[tile] === 0) continue
      holdLeft[tile] -= dtSec
      if (holdLeft[tile] <= 0) {
        // Home, the way it was last going.
        target[tile] += Math.PI
        back[tile] = 0
      }
    }
    carry += dtSec
    const k = FLIP_OMEGA * FLIP_OMEGA
    const c = 2 * FLIP_DAMPING * FLIP_OMEGA
    while (carry >= FLIP_STEP_SEC) {
      carry -= FLIP_STEP_SEC
      for (let tile = 0; tile < tiles; tile++) {
        // Semi-implicit Euler: velocity first, then position from it.
        speed[tile] += (k * (target[tile] - angle[tile]) - c * speed[tile]) * FLIP_STEP_SEC
        angle[tile] += speed[tile] * FLIP_STEP_SEC
      }
    }
    for (let tile = 0; tile < tiles; tile++) {
      // Settled springs land exactly, so a face-front tile is drawn exactly flat.
      const off = target[tile] - angle[tile]
      if (
        off < SETTLE_ANGLE &&
        off > -SETTLE_ANGLE &&
        speed[tile] < SETTLE_SPEED &&
        speed[tile] > -SETTLE_SPEED
      ) {
        angle[tile] = target[tile]
        speed[tile] = 0
      }
      // Keep the numbers small; a whole turn changes nothing on screen.
      if (target[tile] >= TAU && angle[tile] >= TAU) {
        target[tile] -= TAU
        angle[tile] -= TAU
      }
    }
  }

  /** The angle a tile is drawn at: its turn from the nearer face-front pose, scaled by `motion`. */
  function drawnAngle(tile: number, motion: number): number {
    if (motion <= 0) return 0
    let a = angle[tile] % TAU
    if (a > Math.PI) a -= TAU
    else if (a < -Math.PI) a += TAU
    return a * motion
  }

  function drawTile(
    tile: number,
    turned: number,
    wash: I | null,
    current: (I & CoverBitmap) | null,
    previous: (I & CoverBitmap) | null,
    mix: number,
    shade: string
  ): void {
    const at = tile * 4
    const x = rects[at]
    const y = rects[at + 1]
    const w = rects[at + 2]
    const h = rects[at + 3]
    if (w <= 0 || h <= 0) return
    tileTransform(matrix, x, y, w, h, turned, dirX[tile], dirY[tile])
    ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5])

    ctx.globalCompositeOperation = 'source-over'
    if (wash) {
      ctx.globalAlpha = 1
      ctx.drawImage(wash, x, y, w, h, 0, 0, w, h)
    }
    if (turned === 0) return
    if (Math.cos(turned) < 0) {
      // The back: the cover itself, over the wash.
      if (previous && mix < 1) {
        ctx.globalAlpha = BACK_ALPHA * (1 - mix)
        drawFittedRegion(ctx, previous, fitPrevious, x, y, w, h, 0, 0)
      }
      if (current) {
        ctx.globalAlpha = BACK_ALPHA * mix
        drawFittedRegion(ctx, current, fitCurrent, x, y, w, h, 0, 0)
      }
    }
    const edge = Math.abs(Math.sin(turned))
    if (edge > TURNING) {
      // Turned away from the light, keeping the tile's own coverage.
      ctx.globalCompositeOperation = 'source-atop'
      ctx.globalAlpha = edge * EDGE_SHADE
      ctx.fillStyle = shade
      ctx.fillRect(0, 0, w, h)
    }
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
      const grid = mosaicGrid(width, height, quality)
      const changed = grid.cols !== cols || grid.rows !== rows
      cols = grid.cols
      rows = grid.rows
      tiles = layoutMosaicTiles(width, height, cols, rows, rects)
      for (let tile = 0; tile < tiles; tile++) {
        centreX[tile] = (tile % cols) + 0.5
        centreY[tile] = Math.floor(tile / cols) + 0.5
      }
      if (changed) {
        // A new board starts face-front: old flips belong to other tiles now.
        angle.fill(0)
        speed.fill(0)
        target.fill(0)
        back.fill(0)
        waveReachOf.fill(0)
        waveCount = 0
      }
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, width, height)
      const dt = dtSec > 0 ? dtSec : 0
      if (tiles > 0) {
        advanceWaves(dt)
        launch(audio)
        advanceTiles(dt)
      }
      if (width <= 0 || height <= 0 || tiles === 0) return

      const emergence = stage.emergence < 0 ? 0 : stage.emergence > 1 ? 1 : stage.emergence
      const intensity = stage.intensity < 0 ? 0 : stage.intensity > 1 ? 1 : stage.intensity
      // Every turn goes by both (R17); at 0 the board is the wash.
      const motion = emergence * intensity
      const wash = stage.wash ? stage.wash.source : null
      const cover = stage.cover
      let current: (I & CoverBitmap) | null = null
      let previous: (I & CoverBitmap) | null = null
      let mix = 1
      if (cover && motion > 0) {
        current = cover.current.bitmap
        previous = cover.previous ? cover.previous.bitmap : null
        mix = previous ? (cover.mix < 0 ? 0 : cover.mix > 1 ? 1 : cover.mix) : 1
        const scale = stage.wash ? stage.wash.scale : 1
        if (!fitCover(fitCurrent, current.width, current.height, 0, 0, width, height, scale)) {
          current = null
        }
        if (
          previous &&
          !fitCover(fitPrevious, previous.width, previous.height, 0, 0, width, height, scale)
        ) {
          previous = null
        }
      }

      const shade = palette.css[PaletteSlot.bg]
      // Flat tiles, then turning ones over them.
      for (let tile = 0; tile < tiles; tile++) {
        const turned = drawnAngle(tile, motion)
        if (Math.abs(Math.sin(turned)) <= TURNING) {
          drawTile(tile, turned, wash, current, previous, mix, shade)
        }
      }
      for (let tile = 0; tile < tiles; tile++) {
        const turned = drawnAngle(tile, motion)
        if (Math.abs(Math.sin(turned)) > TURNING) {
          drawTile(tile, turned, wash, current, previous, mix, shade)
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
