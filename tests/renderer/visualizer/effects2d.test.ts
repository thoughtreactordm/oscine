import { describe, expect, it } from 'vitest'
import { ANALYSIS_BANDS, type AnalysisFrame } from '../../../src/renderer/visualizer/analysisFrame'
import type { CoverSlot } from '../../../src/renderer/visualizer/cover'
import type {
  Draw2D,
  Effect2DInstance,
  Quality2D
} from '../../../src/renderer/visualizer/effects/draw2d'
import { createHalo } from '../../../src/renderer/visualizer/effects/halo'
import { createDrive, spectralCentroid } from '../../../src/renderer/visualizer/effects/drive'
import { createGyre, ringLevel } from '../../../src/renderer/visualizer/effects/gyre'
import { createSilk } from '../../../src/renderer/visualizer/effects/silk'
import { createPhase, mapPhasePoints } from '../../../src/renderer/visualizer/effects/phase'
import { triggerIndex } from '../../../src/renderer/visualizer/effects/waveform'
import { PALETTE_SLOT_COUNT, type Palette } from '../../../src/renderer/visualizer/palette'

/**
 * W23-7: the 2D effects against a recording stub context. The tests
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
  | {
      kind: 'fillRect' | 'stroke' | 'fill'
      alpha: number
      op: string
      style: unknown
      m: number[]
      path: number[]
    }
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
  /** The current path's coordinates, flattened, for comparing runs. */
  path: number[] = []

  beginPath(): void {
    this.path = []
  }
  closePath(): void {}
  moveTo(x: number, y: number): void {
    this.check('moveTo', [x, y])
    this.path.push(x, y)
  }
  lineTo(x: number, y: number): void {
    this.check('lineTo', [x, y])
    this.path.push(x, y)
  }
  arc(x: number, y: number, r: number, start: number, end: number): void {
    this.check('arc', [x, y, r, start, end])
    if (r < 0) this.nonFinite.push('arc:negative radius')
    this.path.push(x, y, r, start, end)
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
      m: this.matrix,
      path: this.path.slice()
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
  stereo: { left: Float32Array; right: Float32Array; live: boolean } | null
}

const WASH = image('wash', 1280, 720)

function makeStage(): MutableStage {
  return {
    emergence: 1,
    intensity: 1,
    wash: { source: WASH, scale: 1.25 },
    cover: { current: slot('a', 640, 640), previous: null, mix: 1 },
    stereo: { left: new Float32Array(1024), right: new Float32Array(1024), live: true }
  }
}

/** A widening stereo field: the right channel drifts out of phase with the left. */
function animateStereo(stage: MutableStage, timeSec: number): void {
  const stereo = stage.stereo
  if (!stereo) return
  const spread = timeSec * 0.8
  for (let index = 0; index < stereo.left.length; index++) {
    const angle = (index / 1024) * Math.PI * 2 * 5 + timeSec * 6
    stereo.left[index] = 0.4 * Math.sin(angle)
    stereo.right[index] = 0.3 * Math.sin(angle + spread)
  }
  // Now and then nothing is audible: the read answers false.
  stereo.live = Math.floor(timeSec * 2) % 7 !== 3
}

type Core = (
  ctx: Draw2D<FakeImage>,
  quality: Quality2D
) => Effect2DInstance<FakeImage, AnalysisFrame, Palette>

