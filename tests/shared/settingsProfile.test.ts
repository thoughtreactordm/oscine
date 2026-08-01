import { describe, expect, it } from 'vitest'
import {
  booleanValue,
  buildSettingsProfile,
  defineSetting,
  enumValue,
  integerValue,
  parseSettingsProfile,
  planSettingsImport,
  resolveDefault,
  SETTINGS_PROFILE_FORMAT,
  SETTINGS_PROFILE_VERSION,
  SETTINGS_REGISTRY,
  stringValue,
  summarizeSettingsImport,
  type SettingDescriptor,
  type SettingsImportMode,
  type SettingsImportPlan,
  type SettingsProfile
} from '@shared/settings'

/**
 * A store, as the two profile functions see one: resolved values plus which of
 * them came from a row.
 *
 * Applying a plan to it is the same three steps `SqliteSettingsService.
 * importProfile` takes against SQLite, which is what makes a round trip
 * assertable here rather than only against a database.
 */
interface Snapshot {
  values: Record<string, unknown>
  storedKeys: Set<string>
  /** Rows this build has no descriptor for, which an import must not drop. */
  unknown: Record<string, { value: unknown; version: number }>
}

function snapshot(
  descriptors: readonly SettingDescriptor[],
  stored: Readonly<Record<string, unknown>> = {}
): Snapshot {
  const values: Record<string, unknown> = {}
  for (const descriptor of descriptors) values[descriptor.key] = resolveDefault(descriptor)
  for (const [key, value] of Object.entries(stored)) values[key] = value
  return { values, storedKeys: new Set(Object.keys(stored)), unknown: {} }
}

function applyPlan(
  descriptors: readonly SettingDescriptor[],
  state: Snapshot,
  plan: SettingsImportPlan
): Snapshot {
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  const next: Snapshot = {
    values: { ...state.values },
    storedKeys: new Set(state.storedKeys),
    unknown: { ...state.unknown }
  }
  for (const write of plan.apply) {
    next.values[write.key] = write.value
    next.storedKeys.add(write.key)
  }
  for (const write of plan.preserve) {
    next.unknown[write.key] = { value: write.value, version: write.version }
  }
  for (const key of plan.clear) {
    next.values[key] = resolveDefault(byKey.get(key) as SettingDescriptor)
    next.storedKeys.delete(key)
  }
  return next
}

function importInto(
  descriptors: readonly SettingDescriptor[],
  state: Snapshot,
  profile: SettingsProfile,
  mode: SettingsImportMode = 'merge'
): { plan: SettingsImportPlan; state: Snapshot } {
  const plan = planSettingsImport({
    descriptors,
    profile,
    values: state.values,
    storedKeys: state.storedKeys,
    mode
  })
  return { plan, state: applyPlan(descriptors, state, plan) }
}

function exportFrom(descriptors: readonly SettingDescriptor[], state: Snapshot): SettingsProfile {
  return buildSettingsProfile({
    descriptors,
    values: state.values,
    storedKeys: state.storedKeys
  }).profile
}

function statusOf(plan: SettingsImportPlan, key: string): string | undefined {
  return plan.entries.find((entry) => entry.key === key)?.status
}

// --- a hand-built registry ---------------------------------------------------
//
// Every shipped key is at version 1 and only one of them is non-portable, so the
// real registry cannot exercise the upgrade path or a second exclusion at all.
// The registry-walking tests below use the real one; these cover the mechanics.

const gain = defineSetting<number>({
  key: 'test.gain',
  scope: 'durable',
  default: 50,
  validate: integerValue({ min: 0, max: 100, strict: true }),
  control: { kind: 'slider', min: 0, max: 100 },
  category: 'audio',
  label: 'Gain',
  help: '',
  order: 1
})

const mode = defineSetting<'a' | 'b'>({
  key: 'test.mode',
  scope: 'durable',
  default: 'a',
  validate: enumValue(['a', 'b']),
  control: { kind: 'select', options: [{ value: 'a', label: 'A' }] },
  category: 'audio',
  label: 'Mode',
  help: '',
  order: 2
})

const device = defineSetting<string>({
  key: 'test.device',
  scope: 'durable',
  portable: false,
  default: '',
  validate: stringValue({ allowEmpty: true }),
  control: { kind: 'custom', component: 'DeviceControl' },
  category: 'audio',
  label: 'Device',
  help: '',
  order: 3
})

