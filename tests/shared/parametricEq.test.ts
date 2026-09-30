import { describe, expect, it } from 'vitest'
import { EQUALIZER_BAND_LIMIT } from '@shared/audio/equalizer'
import { parseParametricEq } from '@shared/audio/parametricEq'

function sequentialIds(): () => string {
  let n = 0
  return () => `id-${++n}`
}

function parse(text: string) {
  return parseParametricEq(text, { newId: sequentialIds() })
}

const ORATORY_STYLE = `Preamp: -6.7 dB
Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70
Filter 2: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70
Filter 3: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70`

describe('parseParametricEq', () => {
  it('maps a typical AutoEq / oratory1990 profile onto a spec', () => {
    const result = parse(ORATORY_STYLE)
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.spec.preampDb).toBeCloseTo(-6.7, 6)
    expect(result.filtersRead).toBe(3)
    expect(result.warnings).toEqual([])
    expect(result.spec.bands).toEqual([
      { id: 'id-1', type: 'peaking', frequencyHz: 105, gainDb: 5.5, q: 0.7, enabled: true },
      { id: 'id-2', type: 'lowshelf', frequencyHz: 105, gainDb: 5.5, q: 0.7, enabled: true },
      { id: 'id-3', type: 'highshelf', frequencyHz: 10000, gainDb: -2, q: 0.7, enabled: true }
    ])
  })

  it('reads the ON/OFF flag', () => {
    const result = parse('Filter 1: OFF PK Fc 1000 Hz Gain 3 dB Q 1')
    expect(result?.spec.bands[0]?.enabled).toBe(false)
  })

  it('defaults gain and Q when a pass filter omits them', () => {
    const result = parse('Filter 1: ON HP Fc 30 Hz')
    const band = result?.spec.bands[0]
    expect(band?.type).toBe('highpass')
    expect(band?.gainDb).toBe(0)
    expect(band?.q).toBeCloseTo(0.707, 3)
  })

  it('skips an unsupported filter type with a warning', () => {
    const result = parse(`Filter 1: ON PK Fc 1000 Hz Gain 2 dB Q 1
Filter 2: ON BP Fc 2000 Hz Gain 2 dB Q 1`)
    expect(result?.filtersRead).toBe(1)
    expect(result?.warnings.some((w) => w.includes('BP'))).toBe(true)
  })

  it('clamps out-of-range values to the node’s limits', () => {
    const result = parse('Filter 1: ON PK Fc 40000 Hz Gain 400 dB Q 99')
    const band = result?.spec.bands[0]
    expect(band?.frequencyHz).toBe(20000)
    expect(band?.gainDb).toBe(24)
    expect(band?.q).toBe(18)
  })

  it('clamps the pre-amp too', () => {
    expect(parse('Preamp: -50 dB')?.spec.preampDb).toBe(-24)
  })

  it('truncates to the band limit and says how many it dropped', () => {
    const lines = Array.from(
      { length: EQUALIZER_BAND_LIMIT + 3 },
      (_, i) => `Filter ${i + 1}: ON PK Fc ${100 + i} Hz Gain 1 dB Q 1`
    ).join('\n')
    const result = parse(lines)
    expect(result?.spec.bands).toHaveLength(EQUALIZER_BAND_LIMIT)
    expect(result?.warnings.some((w) => w.includes('3'))).toBe(true)
  })

  it('ignores comment and blank lines around the filters', () => {
    const result = parse(`# AutoEq parametric EQ for Some Headphone

Preamp: -3 dB
Filter 1: ON PK Fc 200 Hz Gain 1 dB Q 1
`)
    expect(result?.spec.preampDb).toBe(-3)
    expect(result?.filtersRead).toBe(1)
  })

  it('returns null for text that is not a parametric profile', () => {
    expect(parse('this is just some notes, no filters here')).toBeNull()
    expect(parse('')).toBeNull()
  })
})