const CORES: readonly (readonly [string, Core])[] = [
  ['Halo', createHalo],
  ['Gyre', createGyre],
  ['Silk', createSilk],
  ['Phase', createPhase]
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
    animateStereo(stage, time)
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
      const stage: MutableStage = {
        emergence: 1,
        intensity: 1,
        wash: null,
        cover: null,
        stereo: null
      }
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

  for (const [name, core] of CORES) {
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

/** Every stroke's path after `seconds` of a steady, onset-free frame at `dt`. */
function steadyPaths(core: Core, dt: number, frames: number): number[][] {
  const ctx = new RecordingContext()
  const effect = core(ctx, 'auto')
  effect.resize(1280, 720)
  const frame = makeFrame()
  for (let band = 0; band < ANALYSIS_BANDS; band++)
    frame.spectrum[band] = 0.2 + (0.6 * (band % 3)) / 2
  frame.bass = 0.7
  frame.mid = 0.4
  frame.treble = 0.2
  frame.level = 0.5
  frame.silent = false
  for (let n = 0; n < frames; n++) {
    ctx.ops = []
    effect.frame(frame, makePalette(), makeStage(), dt)
  }
  return ctx.ops.flatMap((op) => (op.kind === 'stroke' || op.kind === 'fill' ? [op.path] : []))
}

/**
 * Paths agree to half a pixel. The drive's followers chase a target that moves
 * within a frame, which differs at the sub-pixel level between frame rates;
 * a step-count or per-frame-smoothing bug shows as pixels (Silk's was 1.4).
 */
const SAME_PATH_PX = 0.5

function expectSamePaths(slow: number[][], fast: number[][], tolerance: number): void {
  expect(fast).toHaveLength(slow.length)
  let worst = 0
  for (let n = 0; n < slow.length; n++) {
    expect(fast[n]).toHaveLength(slow[n].length)
    for (let k = 0; k < slow[n].length; k++) {
      worst = Math.max(worst, Math.abs(fast[n][k] - slow[n][k]))
    }
  }
  expect(worst).toBeLessThan(tolerance)
}

describe('Gyre', () => {
  it('splits the bands into rings that cover every band once', () => {
    const spectrum = new Float32Array(ANALYSIS_BANDS).fill(0.5)
    for (const rings of [8, 12, 16]) {
      for (let ring = 0; ring < rings; ring++)
        expect(ringLevel(spectrum, ring, rings)).toBeCloseTo(0.5)
    }
    spectrum.fill(0)
    spectrum[0] = 1
    expect(ringLevel(spectrum, 0, 8)).toBeGreaterThan(0)
    expect(ringLevel(spectrum, 7, 8)).toBe(0)
  })

  it('turns the same whatever the frame rate', () => {
    // 2.025 s at 40 and at 120 fps.
    expectSamePaths(
      steadyPaths(createGyre, 1 / 40, 81),
      steadyPaths(createGyre, 1 / 120, 243),
      SAME_PATH_PX
    )
  })
})

describe('Silk', () => {
  it('lays its threads the same whatever the frame rate', () => {
    // 2.025 s is a quarter of a 1/90 s step away from a boundary at either rate.
    expectSamePaths(
      steadyPaths(createSilk, 1 / 40, 81),
      steadyPaths(createSilk, 1 / 120, 243),
      SAME_PATH_PX
    )
  })
})

/** A frame for a section: loud and busy (an onset every `beatSec`) or quiet. */
function section(frame: MutableFrame, timeSec: number, dt: number, loud: boolean): void {
  animate(frame, timeSec, dt)
  if (loud) {
    frame.level = 0.85
    frame.onset = timeSec % 0.25 < dt ? 1 : 0
  } else {
    frame.level = 0.2
    frame.onset = 0
    for (let index = 0; index < frame.waveform.length; index++) frame.waveform[index] *= 0.2
  }
}

describe('the drive', () => {
  it('jumps on a beat and lets go', () => {
    const drive = createDrive()
    const frame = makeFrame()
    frame.silent = false
    frame.onset = 0.8
    drive.update(frame, 1 / 60)
    expect(drive.pulse).toBeCloseTo(0.8)
    frame.onset = 0
    for (let n = 0; n < 60; n++) drive.update(frame, 1 / 60)
    expect(drive.pulse).toBeLessThan(0.02)
  })

  it('heats up through a loud, busy section and cools in a quiet one', () => {
    const drive = createDrive()
    const frame = makeFrame()
    let time = 0
    for (let n = 0; n < 6 * 60; n++) {
      time += 1 / 60
      section(frame, time, 1 / 60, true)
      drive.update(frame, 1 / 60)
    }
    const hot = drive.heat
    expect(hot).toBeGreaterThan(0.6)
    for (let n = 0; n < 10 * 60; n++) {
      time += 1 / 60
      section(frame, time, 1 / 60, false)
      drive.update(frame, 1 / 60)
    }
    expect(drive.heat).toBeLessThan(hot * 0.3)
  })

  it('heats the same whatever the frame rate', () => {
    function heatAt(dt: number): number {
      const drive = createDrive()
      const frame = makeFrame()
      const frames = Math.round(4 / dt)
      for (let n = 0; n < frames; n++) {
        section(frame, (n + 1) * dt, dt, true)
        drive.update(frame, dt)
      }
      return drive.heat
    }
    expect(heatAt(1 / 120)).toBeCloseTo(heatAt(1 / 30), 1)
  })

  it('reads a bright spectrum as high and a dark one as low', () => {
    const dark = new Float32Array(ANALYSIS_BANDS)
    const bright = new Float32Array(ANALYSIS_BANDS)
    for (let band = 0; band < ANALYSIS_BANDS; band++) {
      dark[band] = band < 10 ? 1 : 0
      bright[band] = band > 50 ? 1 : 0
    }
    expect(spectralCentroid(dark)).toBeLessThan(0.15)
    expect(spectralCentroid(bright)).toBeGreaterThan(0.8)
    expect(spectralCentroid(new Float32Array(ANALYSIS_BANDS))).toBe(0.5)
  })
})

describe('Phase (W23-14)', () => {
  const N = 64
  function sine(amplitude: number, sign = 1): Float32Array {
    return Float32Array.from({ length: N }, (_, n) => sign * amplitude * Math.sin((n / N) * 6.283))
  }
  function map(left: Float32Array, right: Float32Array): number[] {
    const out = new Float32Array(N * 2)
    const count = mapPhasePoints(left, right, 1, out)
    expect(count).toBe(N)
    return Array.from(out)
  }

  it('maps a mono sine onto a vertical line', () => {
    const points = map(sine(0.8), sine(0.8))
    let tallest = 0
    for (let n = 0; n < N; n++) {
      expect(points[n * 2]).toBeCloseTo(0, 6)
      tallest = Math.max(tallest, Math.abs(points[n * 2 + 1]))
    }
    expect(tallest).toBeGreaterThan(1)
  })

  it('maps a left-only signal onto the up-left diagonal and right-only onto up-right', () => {
    const silence = new Float32Array(N)
    const leftOnly = map(sine(0.8), silence)
    const rightOnly = map(silence, sine(0.8))
    for (let n = 0; n < N; n++) {
      expect(leftOnly[n * 2]).toBeCloseTo(-leftOnly[n * 2 + 1], 6)
      expect(rightOnly[n * 2]).toBeCloseTo(rightOnly[n * 2 + 1], 6)
    }
    // A positive left sample lands up and to the left.
    const top = sine(0.8).indexOf(Math.max(...sine(0.8)))
    expect(leftOnly[top * 2]).toBeLessThan(0)
    expect(leftOnly[top * 2 + 1]).toBeGreaterThan(0)
  })

  it('maps anti-phase content onto a horizontal line', () => {
    const points = map(sine(0.8), sine(0.8, -1))
    let widest = 0
    for (let n = 0; n < N; n++) {
      expect(points[n * 2 + 1]).toBeCloseTo(0, 6)
      widest = Math.max(widest, Math.abs(points[n * 2]))
    }
    expect(widest).toBeGreaterThan(1)
  })

  it('strides, scales, clips, reports the peak and never overruns', () => {
    const left = sine(1)
    const right = new Float32Array(N)
    const out = new Float32Array(10)
    const peak = new Float32Array(1)
    const count = mapPhasePoints(left, right, 2, out, 4, 1, peak)
    expect(count).toBe(5)
    for (const value of out) expect(Math.abs(value)).toBeLessThanOrEqual(1)
    expect(peak[0]).toBeGreaterThan(0)
    expect(peak[0]).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-6)
  })

  it('draws no live sweep while the read answers nothing, and its glow fades out', () => {
    const ctx = new RecordingContext()
    const phase = createPhase(ctx, 'auto')
    phase.resize(800, 800)
    const frame = makeFrame()
    const stage = makeStage()
    for (let n = 0; n < 30; n++) {
      animateStereo(stage, n / 60)
      stage.stereo!.live = true
      phase.frame(frame, makePalette(), stage, 1 / 60)
    }
    stage.stereo!.live = false
    ctx.ops = []
    phase.frame(frame, makePalette(), stage, 1 / 60)
    const strokes = ctx.ops.filter((op) => op.kind === 'stroke')
    // The graticule and the fading history, no live sweep in the accent colour.
    expect(strokes.length).toBeGreaterThan(1)
    expect(strokes.some((op) => op.kind === 'stroke' && op.style === makePalette().css[11])).toBe(
      false
    )

    for (let n = 0; n < 200; n++) phase.frame(frame, makePalette(), stage, 1 / 30)
    ctx.ops = []
    phase.frame(frame, makePalette(), stage, 1 / 60)
    expect(ctx.ops.filter((op) => op.kind === 'stroke')).toHaveLength(1)
    phase.dispose()
  })

  it('lays sweeps at the same pace whatever the frame rate', () => {
    function sweepsAfter(dt: number): number {
      const ctx = new RecordingContext()
      const phase = createPhase(ctx, 'auto')
      phase.resize(800, 800)
      const frame = makeFrame()
      const stage = makeStage()
      for (let time = 0; time < 0.3; time += dt) {
        animateStereo(stage, time)
        stage.stereo!.live = true
        phase.frame(frame, makePalette(), stage, dt)
      }
      ctx.ops = []
      phase.frame(frame, makePalette(), stage, 0)
      return ctx.ops.filter((op) => op.kind === 'stroke').length
    }
    expect(Math.abs(sweepsAfter(1 / 144) - sweepsAfter(1 / 60))).toBeLessThanOrEqual(1)
  })
})