const paneSizes = defineSetting<boolean>({
  key: 'view.thing',
  scope: 'view',
  default: false,
  validate: booleanValue(),
  control: { kind: 'toggle' },
  category: 'interface',
  label: 'A view toggle',
  help: '',
  order: 4
})

/** The same key one version on: the number used to be a string of digits. */
const gainV2 = defineSetting<number>({
  key: 'test.gain',
  scope: 'durable',
  default: 50,
  version: 2,
  upgrade: (old) => (typeof old === 'string' ? Number.parseInt(old, 10) : old),
  validate: integerValue({ min: 0, max: 100, strict: true }),
  control: { kind: 'slider', min: 0, max: 100 },
  category: 'audio',
  label: 'Gain',
  help: '',
  order: 1
})

const REGISTRY = [gain, mode, device, paneSizes]
const NEXT_BUILD = [gainV2, mode, device, paneSizes]

describe('portable', () => {
  it('defaults to true for durable keys and is refused on view state', () => {
    expect(gain.portable).toBe(true)
    expect(device.portable).toBe(false)
    expect(paneSizes.portable).toBe(false)

    expect(() =>
      defineSetting<boolean>({
        key: 'view.portable',
        scope: 'view',
        portable: true,
        default: false,
        validate: booleanValue(),
        control: { kind: 'toggle' },
        category: 'interface',
        label: 'Nope',
        help: '',
        order: 99
      })
    ).toThrow(/never portable/)
  })
})

describe('buildSettingsProfile', () => {
  /**
   * The exclusion is walked, not listed.
   *
   * Every key in the real registry is stored here — including the ones about
   * this machine — and the assertion is over the registry rather than over a
   * list of names, so a new non-portable key is covered the moment it is
   * defined and a key that quietly loses the flag fails here.
   */
  it('excludes every non-portable key in the real registry', () => {
    const values: Record<string, unknown> = {}
    for (const descriptor of SETTINGS_REGISTRY) values[descriptor.key] = resolveDefault(descriptor)

    const { profile, excluded } = buildSettingsProfile({
      descriptors: SETTINGS_REGISTRY,
      values,
      storedKeys: SETTINGS_REGISTRY.map((descriptor) => descriptor.key)
    })

    for (const descriptor of SETTINGS_REGISTRY) {
      expect(descriptor.key in profile.settings).toBe(descriptor.portable)
    }
    expect([...excluded].sort()).toEqual(
      SETTINGS_REGISTRY.filter((descriptor) => !descriptor.portable)
        .map((descriptor) => descriptor.key)
        .sort()
    )

    // The registry has to actually hold both kinds, or the loop above proves
    // nothing. `audio.outputDevice` names hardware and every view key is about
    // this window.
    expect(profile.settings['audio.outputDevice']).toBeUndefined()
    expect(SETTINGS_REGISTRY.some((descriptor) => descriptor.scope === 'view')).toBe(true)
    expect(Object.keys(profile.settings).length).toBeGreaterThan(0)
  })

  it('carries only what has been decided, at this build’s version', () => {
    const state = snapshot(REGISTRY, { 'test.gain': 70, 'test.device': 'Speakers' })
    const profile = exportFrom(REGISTRY, state)

    expect(profile.format).toBe(SETTINGS_PROFILE_FORMAT)
    expect(profile.formatVersion).toBe(SETTINGS_PROFILE_VERSION)
    // `test.mode` sits at its default with no row: a value nobody chose is not a
    // decision to carry to another machine.
    expect(profile.settings).toEqual({ 'test.gain': { value: 70, version: 1 } })
  })

  it('stamps the build and the time when it is given them', () => {
    const { profile } = buildSettingsProfile({
      descriptors: REGISTRY,
      values: snapshot(REGISTRY).values,
      storedKeys: [],
      app: '0.1.0',
      exportedAt: '2026-08-01T12:00:00.000Z'
    })
    expect(profile.app).toBe('0.1.0')
    expect(profile.exportedAt).toBe('2026-08-01T12:00:00.000Z')
  })
})

