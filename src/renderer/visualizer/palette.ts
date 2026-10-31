import {
  RAMP_STEPS,
  clampToGamut,
  gammaEncode,
  oklabToLinearRgbInto,
  parseColor
} from '@shared/theme'
import { MAX_FRAME_DT_SEC } from './analysisFrame'

/**
 * The stage visualizer's palette — **W23-2, D35.3**.
 *
 * Colour comes out of the resolved token ramp, never from a second extractor
 * and never from a constant in an effect. The host reads the properties in
 * {@link PALETTE_PROPERTIES} with `getComputedStyle` on the stage canvas (the
 * `WaveformRibbon` precedent), re-reads them on `onThemeChange`, and hands the
 * map to {@link PaletteModel.setTarget}. Nothing here touches the DOM.
 *
 * Reactive colour needs nothing of its own: with `theme.reactive` on the cover
 * seed already reshapes the primary ramp, so a palette built from the ramp
 * follows the art. This module never reads `theme.reactive`.
 *
 * **The palette moves in OKLab, never in steps.** A new target is approached
 * along the straight OKLab line from wherever the palette is, eased by a
 * critically damped follower that settles in {@link PALETTE_LERP_SEC}. It starts
 * from rest (so the first frame of a theme flip barely moves), it carries its
 * velocity through a retarget (so a flip mid-lerp bends the path instead of
 * kinking it), and it never overshoots from rest. That covers both shapes a
 * change arrives in: one step when the operator switches theme, a stream when
 * the 320 ms reactive-accent fade rewrites the ramp every frame. It is also
 * R17's palette half: a dark theme flipping to light is a 600 ms ramp, never a
 * one-frame full-field flash, so the flash guard does not see one.
 *
 * Like `analysisFrame` this is `@renderer`-free and DOM-free; the per-frame
 * `update` allocates nothing while the palette is at rest, and while it moves
 * builds a CSS string only for a slot whose 8-bit colour actually changed.
 */

/** The custom properties the palette is built from, in slot order. */
export const PALETTE_PROPERTIES: readonly string[] = [
  ...RAMP_STEPS.map((step) => `--oscine-color-primary-${step}`),
  '--ui-primary',
  '--ui-bg',
  '--ui-bg-elevated',
  '--ui-text-highlighted',
  '--ui-text-muted'
]

/** Where each colour lives in {@link Palette.css}, and at `slot * 3` in the typed arrays. */
export const PaletteSlot = {
  primary50: 0,
  primary100: 1,
  primary200: 2,
  primary300: 3,
  primary400: 4,
  primary500: 5,
  primary600: 6,
  primary700: 7,
  primary800: 8,
  primary900: 9,
  primary950: 10,
  /** `--ui-primary`, the theme's accent step. */
  accent: 11,
  bg: 12,
  bgElevated: 13,
  textHighlighted: 14,
  textMuted: 15
} as const

export type PaletteSlotId = (typeof PaletteSlot)[keyof typeof PaletteSlot]

export const PALETTE_SLOT_COUNT = PALETTE_PROPERTIES.length

/** How long a change takes to settle (to within 1 %). */
export const PALETTE_LERP_SEC = 0.6

/**
 * The follower's natural frequency. A critically damped step from rest leaves
 * `(1 + ωt)·e^(−ωt)` of the distance; that is 1 % at `ωt ≈ 6.64`.
 */
const OMEGA = 6.64 / PALETTE_LERP_SEC

/** Closer than this to the target (in OKLab), and still enough, and the slot snaps onto it. */
const SETTLE_DISTANCE = 1e-4
const SETTLE_SPEED = 1e-3

/** What every effect reads. The same object every frame, updated in place. */
export interface Palette {
  /** sRGB `rgb()` strings for 2D effects, one per slot. */
  readonly css: readonly string[]
  /** Linear-light RGB, three per slot, clamped to 0..1 — for shader uniforms. */
  readonly linear: Float32Array
  /** OKLab `L a b`, three per slot — for effects that shift lightness or mix. */
  readonly oklab: Float32Array
  /** Bumped whenever any value changed, so an effect can skip re-uploading uniforms. */
  readonly version: number
}

export interface PaletteModel {
  readonly palette: Palette
  /** True while some slot is still travelling towards its target. */
  readonly moving: boolean
  /**
   * A freshly resolved token map — property name to computed value. The first
   * call lands immediately (a stage opening should not fade in from nothing);
   * every later one is lerped to. A property that is missing or does not parse
   * keeps the slot's current target, and is returned so the host can say so.
   */
  setTarget(tokens: ReadonlyMap<string, string>): string[]
  /** Advance one rendered frame. */
  update(dtSec: number): Palette
  /** Jump straight to the target. */
  snap(): void
}

