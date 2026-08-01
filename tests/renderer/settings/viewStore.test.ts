import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  booleanValue,
  defineSetting,
  integerValue,
  recordValue,
  settingsInScope,
  type SettingDescriptor
} from '@shared/settings'
import {
  createViewSettings,
  memoryViewStorage,
  VIEW_STORAGE_PREFIX,
  VIEW_WRITE_DEBOUNCE_MS
} from '../../../src/renderer/settings/viewStore'

/**
 * The one backend the five hand-rolled wrappers collapsed into.
 *
 * Exercised against a hand-built descriptor list rather than the real registry,
 * for the reason `resolveSettings` takes one: every key in the registry is at
 * version 1 until one of them changes shape, so without this the upgrade path
 * has nothing to run.
 */
const TOGGLE = defineSetting<boolean>({
  key: 'view.aToggle',
  scope: 'view',
  default: true,
  validate: booleanValue(),
  control: { kind: 'toggle' },
  category: 'interface',
  label: 'A toggle',
  help: '',
  order: 1
})

const CLAMPED = defineSetting<number>({
  key: 'view.aNumber',
  scope: 'view',
  default: 50,
  validate: integerValue({ min: 0, max: 100 }),
  control: { kind: 'slider', min: 0, max: 100 },
  category: 'interface',
  label: 'A clamped number',
  help: '',
  order: 2
})

const RECORD = defineSetting<Record<string, number>>({
  key: 'view.aRecord',
  scope: 'view',
  default: {},
  validate: recordValue(integerValue({ min: 1, strict: true })),
  category: 'interface',
  label: 'A record',
  help: '',
  internal: true
})

const DESCRIPTORS: readonly SettingDescriptor[] = [TOGGLE, CLAMPED, RECORD]

function entry(key: string, value: unknown, version = 1): [string, string] {
  return [VIEW_STORAGE_PREFIX + key, JSON.stringify({ value, version })]
}

/** Writes through, which is what all but the debounce tests want. */
function store(seed: Readonly<Record<string, string>> = {}) {
  const storage = memoryViewStorage(seed)
  const settings = createViewSettings({ storage, descriptors: DESCRIPTORS, debounceMs: 0 })
  return { storage, settings }
}

function stored(storage: ReturnType<typeof memoryViewStorage>, key: string): unknown {
  const raw = storage.read(VIEW_STORAGE_PREFIX + key)
  return raw === null ? null : (JSON.parse(raw) as { value: unknown }).value
}

afterEach(() => {
  vi.useRealTimers()
})

describe('loading a view store', () => {
  it('is every default with nothing stored', () => {
    const { settings } = store()
    expect(settings.get('view.aToggle')).toBe(true)
    expect(settings.get('view.aNumber')).toBe(50)
    expect(settings.get('view.aRecord')).toEqual({})
    expect(settings.notices.value).toEqual([])
  })

  it('restores what a previous session wrote', () => {
    const { settings } = store(
      Object.fromEntries([entry('view.aToggle', false), entry('view.aNumber', 12)])
    )
    expect(settings.get('view.aToggle')).toBe(false)
    expect(settings.get('view.aNumber')).toBe(12)
  })

  /**
   * Reported rather than coerced, for the reason `SettingsStore` reports a
   * malformed row: a corrupt blob handed to a string key's validator would sail
   * through as an ordinary string and the operator would never learn it was
   * damaged.
   */
  it('files a notice for an entry that is not JSON, and takes the default', () => {
    const { settings } = store({ [VIEW_STORAGE_PREFIX + 'view.aNumber']: '{not json' })
    expect(settings.get('view.aNumber')).toBe(50)
    expect(settings.notices.value).toHaveLength(1)
    expect(settings.notices.value[0]?.key).toBe('view.aNumber')
  })

  it('files a notice for an entry that is JSON but not an entry', () => {
    const { settings } = store({ [VIEW_STORAGE_PREFIX + 'view.aNumber']: '42' })
    expect(settings.get('view.aNumber')).toBe(50)
    expect(settings.notices.value[0]?.reason).toContain('{ value, version }')
  })

  it('repairs a stored value its validator will not take as-is', () => {
    const { settings, storage } = store(Object.fromEntries([entry('view.aNumber', 900)]))
    expect(settings.get('view.aNumber')).toBe(100)
    // Stale on disk, so it is rewritten rather than left to be repaired again
    // on every launch.
    expect(stored(storage, 'view.aNumber')).toBe(100)
  })

  it('drops the entries of a record that fail without failing the record', () => {
    const { settings } = store(
      Object.fromEntries([entry('view.aRecord', { good: 4, bad: 'wide', zero: 0 })])
    )
    expect(settings.get('view.aRecord')).toEqual({ good: 4 })
  })

  /**
   * The unknown-key rule, in its view-scoped form. A branch that adds a key,
   * run once and then switched away from, must still have that key when it is
   * switched back to — so this store never touches an entry it has no
   * descriptor for.
   */
  it('leaves a key from a neighbouring branch alone', () => {
    const foreign = VIEW_STORAGE_PREFIX + 'view.somebodyElses'
    const { storage, settings } = store({ [foreign]: '{"value":7,"version":1}' })
    settings.set('view.aToggle', false)
    settings.flush()
    expect(storage.read(foreign)).toBe('{"value":7,"version":1}')
  })

  it('does not write anything for a key that has no stored entry', () => {
    const { storage } = store()
    expect(storage.writes).toBe(0)
  })
})