describe('parseSettingsProfile', () => {
  const valid = {
    format: SETTINGS_PROFILE_FORMAT,
    formatVersion: 1,
    settings: { 'test.gain': { value: 70, version: 1 } }
  }

  it('accepts what the exporter writes, through JSON', () => {
    const profile = exportFrom(REGISTRY, snapshot(REGISTRY, { 'test.gain': 70 }))
    const parsed = parseSettingsProfile(JSON.parse(JSON.stringify(profile)))
    expect(parsed.ok && parsed.profile).toEqual(profile)
  })

  it.each([
    [{}, /format/],
    [{ ...valid, format: 'something.else' }, /format/],
    [{ ...valid, formatVersion: 0 }, /formatVersion/],
    [{ ...valid, formatVersion: SETTINGS_PROFILE_VERSION + 1 }, /newer version of Fermata/],
    [{ ...valid, settings: [] }, /settings must be an object/],
    [{ ...valid, settings: { 'test.gain': 70 } }, /must be an object with a value/],
    [{ ...valid, settings: { 'test.gain': { value: 70 } } }, /version must be an integer/]
  ])('refuses %o', (raw, reason) => {
    const parsed = parseSettingsProfile(raw)
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.reason).toMatch(reason)
  })

  /**
   * A broken entry fails the file rather than being skipped. These are small and
   * advertised as hand-editable: an operator who fat-fingers one key is better
   * served by being told which than by an import that quietly applies the rest.
   */
  it('names the key it could not read', () => {
    const parsed = parseSettingsProfile({
      ...valid,
      settings: { 'test.gain': { value: 70, version: 1 }, 'test.mode': { value: 'b' } }
    })
    expect(parsed.ok === false && parsed.reason).toContain('test.mode')
  })
})

