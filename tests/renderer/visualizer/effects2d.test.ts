import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import type { CoverSlot } from '../../../src/renderer/visualizer/cover'
import type {
  Draw2D,
  Effect2DInstance,
  Quality2D
} from '../../../src/renderer/visualizer/effects/draw2d'
import { createHalo } from '../../../src/renderer/visualizer/effects/halo'
import {
  MAX_TILES,
  createMosaic,
  layoutMosaicTiles,
  mosaicBand,
  mosaicGrid,
  tileTransform
} from '../../../src/renderer/visualizer/effects/mosaic'
import { createTrace, triggerIndex } from '../../../src/renderer/visualizer/effects/trace'
import { PALETTE_SLOT_COUNT, type Palette } from '../../../src/renderer/visualizer/palette'

/**
 * W23-7: Halo, Trace and Mosaic against a recording stub context. The tests
 * compile without the DOM lib, so the cores are generic over a structural
 * context (`draw2d.ts`); this stub implements it and records what the effect
 * asked for.
 */

interface FakeImage {
  readonly name: string
  readonly width: number
  readonly height: number
  close(): void
}

function image(name: string, width: number, height: number): FakeImage {
  return { name, width, height, close() {} }
}

type Op =
  | { kind: 'drawImage'; image: FakeImage; args: number[]; alpha: number; op: string; m: number[] }
  | { kind: 'fillRect' | 'stroke' | 'fill'; alpha: number; op: string; style: unknown; m: number[] }
  | { kind: 'clearRect'; args: number[] }

class RecordingContext implements Draw2D<FakeImage> {
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  fillStyle: unknown = '#000'
  strokeStyle: unknown = '#000'
  lineWidth = 1
  lineCap = 'butt'
  lineJoin = 'miter'
  imageSmoothingEnabled = true

  ops: Op[] = []
  depth = 0
  maxDepth = 0
  matrix = [1, 0, 0, 1, 0, 0]
  nonFinite: string[] = []
  private stack: { alpha: number; op: string; m: number[] }[] = []

  private check(name: string, values: readonly number[]): void {
    for (const value of values) if (!Number.isFinite(value)) this.nonFinite.push(name)
    for (const [key, value] of [
      ['globalAlpha', this.globalAlpha],
      ['lineWidth', this.lineWidth]
    ] as const) {
      if (!Number.isFinite(value)) this.nonFinite.push(`${name}:${key}`)
    }
  }

  save(): void {
    this.stack.push({ alpha: this.globalAlpha, op: this.globalCompositeOperation, m: this.matrix })
    this.depth++
    this.maxDepth = Math.max(this.maxDepth, this.depth)
  }
  restore(): void {
    const top = this.stack.pop()
    if (!top) throw new Error('restore without save')
    this.globalAlpha = top.alpha
    this.globalCompositeOperation = top.op
    this.matrix = top.m
    this.depth--
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.check('setTransform', [a, b, c, d, e, f])
    this.matrix = [a, b, c, d, e, f]
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.check('clearRect', [x, y, w, h])
    this.ops.push({ kind: 'clearRect', args: [x, y, w, h] })
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.check('fillRect', [x, y, w, h])
    this.paint('fillRect', this.fillStyle)
  }
  beginPath(): void {}
  closePath(): void {}
  moveTo(x: number, y: number): void {
    this.check('moveTo', [x, y])
  }
  lineTo(x: number, y: number): void {
    this.check('lineTo', [x, y])
  }
  arc(x: number, y: number, r: number, start: number, end: number): void {
    this.check('arc', [x, y, r, start, end])
    if (r < 0) this.nonFinite.push('arc:negative radius')
  }
  stroke(): void {
    this.paint('stroke', this.strokeStyle)
  }
  fill(): void {
    this.paint('fill', this.fillStyle)
  }
  clip(): void {}
  drawImage(image: FakeImage, ...args: number[]): void {
    this.check('drawImage', args)
    this.ops.push({
      kind: 'drawImage',
      image,
      args,
      alpha: this.globalAlpha,
      op: this.globalCompositeOperation,
      m: this.matrix
    })
  }
  private paint(kind: 'fillRect' | 'stroke' | 'fill', style: unknown): void {
    this.check(kind, [])
    this.ops.push({
      kind,
      alpha: this.globalAlpha,
      op: this.globalCompositeOperation,
      style,
      m: this.matrix
    })
  }
}

function makePalette(): Palette {
  return {
    css: Array.from({ length: PALETTE_SLOT_COUNT }, (_, slot) => `rgb(${slot}, ${slot}, ${slot})`),
    linear: new Float32Array(PALETTE_SLOT_COUNT * 3),
    oklab: new Float32Array(PALETTE_SLOT_COUNT * 3),
    version: 1
  }
}

