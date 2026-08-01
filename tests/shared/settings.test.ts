import { describe, expect, it } from 'vitest'
import {
  auditRegistry,
  booleanValue,
  defineSetting,
  enumValue,
  getSetting,
  integerValue,
  migrateValue,
  numberValue,
  recordValue,
  resolveDefault,
  resolveDefaults,
  resolveSettings,
  SETTING_CATEGORIES,
  SETTINGS_REGISTRY,
  settingsInCategory,
  settingsInScope,
  stringValue,
  validateValue,
  type SettingDescriptor
} from '@shared/settings'

const toggle = defineSetting<boolean>({
  key: 'test.toggle',
  scope: 'durable',
  default: true,
  validate: booleanValue(),
  control: { kind: 'toggle' },
  category: 'audio',
  label: 'A toggle',
  help: '',
  order: 1
})

const clamped = defineSetting<number>({
  key: 'test.clamped',
  scope: 'durable',
  default: 50,
  validate: integerValue({ min: 0, max: 100 }),
  control: { kind: 'slider', min: 0, max: 100 },
  category: 'audio',
  label: 'A clamped number',
  help: '',
  order: 2
})

describe('defineSetting', () => {
  it('fills the optional fields in', () => {
    expect(toggle.version).toBe(1)
    expect(toggle.upgrade).toBeNull()
    expect(toggle.cascade).toEqual([])
    expect(toggle.keywords).toEqual([])
    expect(toggle.advanced).toBe(false)
    expect(toggle.requiresRestart).toBe(false)
  })

  /**
   * The load-bearing one. A default its own validator rejects is a bug in this
   * repo, so it has to surface when the module is evaluated — which is `npm
   * test` and `npm run build` — rather than as a silent fallback on a user's
   * machine months later.
   */
  it('refuses a default its own validate rejects', () => {
    expect(() =>
      defineSetting<number>({
        key: 'test.badDefault',
        scope: 'durable',
        default: 500,
        validate: integerValue({ min: 0, max: 100, strict: true }),
        control: { kind: 'number' },
        category: 'audio',
        label: 'Out of range',
        help: '',
        order: 3
      })
    ).toThrow(/rejected by its own validate/)
  })

  /**
   * The subtler half of the same rule. Bounds clamp rather than reject, so an
   * out-of-range default comes back "ok" with a *different* value — and would
   * quietly become that other number at every read. A default has to be a fixed
   * point of its own validator, not merely survivable by it.
   */
  it('refuses a default its own validate repairs', () => {
    expect(() =>
      defineSetting<number>({
        key: 'test.repairedDefault',
        scope: 'durable',
        default: 500,
        validate: integerValue({ min: 0, max: 100 }),
        control: { kind: 'number' },
        category: 'audio',
        label: 'Clamped default',
        help: '',
        order: 4
      })
    ).toThrow(/repaired by its own validate to 100/)
  })

  it('accepts an object default a validator rebuilds with the same contents', () => {
    expect(() =>
      defineSetting<Record<string, number>>({
        key: 'test.recordDefault',
        scope: 'durable',
        default: { left: 10 },
        validate: recordValue(integerValue()),
        control: { kind: 'custom', component: 'Whatever' },
        category: 'audio',
        label: 'Record default',
        help: '',
        order: 13
      })
    ).not.toThrow()
  })

  it('refuses a validator that throws on the default', () => {
    expect(() =>
      defineSetting<string>({
        key: 'test.throwingValidate',
        scope: 'durable',
        default: 'x',
        validate: () => {
          throw new Error('boom')
        },
        control: { kind: 'custom', component: 'Whatever' },
        category: 'audio',
        label: 'Throws',
        help: '',
        order: 5
      })
    ).toThrow(/threw on its own default/)
  })

  it('refuses a key that is not dotted and namespaced', () => {
    const bad =
      (key: string): (() => unknown) =>
      (): unknown =>
        defineSetting<boolean>({
          key,
          scope: 'durable',
          default: true,
          validate: booleanValue(),
          control: { kind: 'toggle' },
          category: 'audio',
          label: 'Bad key',
          help: '',
          order: 6
        })
    expect(bad('crossfade')).toThrow(/dotted and namespaced/)
    expect(bad('Audio.crossfadeMs')).toThrow(/dotted and namespaced/)
    expect(bad('audio.')).toThrow(/dotted and namespaced/)
  })

  it('refuses cascade on a view-scoped key', () => {
    expect(() =>
      defineSetting<boolean>({
        key: 'view.cascading',
        scope: 'view',
        default: true,
        validate: booleanValue(),
        cascade: ['album'],
        control: { kind: 'toggle' },
        category: 'interface',
        label: 'Cascading view key',
        help: '',
        order: 7
      })
    ).toThrow(/cascade requires durable scope/)
  })

  it('refuses a select whose options do not contain the default', () => {
    expect(() =>
      defineSetting<'a' | 'b'>({
        key: 'test.orphanDefault',
        scope: 'durable',
        default: 'b',
        validate: enumValue(['a', 'b']),
        control: { kind: 'select', options: [{ value: 'a', label: 'A' }] },
        category: 'audio',
        label: 'Orphan default',
        help: '',
        order: 8
      })
    ).toThrow(/not one of the select options/)
  })

  it('refuses a version bump with no way to reach it', () => {
    const base = {
      key: 'test.versioned',
      scope: 'durable' as const,
      default: true,
      validate: booleanValue(),
      control: { kind: 'toggle' as const },
      category: 'audio' as const,
      label: 'Versioned',
      help: '',
      order: 9
    }
    expect(() => defineSetting({ ...base, version: 3 })).toThrow(/needs an upgrade/)
    expect(() => defineSetting({ ...base, version: 1, upgrade: (v) => v })).toThrow(
      /meaningless at version 1/
    )
  })
})

