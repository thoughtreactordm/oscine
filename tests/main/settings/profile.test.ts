import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import { SqliteSettingsService } from '../../../src/main/settings'
import { isOscineError } from '../../../src/shared/errors'
import {
  booleanValue,
  defineSetting,
  integerValue,
  parseSettingsProfile,
  SETTINGS_PROFILE_FORMAT,
  stringValue,
  type SettingDescriptor,
  type SettingsChange,
  type SettingsProfile
} from '../../../src/shared/settings'

/**
 * W8-13 end to end on the main side: a real database, a real file, and the
 * dialogs faked exactly as `SqlitePlaylistService`'s export fakes its own.
 *
 * The registry is hand-built for the reason every other settings test builds
 * one — the shipped keys are all at version 1 and only one of them is
 * non-portable, so nothing real exercises the second exclusion or the upgrade
 * chain. The registry-walking exclusion proof lives in
 * `tests/shared/settingsProfile.test.ts`, against the real one.
 */
const TEST_REGISTRY: readonly SettingDescriptor[] = [
  defineSetting<number>({
    key: 'test.volume',
    scope: 'durable',
    default: 80,
    validate: integerValue({ min: 0, max: 100, strict: true }),
    control: { kind: 'slider', min: 0, max: 100 },
    category: 'audio',
    label: 'Volume',
    help: '',
    order: 10
  }),
  defineSetting<boolean>({
    key: 'test.gapless',
    scope: 'durable',
    default: true,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'playback',
    label: 'Gapless',
    help: '',
    order: 10
  }),
  defineSetting<string>({
    key: 'test.device',
    scope: 'durable',
    portable: false,
    default: '',
    validate: stringValue({ allowEmpty: true }),
    control: { kind: 'custom', component: 'DeviceControl' },
    category: 'audio',
    label: 'Device',
    help: '',
    order: 20
  }),
  defineSetting<number>({
    key: 'view.paneWidth',
    scope: 'view',
    default: 240,
    validate: integerValue({ min: 120, max: 600 }),
    control: { kind: 'number', min: 120, max: 600 },
    category: 'interface',
    label: 'Pane width',
    help: '',
    order: 10
  })
] as readonly SettingDescriptor[]

const openDatabases: Database.Database[] = []
const tempDirs: string[] = []

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close()
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

function libraryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db, MIGRATIONS)
  openDatabases.push(db)
  return db
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fermata-profile-'))
  tempDirs.push(dir)
  return dir
}

interface ServiceOptions {
  exportTo?: string | null
  importFrom?: string | null
  onChanged?: (changes: SettingsChange[]) => void
}

function service(db: Database.Database, options: ServiceOptions = {}): SqliteSettingsService {
  return new SqliteSettingsService({
    db,
    registry: TEST_REGISTRY,
    now: () => 1_700_000_000_000,
    pickExportFile: async () => options.exportTo ?? null,
    pickImportFile: async () => options.importFrom ?? null,
    appVersion: '0.1.0',
    ...(options.onChanged ? { onChanged: options.onChanged } : {})
  })
}

