import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import { SqliteSettingsService } from '../../../src/main/settings'
import {
  booleanValue,
  defineSetting,
  GLOBAL_SCOPE,
  integerValue,
  type SettingDescriptor,
  type SettingsChange
} from '../../../src/shared/settings'

/**
 * A hand-built registry, for the paths the shipped one cannot reach.
 *
 * Every real key is at version 1, so nothing in `SETTINGS_REGISTRY` exercises
 * upgrade-on-read. `test.volume` bumps twice on purpose: the kernel runs the
 * upgrade once per version step, and a two-step gap is the only way to tell that
 * apart from a single call handed the whole distance.
 */
const upgrades: number[] = []

/**
 * Held apart from the list so its `cascade` survives into the type — the list is
 * the erased form, and `resolve` takes a descriptor precisely so a caller with
 * one in hand gets the compile-time check `SETTINGS_REGISTRY` cannot give.
 */
const TEST_VOLUME = defineSetting({
  key: 'test.volume',
  scope: 'durable',
  default: 80,
  version: 3,
  upgrade: (oldValue, oldVersion) => {
    upgrades.push(oldVersion)
    // v1 stored 0–10, v2 stored 0–100, v3 clamps the same range.
    return oldVersion === 1 ? (oldValue as number) * 10 : oldValue
  },
  validate: integerValue({ min: 0, max: 100 }),
  cascade: ['playlist'],
  control: { kind: 'slider', min: 0, max: 100 },
  category: 'audio',
  label: 'Volume',
  help: 'Playback volume.',
  order: 10
})

const TEST_REGISTRY: readonly SettingDescriptor[] = [
  TEST_VOLUME,
  defineSetting<boolean>({
    key: 'test.gapless',
    scope: 'durable',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'playback',
    label: 'Gapless',
    help: 'Play without silence between tracks.',
    order: 10
  }),
  defineSetting<number>({
    key: 'view.paneWidth',
    scope: 'view',
    default: 240,
    validate: integerValue({ min: 120, max: 600 }),
    control: { kind: 'number', min: 120, max: 600 },
    category: 'interface',
    label: 'Pane width',
    help: 'Machine-local, so it never reaches SQLite.',
    order: 10
  })
] as readonly SettingDescriptor[]

const openDatabases: Database.Database[] = []

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close()
  upgrades.length = 0
})

function libraryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db, MIGRATIONS)
  openDatabases.push(db)
  return db
}

interface StoredRow {
  key: string
  scope_kind: string
  scope_id: number | null
  value: string
  version: number
  updated_at: number
}

function rows(db: Database.Database): StoredRow[] {
  return db
    .prepare<[], StoredRow>('SELECT * FROM settings ORDER BY key, scope_kind, scope_id')
    .all()
}

function seed(
  db: Database.Database,
  entries: readonly {
    key: string
    value: string
    version: number
    scope?: [string, number | null]
  }[]
): void {
  const insert = db.prepare(
    'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1)'
  )
  for (const entry of entries) {
    const [kind, id] = entry.scope ?? ['global', null]
    insert.run(entry.key, kind, id, entry.value, entry.version)
  }
}

function service(
  db: Database.Database,
  overrides: { onChanged?: (changes: SettingsChange[]) => void } = {}
): SqliteSettingsService {
  return new SqliteSettingsService({
    db,
    registry: TEST_REGISTRY,
    now: () => 1_700_000_000_000,
    ...overrides
  })
}