describe('planSettingsImport', () => {
  it('round-trips through a clean profile exactly', () => {
    const source = snapshot(REGISTRY, {
      'test.gain': 70,
      'test.mode': 'b',
      'test.device': 'Speakers'
    })
    const profile = exportFrom(REGISTRY, source)

    const { state: target } = importInto(REGISTRY, snapshot(REGISTRY), profile)

    expect(exportFrom(REGISTRY, target)).toEqual(profile)
    expect(target.values['test.gain']).toBe(70)
    expect(target.values['test.mode']).toBe('b')
    // The machine-local key did not travel, and the target's own is untouched.
    expect(target.values['test.device']).toBe('')
  })

  /**
   * A key stored at exactly its default still travels and is still written. The
   * row is part of the configuration — it is what stops the key tracking a
   * default a later build moves — so a round trip that dropped it would not
   * reproduce the source.
   */
  it('applies a value that does not move, and says it did not', () => {
    const profile = exportFrom(REGISTRY, snapshot(REGISTRY, { 'test.gain': 50 }))
    const { plan, state } = importInto(REGISTRY, snapshot(REGISTRY), profile)

    expect(statusOf(plan, 'test.gain')).toBe('unchanged')
    expect(plan.apply).toEqual([{ key: 'test.gain', value: 50, version: 1 }])
    expect(state.storedKeys.has('test.gain')).toBe(true)
  })

  it('tells new from changed', () => {
    const profile = exportFrom(REGISTRY, snapshot(REGISTRY, { 'test.gain': 70, 'test.mode': 'b' }))
    const { plan } = importInto(REGISTRY, snapshot(REGISTRY, { 'test.mode': 'a' }), profile)

    expect(statusOf(plan, 'test.gain')).toBe('new')
    expect(statusOf(plan, 'test.mode')).toBe('changed')
    expect(plan.entries.find((entry) => entry.key === 'test.mode')).toMatchObject({
      from: 'a',
      to: 'b',
      label: 'Mode',
      category: 'audio'
    })
  })

  it('excludes what describes this machine, with a reason', () => {
    const profile: SettingsProfile = {
      format: SETTINGS_PROFILE_FORMAT,
      formatVersion: 1,
      settings: {
        'test.device': { value: 'Someone else’s DAC', version: 1 },
        'view.thing': { value: true, version: 1 }
      }
    }
    const { plan, state } = importInto(REGISTRY, snapshot(REGISTRY), profile)

    expect(statusOf(plan, 'test.device')).toBe('excluded')
    expect(statusOf(plan, 'view.thing')).toBe('excluded')
    for (const entry of plan.entries) expect(entry.reason).toBeTruthy()
    expect(plan.apply).toEqual([])
    expect(state.values['test.device']).toBe('')
  })

  describe('merge and replace', () => {
    const profile = {
      format: SETTINGS_PROFILE_FORMAT,
      formatVersion: 1,
      settings: { 'test.gain': { value: 70, version: 1 } }
    } as SettingsProfile

    const before = () => snapshot(REGISTRY, { 'test.mode': 'b', 'test.device': 'Speakers' })

    it('merge leaves what the file does not mention', () => {
      const { plan, state } = importInto(REGISTRY, before(), profile, 'merge')

      expect(plan.clear).toEqual([])
      expect(state.values['test.mode']).toBe('b')
      expect(state.storedKeys.has('test.mode')).toBe(true)
    })

    it('replace resets what the file does not mention', () => {
      const { plan, state } = importInto(REGISTRY, before(), profile, 'replace')

      expect(plan.clear).toEqual(['test.mode'])
      expect(statusOf(plan, 'test.mode')).toBe('cleared')
      expect(state.values['test.mode']).toBe('a')
      expect(state.storedKeys.has('test.mode')).toBe(false)
    })

    /**
     * Replace means "make this configuration the one in force", and the output
     * device was never part of the configuration. Wiping it would be a
     * machine-local setting lost to an operation that promised to carry one
     * between machines.
     */
    it('replace leaves the machine-local keys alone', () => {
      const { plan, state } = importInto(REGISTRY, before(), profile, 'replace')

      expect(plan.clear).not.toContain('test.device')
      expect(state.values['test.device']).toBe('Speakers')
    })
  })

  describe('across versions', () => {
    it('runs the upgrade chain a stored value would have run', () => {
      // Written by an older build, where the gain was a string of digits.
      const profile = {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: { 'test.gain': { value: '70', version: 1 } }
      } as SettingsProfile

      const { plan, state } = importInto(NEXT_BUILD, snapshot(NEXT_BUILD), profile)

      expect(statusOf(plan, 'test.gain')).toBe('new')
      expect(plan.apply).toEqual([{ key: 'test.gain', value: 70, version: 2 }])
      expect(state.values['test.gain']).toBe(70)
      // And what it re-exports is at the version this build writes, not the one
      // the file arrived carrying.
      expect(exportFrom(NEXT_BUILD, state).settings['test.gain']).toEqual({
        value: 70,
        version: 2
      })
    })

    it('preserves keys it has never heard of rather than dropping them', () => {
      const profile = {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: {
          'test.gain': { value: 70, version: 1 },
          'future.thing': { value: { deep: true }, version: 3 }
        }
      } as SettingsProfile

      const { plan, state } = importInto(REGISTRY, snapshot(REGISTRY), profile)

      expect(statusOf(plan, 'future.thing')).toBe('unknown')
      expect(plan.preserve).toEqual([{ key: 'future.thing', value: { deep: true }, version: 3 }])
      expect(state.unknown['future.thing']).toEqual({ value: { deep: true }, version: 3 })
    })

    /**
     * A known key at a version this build cannot read is refused rather than
     * written. Nothing is lost by skipping it — unlike a row already on disk,
     * which is preserved precisely because it exists — and writing it would
     * leave the key reading as its default while hiding the value the operator
     * actually has.
     */
    it('refuses a known key written by a newer build', () => {
      const profile = {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: { 'test.gain': { value: 70, version: 9 } }
      } as SettingsProfile

      const { plan, state } = importInto(REGISTRY, snapshot(REGISTRY, { 'test.gain': 30 }), profile)

      expect(statusOf(plan, 'test.gain')).toBe('incompatible')
      expect(plan.apply).toEqual([])
      expect(state.values['test.gain']).toBe(30)
    })

    it('refuses a value its own validator rejects, and applies the rest', () => {
      const profile = {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: {
          'test.gain': { value: 500, version: 1 },
          'test.mode': { value: 'b', version: 1 }
        }
      } as SettingsProfile

      const { plan, state } = importInto(REGISTRY, snapshot(REGISTRY), profile)

      expect(statusOf(plan, 'test.gain')).toBe('invalid')
      expect(plan.entries.find((entry) => entry.key === 'test.gain')?.reason).toMatch(/at most 100/)
      expect(state.values['test.gain']).toBe(50)
      expect(state.values['test.mode']).toBe('b')
    })
  })

  it('counts what the preview header says', () => {
    const profile = {
      format: SETTINGS_PROFILE_FORMAT,
      formatVersion: 1,
      settings: {
        'test.gain': { value: 70, version: 1 },
        'test.device': { value: 'x', version: 1 },
        'future.thing': { value: 1, version: 1 }
      }
    } as SettingsProfile

    const { plan } = importInto(
      REGISTRY,
      snapshot(REGISTRY, { 'test.mode': 'b' }),
      profile,
      'replace'
    )

    expect(summarizeSettingsImport(plan)).toEqual({
      new: 1,
      changed: 0,
      unchanged: 0,
      cleared: 1,
      excluded: 1,
      incompatible: 0,
      invalid: 0,
      unknown: 1
    })
  })
})