function readProfileFile(path: string): SettingsProfile {
  const parsed = parseSettingsProfile(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.profile
}

function writeProfileFile(path: string, settings: SettingsProfile['settings']): string {
  writeFileSync(
    path,
    JSON.stringify({ format: SETTINGS_PROFILE_FORMAT, formatVersion: 1, settings }),
    'utf8'
  )
  return path
}

describe('exportProfile', () => {
  it('writes the portable keys, stamped, and says what it held back', async () => {
    const db = libraryDb()
    const destination = join(tempDir(), 'profile.json')
    const settings = service(db, { exportTo: destination })

    settings.set({ key: 'test.volume', value: 55 })
    settings.set({ key: 'test.device', value: 'Speakers' })

    const result = await settings.exportProfile()

    expect(result).toEqual({
      fileName: 'profile.json',
      keyCount: 1,
      excluded: ['test.device']
    })

    const profile = readProfileFile(destination)
    expect(profile.settings).toEqual({ 'test.volume': { value: 55, version: 1 } })
    expect(profile.app).toBe('0.1.0')
    expect(profile.exportedAt).toBe(new Date(1_700_000_000_000).toISOString())
    // Read as text as well: the file is advertised as human-readable, and a
    // minified one is not that.
    expect(readFileSync(destination, 'utf8')).toContain('\n  "settings": {')
  })

  it('appends .json to a bare name the dialog handed back', async () => {
    const dir = tempDir()
    const settings = service(libraryDb(), { exportTo: join(dir, 'mine') })

    const result = await settings.exportProfile()

    expect(result?.fileName).toBe('mine.json')
    expect(() => readProfileFile(join(dir, 'mine.json'))).not.toThrow()
  })

  it('resolves null when the dialog is dismissed', async () => {
    await expect(service(libraryDb(), { exportTo: null }).exportProfile()).resolves.toBeNull()
  })
})

describe('readProfile', () => {
  it('parses without applying anything', async () => {
    const db = libraryDb()
    const path = writeProfileFile(join(tempDir(), 'in.json'), {
      'test.volume': { value: 30, version: 1 }
    })
    const settings = service(db, { importFrom: path })

    const file = await settings.readProfile()

    expect(file?.fileName).toBe('in.json')
    expect(file?.profile.settings).toEqual({ 'test.volume': { value: 30, version: 1 } })
    expect(settings.get('test.volume')).toBe(80)
  })

  it('resolves null when the dialog is dismissed', async () => {
    await expect(service(libraryDb(), { importFrom: null }).readProfile()).resolves.toBeNull()
  })

  it.each([
    ['not json at all', /not valid JSON/],
    ['{"format":"something.else"}', /not a Fermata settings profile/]
  ])('refuses %s', async (contents, message) => {
    const path = join(tempDir(), 'bad.json')
    writeFileSync(path, contents, 'utf8')
    const settings = service(libraryDb(), { importFrom: path })

    await expect(settings.readProfile()).rejects.toSatisfy(
      (error: unknown) => isOscineError(error) && message.test(error.message)
    )
  })

  it('reports a file it cannot read as an io error, without the path', async () => {
    const settings = service(libraryDb(), { importFrom: join(tempDir(), 'absent.json') })

    await expect(settings.readProfile()).rejects.toSatisfy(
      (error: unknown) =>
        isOscineError(error) && error.code === 'io-error' && !error.message.includes('absent.json')
    )
  })
})

describe('importProfile', () => {
  it('writes the rows, updates the resolved values, and announces the change', () => {
    const db = libraryDb()
    const changes: SettingsChange[][] = []
    const settings = service(db, { onChanged: (batch) => changes.push(batch) })

    const plan = settings.importProfile({
      mode: 'merge',
      profile: {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: { 'test.volume': { value: 30, version: 1 } }
      }
    })

    expect(plan.apply).toEqual([{ key: 'test.volume', value: 30, version: 1 }])
    expect(settings.get('test.volume')).toBe(30)
    expect(settings.getAll().storedKeys).toEqual(['test.volume'])
    expect(changes).toEqual([
      [{ key: 'test.volume', scope: { kind: 'global', id: null }, value: 30, cleared: false }]
    ])

    // And it survives a reload, which is the only proof the row is really there.
    expect(service(db).get('test.volume')).toBe(30)
  })

  it('round-trips a configuration into a clean profile exactly', async () => {
    const source = libraryDb()
    const dir = tempDir()
    const destination = join(dir, 'profile.json')
    const again = join(dir, 'again.json')
    const from = service(source, { exportTo: destination })
    from.set({ key: 'test.volume', value: 55 })
    from.set({ key: 'test.gapless', value: false })
    from.set({ key: 'test.device', value: 'Speakers' })
    await from.exportProfile()

    const target = libraryDb()
    const to = service(target, { importFrom: destination, exportTo: again })
    const file = await to.readProfile()
    to.importProfile({ profile: (file as { profile: SettingsProfile }).profile, mode: 'merge' })

    expect(to.get('test.volume')).toBe(55)
    expect(to.get('test.gapless')).toBe(false)
    // Machine-local, so it neither travelled nor arrived.
    expect(to.get('test.device')).toBe('')

    await to.exportProfile()
    expect(readProfileFile(again).settings).toEqual(readProfileFile(destination).settings)
  })

  it('preserves an unknown key into the table without announcing it', () => {
    const db = libraryDb()
    const changes: SettingsChange[][] = []
    const settings = service(db, { onChanged: (batch) => changes.push(batch) })

    settings.importProfile({
      mode: 'merge',
      profile: {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: { 'future.thing': { value: { deep: true }, version: 4 } }
      }
    })

    const row = db
      .prepare<[], { value: string; version: number }>(
        "SELECT value, version FROM settings WHERE key = 'future.thing'"
      )
      .get()
    expect(row).toEqual({ value: '{"deep":true}', version: 4 })
    expect(changes).toEqual([])
  })

  it('replace clears the portable rows the file does not mention, and no others', () => {
    const db = libraryDb()
    const settings = service(db)
    settings.set({ key: 'test.volume', value: 55 })
    settings.set({ key: 'test.gapless', value: false })
    settings.set({ key: 'test.device', value: 'Speakers' })

    const plan = settings.importProfile({
      mode: 'replace',
      profile: {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: { 'test.volume': { value: 30, version: 1 } }
      }
    })

    expect(plan.clear).toEqual(['test.gapless'])
    expect(settings.get('test.volume')).toBe(30)
    expect(settings.get('test.gapless')).toBe(true)
    expect(settings.get('test.device')).toBe('Speakers')
    expect(settings.getAll().storedKeys.sort()).toEqual(['test.device', 'test.volume'])
    expect(service(db).get('test.gapless')).toBe(true)
  })

  it('leaves a rejected value on the floor rather than in the table', () => {
    const db = libraryDb()
    const settings = service(db)

    const plan = settings.importProfile({
      mode: 'merge',
      profile: {
        format: SETTINGS_PROFILE_FORMAT,
        formatVersion: 1,
        settings: {
          'test.volume': { value: 500, version: 1 },
          'test.gapless': { value: false, version: 1 }
        }
      }
    })

    expect(plan.entries.find((entry) => entry.key === 'test.volume')?.status).toBe('invalid')
    expect(settings.get('test.volume')).toBe(80)
    expect(settings.get('test.gapless')).toBe(false)
    expect(settings.getAll().storedKeys).toEqual(['test.gapless'])
  })
})