describe('resolveDefault', () => {
  it('returns the descriptor default', () => {
    expect(resolveDefault(toggle)).toBe(true)
    expect(resolveDefault(clamped)).toBe(50)
  })

  /**
   * A store handed the descriptor's own object would be one `push` away from
   * changing the default for every later read in the process.
   */
  it('clones an object default so a mutable store cannot poison it', () => {
    const record = defineSetting<Record<string, number>>({
      key: 'test.record',
      scope: 'view',
      default: { left: 10 },
      validate: recordValue(integerValue()),
      control: { kind: 'custom', component: 'PaneSizes' },
      category: 'interface',
      label: 'A record',
      help: '',
      order: 10
    })
    const first = resolveDefault(record)
    first.left = 999
    expect(resolveDefault(record)).toEqual({ left: 10 })
  })
})

describe('validateValue', () => {
  it('takes a good value as-is', () => {
    expect(validateValue(clamped, 20)).toEqual({ value: 20, notice: null, changed: false })
  })

  it('reports a repair as changed without a notice', () => {
    const result = validateValue(clamped, 400)
    expect(result.value).toBe(100)
    expect(result.notice).toBeNull()
    expect(result.changed).toBe(true)
  })

  /**
   * The rule from the card: invalid values fall back and raise a notice rather
   * than throwing. A settings file is on the startup path; a bad row in it is
   * not a reason for the app to refuse to open.
   */
  it('falls back with a notice rather than throwing', () => {
    const result = validateValue(clamped, 'twelve')
    expect(result.value).toBe(50)
    expect(result.changed).toBe(true)
    expect(result.notice).toEqual({
      key: 'test.clamped',
      reason: 'expected an integer',
      rejected: 'twelve'
    })
  })

  it('treats a validator that throws as a rejection', () => {
    const exploding = {
      ...clamped,
      validate: () => {
        throw new Error('boom')
      }
    } as unknown as SettingDescriptor<number>
    const result = validateValue(exploding, 7)
    expect(result.value).toBe(50)
    expect(result.notice?.reason).toMatch(/validator failed: boom/)
  })
})