interface MutableFrame {
  waveform: Float32Array<ArrayBuffer>
  spectrum: Float32Array
  bass: number
  mid: number
  treble: number
  level: number
  onset: number
  silent: boolean
  timeSec: number
}

function makeFrame(): MutableFrame {
  return {
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(ANALYSIS_BANDS),
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    onset: 0,
    silent: true,
    timeSec: 0
  }
}

/** A lively frame: a beating sine, a sloping spectrum and an onset every 1/8 s. */
function animate(frame: MutableFrame, timeSec: number, dtSec: number): void {
  frame.timeSec = timeSec
  const beat = 0.5 + 0.5 * Math.sin(timeSec * Math.PI * 4)
  for (let index = 0; index < frame.waveform.length; index++) {
    frame.waveform[index] = 0.6 * beat * Math.sin((index / 1024) * Math.PI * 2 * 9 + timeSec * 7)
  }
  for (let band = 0; band < ANALYSIS_BANDS; band++) {
    frame.spectrum[band] = Math.max(
      0,
      beat * (1 - band / ANALYSIS_BANDS) + 0.1 * Math.sin(band + timeSec * 5)
    )
  }
  frame.bass = beat
  frame.mid = beat * 0.6
  frame.treble = beat * 0.3
  frame.level = beat * 0.8
  const phase = timeSec % 0.125
  frame.onset = phase < dtSec ? 1 : 0
  frame.silent = false
}

type Slot = CoverSlot<FakeImage, unknown>

function slot(name: string, width: number, height: number): Slot {
  return {
    bitmap: image(name, width, height),
    texture: null,
    aspect: width / height,
    swatches: new Float32Array(48),
    synthetic: false
  }
}

interface MutableStage {
  emergence: number
  intensity: number
  wash: { source: FakeImage; scale: number } | null
  cover: { current: Slot; previous: Slot | null; mix: number } | null
}

const WASH = image('wash', 1280, 720)

function makeStage(): MutableStage {
  return {
    emergence: 1,
    intensity: 1,
    wash: { source: WASH, scale: 1.25 },
    cover: { current: slot('a', 640, 640), previous: null, mix: 1 }
  }
}

type Core = (
  ctx: Draw2D<FakeImage>,
  quality: Quality2D
) => Effect2DInstance<FakeImage, AnalysisFrame, Palette>

const CORES: readonly (readonly [string, Core])[] = [
  ['Halo', createHalo],
  ['Trace', createTrace],
  ['Mosaic', createMosaic]
]
const QUALITIES: readonly Quality2D[] = ['low', 'auto', 'high']
/** 144 Hz, 60 Hz, a capped low-quality rate, and the 0.1 s clamp. */
const DTS = [1 / 144, 1 / 60, 1 / 30, 0.1]

function run(
  core: Core,
  quality: Quality2D,
  frames: number,
  stage: MutableStage,
  ctx = new RecordingContext()
): RecordingContext {
  const effect = core(ctx, quality)
  const palette = makePalette()
  const frame = makeFrame()
  effect.resize(1280, 720)
  let time = 0
  for (let n = 0; n < frames; n++) {
    const dt = DTS[n % DTS.length]
    time += dt
    animate(frame, time, dt)
    // A track change every 100 frames, crossfading over the next 30.
    if (stage.cover) {
      const cycle = n % 100
      if (cycle === 0 && n > 0) {
        stage.cover.previous = stage.cover.current
        stage.cover.current = slot(`c${n}`, n % 200 === 0 ? 600 : 640, 640)
      }
      stage.cover.mix = stage.cover.previous ? Math.min(1, cycle / 30) : 1
      if (stage.cover.mix >= 1) stage.cover.previous = null
    }
    if (n === Math.floor(frames / 2)) effect.resize(800, 1200)
    effect.frame(frame, palette, stage, dt)
  }
  effect.dispose()
  return ctx
}