interface MutablePalette {
  css: string[]
  linear: Float32Array
  oklab: Float32Array
  version: number
}

function clampDt(dtSec: number): number {
  if (!(dtSec > 0)) return 0
  return dtSec > MAX_FRAME_DT_SEC ? MAX_FRAME_DT_SEC : dtSec
}

export function createPaletteModel(): PaletteModel {
  const size = PALETTE_SLOT_COUNT * 3
  const oklab = new Float32Array(size)
  const linear = new Float32Array(size)
  // The follower runs in doubles so a slow approach doesn't stall on float rounding.
  const position = new Float64Array(size)
  const velocity = new Float64Array(size)
  const target = new Float64Array(size)
  /** The 24-bit colour each `css` string was built from; −1 for none yet. */
  const packed = new Int32Array(PALETTE_SLOT_COUNT).fill(-1)
  const scratch = new Float64Array(3)

  const palette: MutablePalette = {
    // Empty until the first `setTarget`; a canvas ignores an empty fillStyle.
    css: new Array<string>(PALETTE_SLOT_COUNT).fill(''),
    linear,
    oklab,
    version: 0
  }

  let initialised = false
  let moving = false

  /** Publish `position` into the readable arrays and refresh changed strings. */
  function publish(): void {
    for (let slot = 0; slot < PALETTE_SLOT_COUNT; slot++) {
      const i = slot * 3
      oklab[i] = position[i]
      oklab[i + 1] = position[i + 1]
      oklab[i + 2] = position[i + 2]
      oklabToLinearRgbInto(position[i], position[i + 1], position[i + 2], scratch, 0)
      // An OKLab line between two in-gamut colours can bow out of sRGB; clamp
      // per channel so shaders never see a negative or >1 light.
      let rgb = 0
      for (let c = 0; c < 3; c++) {
        const value = scratch[c]
        const clamped = value > 0 ? (value < 1 ? value : 1) : 0
        linear[i + c] = clamped
        rgb = (rgb << 8) | Math.round(gammaEncode(clamped) * 255)
      }
      if (rgb !== packed[slot]) {
        packed[slot] = rgb
        // eslint-disable-next-line oscine/no-raw-colours -- the formatter for a resolved token, not a colour
        palette.css[slot] = `rgb(${rgb >> 16} ${(rgb >> 8) & 255} ${rgb & 255})`
      }
    }
    palette.version++
  }

  function snap(): void {
    position.set(target)
    velocity.fill(0)
    moving = false
    publish()
  }

  return {
    palette,
    get moving() {
      return moving
    },
    setTarget(tokens) {
      const unresolved: string[] = []
      for (let slot = 0; slot < PALETTE_SLOT_COUNT; slot++) {
        const property = PALETTE_PROPERTIES[slot] ?? ''
        const parsed = parseColor(tokens.get(property) ?? '')
        if (!parsed) {
          unresolved.push(property)
          continue
        }
        // Alpha is dropped: the palette is a set of opaque colours, and an
        // effect that wants transparency applies its own.
        const { l, c, h } = clampToGamut(parsed)
        const rad = (h * Math.PI) / 180
        target[slot * 3] = l
        target[slot * 3 + 1] = c * Math.cos(rad)
        target[slot * 3 + 2] = c * Math.sin(rad)
      }
      if (!initialised) {
        initialised = true
        snap()
      } else {
        moving = true
      }
      return unresolved
    },
    update(dtSec) {
      const dt = clampDt(dtSec)
      if (!moving || dt === 0) return palette

      // The exact critically damped step, so 30 fps and 60 fps trace the same path.
      const decay = Math.exp(-OMEGA * dt)
      let still = true
      for (let i = 0; i < position.length; i++) {
        const offset = position[i] - target[i]
        const carry = (velocity[i] + OMEGA * offset) * dt
        const nextOffset = (offset + carry) * decay
        const nextVelocity = (velocity[i] - OMEGA * carry) * decay
        position[i] = target[i] + nextOffset
        velocity[i] = nextVelocity
        if (Math.abs(nextOffset) > SETTLE_DISTANCE || Math.abs(nextVelocity) > SETTLE_SPEED) {
          still = false
        }
      }
      if (still) snap()
      else publish()
      return palette
    },
    snap
  }
}