describe('migrateValue', () => {
  /**
   * `upgrade` is called once per version step, so each descriptor only ever
   * describes one transition at a time. This is the whole reason migration is
   * per-key rather than one global settings version.
   */
  const chained = defineSetting<number>({
    key: 'test.chained',
    scope: 'durable',
    default: 0,
    version: 4,
    // v1 held seconds, v2 held a string, v3 held milliseconds as a number.
    upgrade: (value, from) => {
      if (from === 1) return String((value as number) * 1000)
      if (from === 2) return Number(value)
      if (from === 3) return Math.round(value as number)
      throw new Error(`no upgrade from ${from}`)
    },
    validate: integerValue({ min: 0 }),
    control: { kind: 'number' },
    category: 'audio',
    label: 'Chained',
    help: '',
    order: 11
  })

  it('chains upgrades across more than one version bump', () => {
    const result = migrateValue(chained, { value: 2.5, version: 1 })
    expect(result.value).toBe(2500)
    expect(result.notice).toBeNull()
    expect(result.changed).toBe(true)
  })

  it('starts mid-chain when the store is only one version behind', () => {
    expect(migrateValue(chained, { value: 1234.6, version: 3 }).value).toBe(1235)
  })

  it('does nothing when the version already matches', () => {
    expect(migrateValue(chained, { value: 900, version: 4 })).toEqual({
      value: 900,
      notice: null,
      changed: false
    })
  })

  it('falls back with a notice when an upgrade throws', () => {
    const broken = defineSetting<number>({
      key: 'test.brokenUpgrade',
      scope: 'durable',
      default: 7,
      version: 2,
      upgrade: () => {
        throw new Error('cannot read the old shape')
      },
      validate: integerValue(),
      control: { kind: 'number' },
      category: 'audio',
      label: 'Broken upgrade',
      help: '',
      order: 12
    })
    const result = migrateValue(broken, { value: 1, version: 1 })
    expect(result.value).toBe(7)
    expect(result.notice?.reason).toMatch(/upgrade from version 1 failed/)
  })

  it('treats a missing or nonsensical stored version as 1', () => {
    expect(migrateValue(chained, { value: 2.5, version: 0 }).value).toBe(2500)
    expect(migrateValue(chained, { value: 2.5, version: NaN }).value).toBe(2500)
  })

  /**
   * A value written by a newer build reads as the default so this build behaves
   * sanely, but reports `changed: false` so the caller does not write the
   * default back over it. Switching branches must not destroy settings.
   */
  it('reads the default for a future version without offering to overwrite it', () => {
    const result = migrateValue(chained, { value: 'from the future', version: 9 })
    expect(result.value).toBe(0)
    expect(result.changed).toBe(false)
    expect(result.notice?.reason).toMatch(/newer than this build/)
  })
})

describe('validator builders', () => {
  it('booleanValue takes booleans only', () => {
    expect(booleanValue()(true)).toEqual({ ok: true, value: true })
    expect(booleanValue()(1)).toEqual({ ok: false, reason: 'expected a boolean' })
  })

  it('numberValue clamps by default and rejects when strict', () => {
    expect(numberValue({ max: 10 })(11)).toEqual({ ok: true, value: 10 })
    expect(numberValue({ max: 10, strict: true })(11)).toEqual({
      ok: false,
      reason: 'must be at most 10'
    })
    expect(numberValue()(Number.POSITIVE_INFINITY).ok).toBe(false)
    expect(numberValue()(Number.NaN).ok).toBe(false)
  })

  it('integerValue rejects a fraction', () => {
    expect(integerValue()(1.5).ok).toBe(false)
    expect(integerValue()(2)).toEqual({ ok: true, value: 2 })
  })

  it('stringValue trims and refuses blanks unless allowed', () => {
    expect(stringValue()('  hi  ')).toEqual({ ok: true, value: 'hi' })
    expect(stringValue()('   ').ok).toBe(false)
    expect(stringValue({ allowEmpty: true })('   ')).toEqual({ ok: true, value: '' })
    expect(stringValue({ maxLength: 2 })('abc').ok).toBe(false)
  })

  it('enumValue restricts to the listed members', () => {
    expect(enumValue(['a', 'b'])('b')).toEqual({ ok: true, value: 'b' })
    expect(enumValue(['a', 'b'])('c')).toEqual({ ok: false, reason: 'must be one of a, b' })
  })

  it('recordValue drops bad entries instead of failing the record', () => {
    expect(recordValue(integerValue())({ left: 10, right: 'x' })).toEqual({
      ok: true,
      value: { left: 10 }
    })
    expect(recordValue(integerValue())([1, 2]).ok).toBe(false)
    expect(recordValue(integerValue())(null).ok).toBe(false)
  })
})

