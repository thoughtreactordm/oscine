/**
 * The bundled headphone/IEM EQ device library (W19-9).
 *
 * A curated, offline set of oratory1990's measurements — the reference set the
 * community trusts — expressed as the same {@link EqualizerSpec} the visual editor
 * and the text import (W19-8) already speak. The corpus is *bundled*, never fetched
 * at runtime: Oscine is local-first ("the library is folders on disk"), so a picker
 * that needs the network to browse would be off-brand and fail offline. The trade is
 * bundle weight and staleness, refreshed by re-running the generator.
 *
 * The data lives in the generated sibling {@link ./deviceEqLibrary.generated}, built
 * by `scripts/build-device-eq-library.ts` from a pinned AutoEq commit and committed
 * like a `build/` resource. This module owns the vocabulary around it — the profile
 * shape, the source credit, and the one transform the picker needs (a spec with
 * fresh band ids, so an applied device never shares band identity with the pool it
 * came from).
 *
 * Licensing: AutoEq is MIT (Copyright (c) 2018-2022 Jaakko Pasanen). We redistribute
 * its `ParametricEQ.txt` profiles under that licence and credit oratory1990 in the
 * picker and in the Open Source credits surface. See {@link DEVICE_EQ_SOURCE}.
 */
import type { EqualizerBand, EqualizerSpec } from './equalizer'

export { DEVICE_EQ_LIBRARY, DEVICE_EQ_AUTOEQ_COMMIT } from './deviceEqLibrary.generated'

/** The measurement families oratory1990 publishes, mirrored by AutoEq's result tree. */
export type DeviceType = 'over-ear' | 'in-ear' | 'earbud'

/** One bundled device: a stable id, its display name, its form factor, and its curve. */
export interface DeviceEqProfile {
  /** Stable slug of the name; unique across the library. Not shown to the operator. */
  readonly id: string
  /** The device's display name, e.g. "Sennheiser HD 600". */
  readonly name: string
  readonly type: DeviceType
  /** The parsed curve. Its band ids are placeholders — clone with {@link deviceProfileToSpec}. */
  readonly spec: EqualizerSpec
}

/**
 * Attribution for the bundled measurements. Redistribution follows AutoEq's MIT
 * licence, which asks that the copyright and permission notice travel with the data;
 * the credit line is what the picker shows and the {@link OpenSourceCredit} entry
 * mirrors.
 */
export const DEVICE_EQ_SOURCE = {
  measuredBy: 'oratory1990',
  via: 'AutoEq',
  license: 'MIT',
  copyright: 'Copyright (c) 2018-2022 Jaakko Pasanen',
  url: 'https://github.com/jaakkopasanen/AutoEq',
  credit: 'Measurements by oratory1990, via AutoEq (MIT).'
} as const

/**
 * A device's curve as an {@link EqualizerSpec} ready to become the live curve, with
 * every band given a fresh id. The bundled specs carry placeholder ids (`b0`, `b1`,
 * …) shared by every profile; applying one must mint new identities so the resulting
 * curve — and any preset saved from it — owns its bands (the same identity discipline
 * {@link EqualizerBand.id} exists for).
 */
export function deviceProfileToSpec(
  profile: DeviceEqProfile,
  newId: () => string = () => crypto.randomUUID()
): EqualizerSpec {
  return {
    enabled: profile.spec.enabled,
    preampDb: profile.spec.preampDb,
    bands: profile.spec.bands.map((band: EqualizerBand) => ({ ...band, id: newId() }))
  }
}

/** The preset name offered when a device is applied, e.g. "Sennheiser HD 600 (oratory1990)". */
export function deviceProfilePresetName(profile: DeviceEqProfile): string {
  return `${profile.name} (${DEVICE_EQ_SOURCE.measuredBy})`
}