describe('SqliteSettingsService', () => {
  it('defaults every key the store has never seen', () => {
    const db = libraryDb()
    const settings = service(db)

    expect(settings.get('test.volume')).toBe(80)
    expect(settings.get('test.gapless')).toBe(true)
    // Absent means default. Writing every default at first launch would freeze
    // them, so a later change to a default could never reach an existing user.
    expect(rows(db)).toEqual([])
  })

  it('round-trips a value through the table and a fresh service', () => {
    const db = libraryDb()

    const changes = service(db).set({ key: 'test.volume', value: 35 })
    expect(changes).toEqual([
      { key: 'test.volume', scope: { kind: 'global', id: null }, value: 35, cleared: false }
    ])

    expect(rows(db)).toEqual([
      {
        key: 'test.volume',
        scope_kind: 'global',
        scope_id: null,
        value: '35',
        version: 3,
        updated_at: 1_700_000_000_000
      }
    ])

    // A second service reads what the first wrote, not what it remembered.
    expect(service(db).get('test.volume')).toBe(35)
  })

  it('stores the value a validator repaired, not the one it was sent', () => {
    const db = libraryDb()

    expect(service(db).set({ key: 'test.volume', value: 400 })).toEqual([
      { key: 'test.volume', scope: { kind: 'global', id: null }, value: 100, cleared: false }
    ])
    expect(rows(db)[0]).toMatchObject({ value: '100' })
  })

  it('refuses a value the validator rejects outright', () => {
    const db = libraryDb()
    const settings = service(db)

    expect(() => settings.set({ key: 'test.volume', value: 'loud' })).toThrow(/expected an integer/)
    expect(rows(db)).toEqual([])
  })

  it('refuses an unknown key and a view-scoped one', () => {
    const settings = service(libraryDb())

    expect(() => settings.set({ key: 'test.nope', value: 1 })).toThrow(/Unknown setting/)
    expect(() => settings.set({ key: 'view.paneWidth', value: 300 })).toThrow(/view-scoped/)
  })

  it('runs the upgrade chain once per version step and writes the result back', () => {
    const db = libraryDb()
    seed(db, [{ key: 'test.volume', value: '7', version: 1 }])

    const settings = service(db)

    // 7 at v1 is 70 at v2, and v2 to v3 leaves it alone.
    expect(settings.get('test.volume')).toBe(70)
    expect(upgrades).toEqual([1, 2])
    expect(rows(db)).toEqual([
      {
        key: 'test.volume',
        scope_kind: 'global',
        scope_id: null,
        value: '70',
        version: 3,
        updated_at: 1_700_000_000_000
      }
    ])

    // The write-back is what makes it a one-time cost: reopening runs nothing.
    upgrades.length = 0
    expect(service(db).get('test.volume')).toBe(70)
    expect(upgrades).toEqual([])
  })

  it('preserves a stored key it has no descriptor for', () => {
    const db = libraryDb()
    seed(db, [{ key: 'audio.fromAnotherBranch', value: '{"a":1}', version: 4 }])

    const settings = service(db)

    expect(settings.getAll().values).not.toHaveProperty('audio.fromAnotherBranch')
    expect(settings.getAll().notices).toEqual([])
    // Untouched: switching back to the branch that defines it must find it.
    expect(rows(db)).toEqual([
      {
        key: 'audio.fromAnotherBranch',
        scope_kind: 'global',
        scope_id: null,
        value: '{"a":1}',
        version: 4,
        updated_at: 1
      }
    ])
  })

  it('does not clear unknown keys on a reset-everything', () => {
    const db = libraryDb()
    seed(db, [
      { key: 'audio.fromAnotherBranch', value: '"keep me"', version: 1 },
      { key: 'test.volume', value: '20', version: 3 }
    ])

    const settings = service(db)
    settings.reset({})

    expect(rows(db).map((row) => row.key)).toEqual(['audio.fromAnotherBranch'])
    expect(settings.get('test.volume')).toBe(80)
  })

  it('falls back to the default on an invalid stored value without overwriting it', () => {
    const db = libraryDb()
    seed(db, [{ key: 'test.gapless', value: '"yes"', version: 1 }])

    const settings = service(db)

    expect(settings.get('test.gapless')).toBe(true)
    expect(settings.loadNotices()).toEqual([
      { key: 'test.gapless', reason: 'expected a boolean', rejected: 'yes' }
    ])
    // The rejected value survives, so downgrading the build recovers it. This is
    // the one case where `resolution.rewrite` must not be acted on.
    expect(rows(db)[0]).toMatchObject({ value: '"yes"', version: 1 })
  })

  it('reports a row whose value is not JSON rather than coercing it', () => {
    const db = libraryDb()
    seed(db, [{ key: 'test.gapless', value: 'not json at all', version: 1 }])

    const settings = service(db)

    expect(settings.get('test.gapless')).toBe(true)
    expect(settings.loadNotices()[0]).toMatchObject({ key: 'test.gapless' })
    expect(rows(db)[0]).toMatchObject({ value: 'not json at all' })
  })

  it('leaves a value written by a newer build alone', () => {
    const db = libraryDb()
    seed(db, [{ key: 'test.volume', value: '55', version: 9 }])

    const settings = service(db)

    expect(settings.get('test.volume')).toBe(80)
    expect(settings.loadNotices()[0]?.reason).toMatch(/newer than this build/)
    // Not rewritten: the newer build's value has to survive switching back.
    expect(rows(db)[0]).toMatchObject({ value: '55', version: 9 })
  })

  it('keys a scoped override separately from the global row', () => {
    const db = libraryDb()
    const settings = service(db)

    settings.set({ key: 'test.volume', value: 40 })
    settings.set({ key: 'test.volume', value: 90, scope: { kind: 'playlist', id: 7 } })
    settings.set({ key: 'test.volume', value: 20, scope: { kind: 'playlist', id: 8 } })

    expect(rows(db).map((row) => [row.scope_kind, row.scope_id, row.value])).toEqual([
      ['global', null, '40'],
      ['playlist', 7, '90'],
      ['playlist', 8, '20']
    ])

    // The global read is unaffected by either override — W8-5 resolves the
    // cascade; W8-2 only has to store the rows without colliding.
    expect(settings.get('test.volume')).toBe(40)
    expect(service(db).get('test.volume')).toBe(40)
  })

  it('replaces rather than duplicates a global row on rewrite', () => {
    const db = libraryDb()
    const settings = service(db)

    settings.set({ key: 'test.volume', value: 10 })
    settings.set({ key: 'test.volume', value: 20 })
    settings.set({ key: 'test.volume', value: 30 })

    // The declared primary key does not enforce this on its own: SQLite treats
    // two NULL scope_ids as distinct, so without the COALESCE index these would
    // be three rows and the read would pick one arbitrarily.
    expect(rows(db)).toHaveLength(1)
    expect(rows(db)[0]).toMatchObject({ value: '30' })
  })

  it('refuses a scope the key does not cascade to', () => {
    const settings = service(libraryDb())

    expect(() =>
      settings.set({ key: 'test.gapless', value: false, scope: { kind: 'playlist', id: 1 } })
    ).toThrow(/cannot be overridden per playlist/)
    expect(() =>
      settings.set({ key: 'test.volume', value: 50, scope: { kind: 'album', id: 1 } })
    ).toThrow(/cannot be overridden per album/)
  })

  it('resets one key, one category and everything', () => {
    const db = libraryDb()
    const settings = service(db)

    settings.set({ key: 'test.volume', value: 15 })
    settings.set({ key: 'test.gapless', value: false })

    expect(settings.reset({ key: 'test.volume' })).toEqual([
      { key: 'test.volume', scope: { kind: 'global', id: null }, value: 80, cleared: true }
    ])
    expect(settings.get('test.volume')).toBe(80)
    expect(settings.get('test.gapless')).toBe(false)

    // 'playback' holds test.gapless; 'audio' holds test.volume, already reset.
    expect(settings.reset({ category: 'audio' })).toEqual([])
    expect(settings.reset({ category: 'playback' })).toEqual([
      { key: 'test.gapless', scope: { kind: 'global', id: null }, value: true, cleared: true }
    ])
    expect(rows(db)).toEqual([])

    settings.set({ key: 'test.volume', value: 15 })
    expect(settings.reset({}).map((change) => change.key)).toEqual(['test.volume'])
  })

  it('drops a scoped override without disturbing the global value', () => {
    const db = libraryDb()
    const settings = service(db)

    settings.set({ key: 'test.volume', value: 40 })
    settings.set({ key: 'test.volume', value: 90, scope: { kind: 'playlist', id: 7 } })

    expect(settings.reset({ key: 'test.volume', scope: { kind: 'playlist', id: 7 } })).toEqual([
      { key: 'test.volume', scope: { kind: 'playlist', id: 7 }, value: 40, cleared: true }
    ])
    expect(rows(db).map((row) => row.scope_kind)).toEqual(['global'])
    expect(settings.get('test.volume')).toBe(40)
  })

  it('announces every change, including the ones a repair altered', () => {
    const changes: SettingsChange[][] = []
    const db = libraryDb()
    const settings = service(db, { onChanged: (batch) => changes.push(batch) })

    settings.set({ key: 'test.volume', value: 999 })
    settings.reset({ key: 'test.volume' })
    // Nothing to reset, so nothing to announce.
    settings.reset({ key: 'test.volume' })

    expect(changes).toEqual([
      [{ key: 'test.volume', scope: { kind: 'global', id: null }, value: 100, cleared: false }],
      [{ key: 'test.volume', scope: { kind: 'global', id: null }, value: 80, cleared: true }]
    ])
  })

  it('throws on an unknown key rather than answering with undefined', () => {
    const settings = service(libraryDb())

    expect(() => settings.get('test.nope')).toThrow(RangeError)
    expect(() => settings.get('view.paneWidth')).toThrow(/view-scoped/)
  })

  describe('cascade resolution', () => {
    it('walks default, global and override in that order', () => {
      const db = libraryDb()
      const settings = service(db)
      const playlist = { kind: 'playlist', id: 7 } as const

      expect(settings.resolve(TEST_VOLUME, playlist)).toMatchObject({
        value: 80,
        provenance: { level: 'default' },
        overridden: false
      })

      settings.set({ key: 'test.volume', value: 40 })
      expect(settings.resolve(TEST_VOLUME, playlist)).toMatchObject({
        value: 40,
        provenance: { level: 'stored', scope: { kind: 'global' } },
        overridden: false,
        inherited: 40
      })

      settings.set({ key: 'test.volume', value: 90, scope: playlist })
      expect(settings.resolve(TEST_VOLUME, playlist)).toMatchObject({
        value: 90,
        provenance: { level: 'stored', scope: playlist },
        overridden: true,
        inherited: 40
      })
    })

    /**
     * The one a `??` chain gets wrong. Both rows hold 40, and the override is
     * still an override — reverting it is a thing the operator can do and a
     * later change to the global must not do it for them.
     */
    it('keeps an override equal to the value it would inherit', () => {
      const settings = service(libraryDb())
      const playlist = { kind: 'playlist', id: 7 } as const

      settings.set({ key: 'test.volume', value: 40 })
      settings.set({ key: 'test.volume', value: 40, scope: playlist })

      expect(settings.resolve(TEST_VOLUME, playlist)).toMatchObject({
        value: 40,
        overridden: true,
        provenance: { level: 'stored', scope: playlist }
      })
    })

    it('tells a global row holding the default from no global row', () => {
      const settings = service(libraryDb())

      expect(settings.resolve(TEST_VOLUME, GLOBAL_SCOPE).overridden).toBe(false)
      settings.set({ key: 'test.volume', value: 80 })
      expect(settings.resolve(TEST_VOLUME, GLOBAL_SCOPE)).toMatchObject({
        value: 80,
        overridden: true,
        inherited: 80,
        inheritedFrom: { level: 'default' }
      })
    })

    it('upgrades an override row on read, like any other stored value', () => {
      const db = libraryDb()
      seed(db, [{ key: 'test.volume', value: '5', version: 1, scope: ['playlist', 7] }])

      expect(service(db).resolve(TEST_VOLUME, { kind: 'playlist', id: 7 }).value).toBe(50)
    })

    it('falls through a damaged override to the global row', () => {
      const db = libraryDb()
      seed(db, [
        { key: 'test.volume', value: '30', version: 3 },
        { key: 'test.volume', value: '"nonsense"', version: 3, scope: ['playlist', 7] }
      ])

      const resolved = service(db).resolve(TEST_VOLUME, { kind: 'playlist', id: 7 })
      expect(resolved.value).toBe(30)
      expect(resolved.overridden).toBe(false)
      expect(resolved.notices).toHaveLength(1)
    })

    it('refuses a scope the key does not cascade to', () => {
      const settings = service(libraryDb())

      expect(() =>
        // @ts-expect-error test.volume cascades to playlist only
        settings.resolve(TEST_VOLUME, { kind: 'album', id: 1 })
      ).toThrow(/cannot be overridden per album/)
    })
  })

  describe('getOverrides', () => {
    it('returns one scope’s rows unresolved', () => {
      const db = libraryDb()
      const settings = service(db)
      settings.set({ key: 'test.volume', value: 40 })
      settings.set({ key: 'test.volume', value: 90, scope: { kind: 'playlist', id: 7 } })

      expect(settings.getOverrides({ kind: 'playlist', id: 7 })).toEqual({
        scope: { kind: 'playlist', id: 7 },
        stored: { 'test.volume': { value: 90, version: 3 } },
        notices: []
      })
      // A different playlist has none of it.
      expect(settings.getOverrides({ kind: 'playlist', id: 8 }).stored).toEqual({})
    })

    it('drops rows the renderer could not resolve, without deleting them', () => {
      const db = libraryDb()
      seed(db, [
        // A branch this build has never heard of.
        { key: 'test.fromAnotherBranch', value: '1', version: 1, scope: ['playlist', 7] },
        // Real key, but it does not cascade to a playlist at all.
        { key: 'test.gapless', value: 'false', version: 1, scope: ['playlist', 7] },
        { key: 'test.volume', value: '90', version: 3, scope: ['playlist', 7] }
      ])
      const settings = service(db)

      expect(Object.keys(settings.getOverrides({ kind: 'playlist', id: 7 }).stored)).toEqual([
        'test.volume'
      ])
      // Dropped from the answer, kept on disk — the unknown-key rule.
      expect(rows(db)).toHaveLength(3)
    })

    it('reports a row whose JSON will not parse rather than coercing it', () => {
      const db = libraryDb()
      seed(db, [{ key: 'test.volume', value: '{oops', version: 3, scope: ['playlist', 7] }])

      const result = service(db).getOverrides({ kind: 'playlist', id: 7 })
      expect(result.stored).toEqual({})
      expect(result.notices).toHaveLength(1)
    })
  })

  describe('storedKeys', () => {
    it('names the keys a surviving global row supplied, and only those', () => {
      const db = libraryDb()
      // A value equal to the default: indistinguishable from absent by value.
      seed(db, [
        { key: 'test.volume', value: '80', version: 3 },
        { key: 'test.gapless', value: '"not a boolean"', version: 1 }
      ])

      const { values, storedKeys } = service(db).getAll()
      expect(values).toMatchObject({ 'test.volume': 80, 'test.gapless': true })
      // The gapless row was rejected, so the default in `values` did not come
      // from it and attributing it to a row would misname the provenance.
      expect(storedKeys).toEqual(['test.volume'])
    })

    it('follows a write and a reset', () => {
      const settings = service(libraryDb())

      expect(settings.getAll().storedKeys).toEqual([])
      settings.set({ key: 'test.volume', value: 40 })
      expect(settings.getAll().storedKeys).toEqual(['test.volume'])
      // An override is not a global row.
      settings.set({ key: 'test.volume', value: 90, scope: { kind: 'playlist', id: 7 } })
      expect(settings.getAll().storedKeys).toEqual(['test.volume'])
      settings.reset({ key: 'test.volume' })
      expect(settings.getAll().storedKeys).toEqual([])
    })
  })

  it('resolves against the real registry before any window could exist', () => {
    // No `registry` override and no Electron import anywhere in the chain: this
    // is the property the whole main-side store exists for. If `SettingsService`
    // ever needs `app` or a `BrowserWindow`, this fails rather than deadlocking
    // at startup.
    const db = libraryDb()
    db.prepare(
      'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
        "VALUES ('audio.crossfadeMs', 'global', NULL, '2500', 1, 1)"
    ).run()

    const settings = new SqliteSettingsService({ db })

    expect(settings.get('audio.crossfadeMs')).toBe(2500)
    expect(typeof settings.get('theme.mode')).toBe('string')
  })
})