describe('the assembled registry', () => {
  it('has no duplicate keys and no colliding display slots', () => {
    expect(auditRegistry()).toEqual([])
  })

  it('reports duplicates when a registry has them', () => {
    expect(auditRegistry([toggle, toggle])).toContain('duplicate key: test.toggle')
  })

  it('reports two keys competing for the same position', () => {
    const other = defineSetting<boolean>({
      key: 'test.otherToggle',
      scope: 'durable',
      default: true,
      validate: booleanValue(),
      control: { kind: 'toggle' },
      category: 'audio',
      label: 'Another toggle',
      help: '',
      order: 1
    })
    expect(auditRegistry([toggle, other])).toEqual([
      'test.otherToggle and test.toggle both sit at audio#1'
    ])
  })

  it('resolves every key by name and splits cleanly by scope', () => {
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(getSetting(descriptor.key)).toBe(descriptor)
    }
    expect(getSetting('nope.notHere')).toBeNull()
    expect(settingsInScope('durable').length + settingsInScope('view').length).toBe(
      SETTINGS_REGISTRY.length
    )
  })

  it('places every key in a category the rail actually has', () => {
    const known = new Set<string>(SETTING_CATEGORIES.map((c) => c.id))
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(known.has(descriptor.category)).toBe(true)
    }
  })

  it('returns a category in display order', () => {
    const orders = settingsInCategory('audio').map((d) => d.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('resolves defaults for a whole scope', () => {
    const defaults = resolveDefaults('view')
    expect(Object.keys(defaults).sort()).toEqual(
      settingsInScope('view')
        .map((d) => d.key)
        .sort()
    )
    expect(defaults['playback.shuffle']).toBe(false)
  })
})

describe('resolveSettings', () => {
  it('fills unset keys from their defaults', () => {
    const { values, notices, rewrite } = resolveSettings({}, 'durable')
    expect(values['audio.crossfadeMs']).toBe(0)
    expect(values['library.watcherEnabled']).toBe(true)
    expect(notices).toEqual([])
    expect(rewrite).toEqual([])
  })

  /**
   * The branch-switching rule. A key this build has never heard of is handed
   * straight back so the store can write it out untouched.
   */
  it('preserves an unknown key rather than resolving or dropping it', () => {
    const result = resolveSettings(
      {
        'audio.crossfadeMs': { value: 2000, version: 1 },
        'audio.somethingFromAnotherBranch': { value: { deep: [1, 2] }, version: 7 }
      },
      'durable'
    )
    expect(result.values['audio.crossfadeMs']).toBe(2000)
    expect(result.values['audio.somethingFromAnotherBranch']).toBeUndefined()
    expect(result.unknown).toEqual({
      'audio.somethingFromAnotherBranch': { value: { deep: [1, 2] }, version: 7 }
    })
    expect(result.notices).toEqual([])
  })

  it('collects notices and rewrite candidates for bad stored values', () => {
    const result = resolveSettings(
      {
        'audio.crossfadeMs': { value: 'lots', version: 1 },
        'library.watcherDebounceMs': { value: 100_000, version: 1 }
      },
      'durable'
    )
    expect(result.values['audio.crossfadeMs']).toBe(0)
    expect(result.values['library.watcherDebounceMs']).toBe(30_000)
    expect(result.notices.map((n) => n.key)).toEqual(['audio.crossfadeMs'])
    expect(result.rewrite.sort()).toEqual(['audio.crossfadeMs', 'library.watcherDebounceMs'])
  })

  /**
   * A durable key sitting in localStorage is not unknown — it belongs to the
   * other store, which will resolve it. Claiming it here would let two stores
   * both think they own the value.
   */
  it('leaves out-of-scope known keys alone', () => {
    const result = resolveSettings({ 'audio.crossfadeMs': { value: 2000, version: 1 } }, 'view')
    expect(result.values['audio.crossfadeMs']).toBeUndefined()
    expect(result.unknown).toEqual({})
  })

  it('resolves every scope at once when none is named', () => {
    const result = resolveSettings({})
    expect(Object.keys(result.values).length).toBe(SETTINGS_REGISTRY.length)
  })
})
