/**
 * The contract between a stroke model (Whorl's tunnel, Trace's afterimages) and
 * `strokeRenderer.ts` — W23-16. DOM-free, so the models and their tests can
 * import it without naming a WebGL type; the record layout is documented there.
 */

/** Which palette entry a stroke takes. */
export const StrokeColour = { accent: 0, highlighted: 1 } as const

/** Floats per stroke: placement and row, then width, alpha, colour, and one layout value. */
export const STROKE_FLOATS = 8

/** What a model hands the renderer each frame. */
export interface StrokeSource {
  /** Samples per shape. */
  readonly points: number
  /** Shape rows; the last is the live one. */
  readonly rows: number
  /** `points` per row. */
  readonly shapes: Float32Array
  /** The row snapshotted this frame, or −1. The live row is uploaded every frame. */
  readonly snapshotRow: number
  /** {@link STROKE_FLOATS} per stroke, drawing order. */
  readonly instances: Float32Array
  readonly count: number
}

/** Append one stroke to `instances` at index `count`; returns the new count. */
export function writeStroke(
  instances: Float32Array,
  count: number,
  a: number,
  b: number,
  c: number,
  row: number,
  lineWidth: number,
  alpha: number,
  colour: number,
  extra = 0
): number {
  const at = count * STROKE_FLOATS
  instances[at] = a
  instances[at + 1] = b
  instances[at + 2] = c
  instances[at + 3] = row
  instances[at + 4] = lineWidth
  instances[at + 5] = alpha
  instances[at + 6] = colour
  instances[at + 7] = extra
  return count + 1
}