describe('the 2D effects (W23-7)', () => {
  for (const [name, core] of CORES) {
    for (const quality of QUALITIES) {
      it(`${name} (${quality}) runs a few hundred frames and disposes cleanly`, () => {
        const ctx = run(core, quality, 400, makeStage())
        expect(ctx.nonFinite).toEqual([])
        expect(ctx.depth).toBe(0)
        expect(ctx.globalAlpha).toBe(1)
        expect(ctx.globalCompositeOperation).toBe('source-over')
        expect(ctx.ops.some((op) => op.kind !== 'clearRect')).toBe(true)
      })
    }

    it(`${name} draws every colour from the palette`, () => {
      const palette = new Set(makePalette().css)
      const ctx = run(core, 'auto', 200, makeStage())
      for (const op of ctx.ops) {
        if (op.kind === 'fillRect' || op.kind === 'stroke' || op.kind === 'fill') {
          expect(palette.has(op.style as string)).toBe(true)
        }
      }
    })

    it(`${name} survives a zero-sized canvas and a missing cover and wash`, () => {
      const ctx = new RecordingContext()
      const effect = core(ctx, 'auto')
      const frame = makeFrame()
      const stage: MutableStage = { emergence: 1, intensity: 1, wash: null, cover: null }
      effect.resize(0, 0)
      for (let n = 0; n < 50; n++) {
        animate(frame, n / 60, 1 / 60)
        effect.frame(frame, makePalette(), stage, 1 / 60)
      }
      effect.resize(640, 360)
      for (let n = 0; n < 50; n++) effect.frame(frame, makePalette(), stage, 0)
      effect.dispose()
      expect(ctx.nonFinite).toEqual([])
      expect(ctx.depth).toBe(0)
    })
  }

  for (const [name, core] of CORES.filter(([name]) => name !== 'Mosaic')) {
    it(`${name} multiplies the flash guard's intensity into everything it draws`, () => {
      const stage = makeStage()
      stage.intensity = 0
      const ctx = run(core, 'high', 200, stage)
      const painted = ctx.ops.filter((op) => op.kind !== 'clearRect')
      expect(painted.length).toBeGreaterThan(0)
      for (const op of painted) expect(op.alpha).toBe(0)
    })
  }

  it('Halo crossfades its disc as an exact lerp of the two covers', () => {
    const ctx = new RecordingContext()
    const halo = createHalo(ctx, 'auto')
    halo.resize(1000, 1000)
    const stage = makeStage()
    stage.cover = { current: slot('b', 640, 640), previous: slot('a', 640, 640), mix: 0.25 }
    halo.frame(makeFrame(), makePalette(), stage, 1 / 60)
    const draws = ctx.ops.filter((op) => op.kind === 'drawImage')
    expect(draws.map((op) => op.image.name)).toEqual(['a', 'b'])
    expect(draws[0].alpha + draws[1].alpha).toBeCloseTo(0.92)
    expect(draws[1].op).toBe('lighter')
  })
})

describe('triggerIndex', () => {
  it('finds the first rising zero crossing and falls back to 0', () => {
    expect(triggerIndex([0.5, 0.2, -0.1, -0.3, 0.2, 0.4], 2)).toBe(4)
    expect(triggerIndex([0.5, 0.4, 0.3, 0.2], 2)).toBe(0)
    // Only within the first part, so a full span is left to draw.
    expect(triggerIndex([0.1, 0.2, 0.3, -0.1, 0.1], 3)).toBe(0)
  })
})

