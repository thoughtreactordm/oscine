/**
 * Pure build-time transform: one AutoEq `ParametricEQ.txt` → one {@link DeviceEqProfile}.
 *
 * Split out from the generator (`scripts/build-device-eq-library.ts`) so it can be
 * unit-tested off the network with fixture text, exactly like the parser it reuses.
 * The generator owns fetching the corpus and writing the asset; this owns the shape.
 *
 * It reuses W19-8's real {@link parseParametricEq} — the same code the runtime import
 * modal runs — so a bundled device and a hand-imported one can never diverge. Band
 * ids are deterministic placeholders (`b0`, `b1`, …); the picker mints fresh ids on
 * apply via `deviceProfileToSpec`.
 */
import { parseParametricEq } from '../../src/shared/audio/parametricEq'
import type { DeviceEqProfile, DeviceType } from '../../src/shared/audio/deviceEqLibrary'

/** A URL-safe, lowercase slug of a device name — the profile's stable id. */
export function slugifyDeviceId(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'device'
  )
}

/**
 * Build a profile from a device's name, form factor, and its `ParametricEQ.txt`.
 * Returns null when the text carries no preamp and no recognizable filter — the same
 * signal `parseParametricEq` gives — so the generator can skip and warn on it.
 */
export function buildDeviceEqProfile(
  name: string,
  type: DeviceType,
  text: string
): DeviceEqProfile | null {
  let n = 0
  const parsed = parseParametricEq(text, { newId: () => `b${n++}` })
  if (!parsed) return null
  return { id: slugifyDeviceId(name), name, type, spec: parsed.spec }
}