describe('writing a view store', () => {
  it('validates and repairs on the way in', () => {
    const { settings, storage } = store()
    settings.set('view.aNumber', 900)
    expect(settings.get('view.aNumber')).toBe(100)
    expect(stored(storage, 'view.aNumber')).toBe(100)
  })

  it('falls back to the default and files a notice for a value it refuses', () => {
    const { settings } = store()
    settings.set('view.aNumber', 'wide')
    expect(settings.get('view.aNumber')).toBe(50)
    expect(settings.notices.value).toHaveLength(1)
  })

  it('writes nothing when the value has not changed', () => {
    const { settings, storage } = store()
    settings.set('view.aNumber', 12)
    const after = storage.writes
    settings.set('view.aNumber', 12)
    expect(storage.writes).toBe(after)
  })

  it('forgets the entry on reset rather than storing today s default', () => {
    // So that a later build which changes a default reaches a profile that
    // never overrode it.
    const { settings, storage } = store(Object.fromEntries([entry('view.aNumber', 12)]))
    settings.reset('view.aNumber')
    expect(settings.get('view.aNumber')).toBe(50)
    expect(storage.read(VIEW_STORAGE_PREFIX + 'view.aNumber')).toBeNull()
  })

  it('refuses a key it has no descriptor for', () => {
    const { settings } = store()
    expect(() => settings.get('view.invented')).toThrow(RangeError)
    expect(() => settings.set('view.invented', 1)).toThrow(RangeError)
  })

  it('reads and writes through one binding', () => {
    const { settings } = store()
    const bound = settings.value<number>('view.aNumber')
    bound.value = 30
    expect(bound.value).toBe(30)
    expect(settings.get('view.aNumber')).toBe(30)
  })

  /**
   * Values are snapshots. A deep ref would hand out a reactive proxy of a
   * stored object, and a caller that mutated it would get a re-render and no
   * write — a bug that looks like it worked.
   */
  it('hands out the stored object rather than a proxy of it', () => {
    const { settings, storage } = store()
    settings.set('view.aRecord', { left: 10 })
    const held = settings.get<Record<string, number>>('view.aRecord')
    held.left = 999
    expect(stored(storage, 'view.aRecord')).toEqual({ left: 10 })
  })
})

describe('debouncing writes', () => {
  it('coalesces a drag into one write', () => {
    vi.useFakeTimers()
    const storage = memoryViewStorage()
    const settings = createViewSettings({ storage, descriptors: DESCRIPTORS })

    for (let px = 10; px < 60; px += 1) settings.set('view.aNumber', px)
    expect(storage.writes).toBe(0)

    vi.advanceTimersByTime(VIEW_WRITE_DEBOUNCE_MS)
    expect(storage.writes).toBe(1)
    expect(stored(storage, 'view.aNumber')).toBe(59)
  })

  it('writes what the debounce is holding on flush', () => {
    vi.useFakeTimers()
    const storage = memoryViewStorage()
    const settings = createViewSettings({ storage, descriptors: DESCRIPTORS })

    settings.set('view.aNumber', 22)
    expect(storage.writes).toBe(0)
    settings.flush()
    expect(stored(storage, 'view.aNumber')).toBe(22)

    // The timer it cancelled must not fire a second write.
    vi.advanceTimersByTime(VIEW_WRITE_DEBOUNCE_MS * 2)
    expect(storage.writes).toBe(1)
  })

  it('coalesces two keys into one window rather than two', () => {
    vi.useFakeTimers()
    const storage = memoryViewStorage()
    const settings = createViewSettings({ storage, descriptors: DESCRIPTORS })

    settings.set('view.aNumber', 22)
    vi.advanceTimersByTime(VIEW_WRITE_DEBOUNCE_MS / 2)
    settings.set('view.aToggle', false)
    // The window is not restarted by a later change: a drag that kept emitting
    // would otherwise persist nothing at all until the pointer came up.
    vi.advanceTimersByTime(VIEW_WRITE_DEBOUNCE_MS / 2)
    expect(storage.writes).toBe(2)
    expect(stored(storage, 'view.aToggle')).toBe(false)
  })
})

describe('the real registry', () => {
  it('owns every view-scoped key and nothing else', () => {
    const settings = createViewSettings({ storage: memoryViewStorage(), debounceMs: 0 })
    expect(settings.descriptors).toEqual(settingsInScope('view'))
    expect(settings.descriptors.every((descriptor) => descriptor.scope === 'view')).toBe(true)
  })

  it('runs with no storage at all', () => {
    // A supported configuration, not a degraded one: the values simply last
    // for the session.
    const settings = createViewSettings({ debounceMs: 0 })
    expect(() => settings.set('view.trackGroupingEnabled', false)).not.toThrow()
    expect(settings.get('view.trackGroupingEnabled')).toBe(false)
    expect(() => settings.flush()).not.toThrow()
  })
})