describe('Mosaic', () => {
  it('lays out a gapless, non-overlapping grid at any size', () => {
    for (const [width, height] of [
      [97, 61],
      [1280, 720],
      [801, 1203],
      [3, 2],
      [1, 1]
    ]) {
      for (const quality of QUALITIES) {
        const grid = mosaicGrid(width, height, quality)
        expect(grid.cols * grid.rows).toBeLessThanOrEqual(MAX_TILES)
        const rects = new Int32Array(MAX_TILES * 4)
        const count = layoutMosaicTiles(width, height, grid.cols, grid.rows, rects)
        expect(count).toBe(grid.cols * grid.rows)
        const covered = new Uint8Array(width * height)
        for (let tile = 0; tile < count; tile++) {
          const [x, y, w, h] = rects.subarray(tile * 4, tile * 4 + 4)
          for (let row = y; row < y + h; row++) {
            for (let col = x; col < x + w; col++) covered[row * width + col]++
          }
        }
        expect(covered.every((n) => n === 1)).toBe(true)
      }
    }
  })

  it('never exceeds the tile budget on an extreme aspect', () => {
    const grid = mosaicGrid(10000, 100, 'high')
    expect(grid.cols * grid.rows).toBeLessThanOrEqual(MAX_TILES)
    expect(grid.rows).toBeGreaterThanOrEqual(1)
  })

  it('reads bands left to right across the columns, within range', () => {
    const cols = 20
    for (let row = 0; row < 12; row++) {
      let last = -1
      for (let col = 0; col < cols; col++) {
        const band = mosaicBand(col, row, cols)
        expect(band).toBeGreaterThanOrEqual(0)
        expect(band).toBeLessThan(ANALYSIS_BANDS)
        expect(band).toBeGreaterThanOrEqual(last)
        last = band
      }
    }
  })

  it('places an unlifted tile by an exact translation', () => {
    const out = new Float64Array(6)
    tileTransform(out, 37, 81, 53, 47, 0, 0.1, 0.6, 0.8, 12)
    expect(Array.from(out)).toEqual([1, 0, 0, 1, 37, 81])
  })

  it('keeps a lifted tile centred on its own centre, raised', () => {
    const out = new Float64Array(6)
    tileTransform(out, 100, 200, 40, 30, 1, 0.14, 1, 0, 10)
    const [a, b, c, d, e, f] = out
    // The tile's centre (20, 15) in its own space.
    expect(a * 20 + c * 15 + e).toBeCloseTo(120)
    expect(b * 20 + d * 15 + f).toBeCloseTo(215 - 10)
  })

  it('is exactly the wash at emergence 0, however loud', () => {
    const ctx = new RecordingContext()
    const mosaic = createMosaic(ctx, 'high')
    mosaic.resize(1280, 720)
    const frame = makeFrame()
    const stage = makeStage()
    stage.emergence = 0
    let time = 0
    for (let n = 0; n < 60; n++) {
      time += 1 / 60
      animate(frame, time, 1 / 60)
      ctx.ops = []
      mosaic.frame(frame, makePalette(), stage, 1 / 60)
    }

    const grid = mosaicGrid(1280, 720, 'high')
    const draws = ctx.ops.filter((op) => op.kind === 'drawImage')
    expect(ctx.ops.filter((op) => op.kind !== 'clearRect' && op.kind !== 'drawImage')).toEqual([])
    expect(draws).toHaveLength(grid.cols * grid.rows)
    const covered = new Uint8Array(1280 * 720)
    for (const op of draws) {
      expect(op.image).toBe(WASH)
      expect(op.alpha).toBe(1)
      expect(op.op).toBe('source-over')
      const [sx, sy, sw, sh, dx, dy, dw, dh] = op.args
      // A 1:1 copy of its own rectangle, translated there by an integer.
      expect([dx, dy, dw, dh]).toEqual([0, 0, sw, sh])
      expect(op.m).toEqual([1, 0, 0, 1, sx, sy])
      expect(Number.isInteger(sx) && Number.isInteger(sy)).toBe(true)
      for (let row = sy; row < sy + sh; row++)
        covered.fill(1, row * 1280 + sx, row * 1280 + sx + sw)
    }
    expect(covered.every((n) => n === 1)).toBe(true)
  })

  it('holds still at full emergence when the flash guard is at zero', () => {
    const stage = makeStage()
    stage.intensity = 0
    const ctx = run(createMosaic, 'auto', 120, stage)
    for (const op of ctx.ops) {
      if (op.kind === 'drawImage') {
        expect(op.image).toBe(WASH)
        expect(op.m.slice(0, 4)).toEqual([1, 0, 0, 1])
      }
      expect(op.kind === 'fillRect').toBe(false)
    }
  })

  it('lays the sharp cover over the wash and lifts tiles once emergent', () => {
    const ctx = new RecordingContext()
    const mosaic = createMosaic(ctx, 'auto')
    mosaic.resize(1280, 720)
    const frame = makeFrame()
    const stage = makeStage()
    for (let n = 0; n < 30; n++) {
      animate(frame, n / 60, 1 / 60)
      ctx.ops = []
      mosaic.frame(frame, makePalette(), stage, 1 / 60)
    }
    const draws = ctx.ops.filter((op) => op.kind === 'drawImage')
    expect(draws.some((op) => op.image.name === 'a')).toBe(true)
    expect(draws.some((op) => op.m[0] !== 1 || op.m[1] !== 0)).toBe(true)
  })

  it('moves the same whatever the frame rate', () => {
    function settleAt(dt: number): number[] {
      const ctx = new RecordingContext()
      const mosaic = createMosaic(ctx, 'low')
      mosaic.resize(1280, 720)
      const frame = makeFrame()
      frame.spectrum.fill(0.7)
      frame.silent = false
      const stage = makeStage()
      stage.cover = null
      const frames = Math.round(0.5 / dt)
      for (let n = 0; n < frames; n++) {
        ctx.ops = []
        mosaic.frame(frame, makePalette(), stage, dt)
      }
      const first = ctx.ops.find((op) => op.kind === 'drawImage')
      if (!first || first.kind !== 'drawImage') throw new Error('nothing drawn')
      return first.m
    }
    const slow = settleAt(1 / 30)
    const fast = settleAt(1 / 240)
    for (let index = 0; index < 6; index++) expect(fast[index]).toBeCloseTo(slow[index], 3)
  })
})
