/**
 * The durable half of the settings split.
 *
 * The registry in `@shared/settings` decides what a key is; this decides where
 * it lives and holds the resolved answer. Main-process consumers read through
 * `get`, never off the table — the resolved value is the one that has been
 * upgraded and validated, and a raw row is neither.
 *
 * Loading happens in the constructor, synchronously, which is the property the
 * whole main-side store exists for: `BrowserWindow` is constructed some way
 * further down `app.whenReady()`, and anything that needs a setting to decide
 * how to build the window needs it before that point.
 */

import type BetterSqlite3 from 'better-sqlite3'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { OscineError } from '@shared/errors'
import {
  buildSettingsProfile,
  cascadeLayers,
  GLOBAL_SCOPE,
  parseSettingsProfile,
  planSettingsImport,
  resolveCascade,
  resolveDefault,
  resolveSettings,
  validateValue,
  type CascadeScopeRef,
  type GetAllSettingsResult,
  type GetSettingOverridesResult,
  type ImportSettingsProfileRequest,
  type ResetSettingsRequest,
  type SetSettingRequest,
  type SettingCascade,
  type SettingDescriptor,
  type SettingEntityKind,
  type SettingNotice,
  type SettingScopeRef,
  type SettingsChange,
  type SettingsImportPlan,
  type SettingsProfileExportResult,
  type SettingsProfileFile,
  SETTING_CATEGORIES,
  SETTINGS_PROFILE_FILE_NAME,
  SETTINGS_REGISTRY
} from '@shared/settings'
import { SettingsStore, type WriteEntry } from './store'

export interface SettingsService {
  /** The resolved global value for a durable key. Throws on an unknown key. */
  get<T>(key: string): T
  /**
   * One key resolved down the cascade, with the level that supplied it.
   *
   * Takes a descriptor rather than a key so the entity kinds are checked at
   * compile time — see `CascadeScopeRef`. Main has no cascading consumer of its
   * own yet; this exists because the card's premise is one resolution path, and
   * a path only main's callers cannot reach is two.
   */
  resolve<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): SettingCascade<T>
  /** Every durable key resolved, plus whatever did not survive the load. */
  getAll(): GetAllSettingsResult
  /** The raw override rows at one scope, for a renderer that resolves its own. */
  getOverrides(scope: SettingScopeRef): GetSettingOverridesResult
  set(request: SetSettingRequest): SettingsChange[]
  reset(request: ResetSettingsRequest): SettingsChange[]
  /**
   * Write the portable half of this configuration to a file the operator names.
   *
   * Resolves `null` when they dismiss the save dialog, following
   * `library.addRoot` and `playlists.exportM3u8` — a cancelled dialog is an
   * ordinary outcome and not an error the renderer should have to catch.
   */
  exportProfile(): Promise<SettingsProfileExportResult | null>
  /** Open, read and parse a profile without applying it. `null` on cancel. */
  readProfile(): Promise<SettingsProfileFile | null>
  /** Apply one, and return the plan that was actually applied. */
  importProfile(request: ImportSettingsProfileRequest): SettingsImportPlan
  /** Notices raised while loading, for a log line at startup. */
  loadNotices(): readonly SettingNotice[]
}

/** Opens a dialog this build was not wired with. */
function noPicker(): Promise<string | null> {
  throw new OscineError('io-error', 'Settings profiles are unavailable in this build.')
}

export interface SqliteSettingsServiceOptions {
  db: BetterSqlite3.Database
  /**
   * Defaults to the real registry.
   *
   * Overridable for the same reason `auditRegistry` and `resolveSettings` take a
   * descriptor list: nearly every shipped key is at version 1 — `theme.name` is
   * the one exception, bumped to v2 by the rename — so a test wanting to
   * exercise a particular upgrade path still builds its own registry.
   */
  registry?: readonly SettingDescriptor[]
  /** Injectable so a test can assert on `updated_at` without racing the clock. */
  now?: () => number
  onChanged?: (changes: SettingsChange[]) => void
  /**
   * Opens the OS save dialog on a suggested filename. Resolves `null` on cancel.
   *
   * Injected for the reason `SqlitePlaylistDeps.pickExportFile` is: Electron
   * appears nowhere in this file, so the whole profile path — including the
   * writing and reading of a real file — is drivable from a test with a temp
   * directory and no application.
   */
  pickExportFile?: (suggestedName: string) => Promise<string | null>
  pickImportFile?: () => Promise<string | null>
  /** Stamped into the file so a bug report says which build wrote it. */
  appVersion?: string
}

export class SqliteSettingsService implements SettingsService {
  private readonly store: SettingsStore
  private readonly registry: readonly SettingDescriptor[]
  private readonly byKey: ReadonlyMap<string, SettingDescriptor>
  private readonly now: () => number
  private readonly onChanged: (changes: SettingsChange[]) => void
  private readonly pickExportFile: (suggestedName: string) => Promise<string | null>
  private readonly pickImportFile: () => Promise<string | null>
  private readonly appVersion: string | undefined

  /** Resolved global values for every durable key, defaults included. */
  private values: Record<string, unknown> = {}
  /** Of those, the ones a surviving global row supplied. See `storedKeys`. */
  private stored = new Set<string>()
  private notices: SettingNotice[] = []

  constructor({
    db,
    registry = SETTINGS_REGISTRY,
    now = Date.now,
    onChanged = () => {},
    pickExportFile = noPicker,
    pickImportFile = noPicker,
    appVersion
  }: SqliteSettingsServiceOptions) {
    this.store = new SettingsStore(db)
    this.registry = registry
    this.byKey = new Map(registry.map((descriptor) => [descriptor.key, descriptor]))
    this.now = now
    this.onChanged = onChanged
    this.pickExportFile = pickExportFile
    this.pickImportFile = pickImportFile
    this.appVersion = appVersion
    this.load()
  }

  /**
   * Read the global scope, upgrade what is behind, and persist the upgrades.
   *
   * The write-back is deliberately narrower than `resolution.rewrite`. That list
   * holds every key whose persisted form is stale, which includes the ones that
   * fell back to a default because their stored value was rejected — and
   * overwriting those is exactly what the card forbids. A rejected value stays on
   * disk so that downgrading the build recovers it; only a clean migration or a
   * clean repair earns a write.
   */
  private load(): void {
    const { stored, malformed } = this.store.readScope(GLOBAL_SCOPE)
    const resolution = resolveSettings(stored, 'durable', this.registry)

    this.values = resolution.values
    this.notices = [...malformed, ...resolution.notices]

    const rejected = new Set(resolution.notices.map((notice) => notice.key))
    // A row that was read and accepted is what makes a key "stored". One that was
    // rejected left the default in `values`, and attributing the default to it
    // would tell the cascade a level supplied a value it did not.
    this.stored = new Set(
      Object.keys(stored).filter(
        (key) => !rejected.has(key) && this.byKey.get(key)?.scope === 'durable'
      )
    )
    const entries: WriteEntry[] = resolution.rewrite
      .filter((key) => !rejected.has(key))
      .map((key) => ({
        key,
        scope: GLOBAL_SCOPE,
        value: this.values[key],
        // `rewrite` only ever names keys that had a descriptor to resolve with.
        version: (this.byKey.get(key) as SettingDescriptor).version
      }))

    if (entries.length > 0) this.store.put(entries, this.now())
  }

  /**
   * Throws a `RangeError` rather than a `OscineError` on a bad key, because the
   * callers are main-process code rather than the renderer: a typo here is a bug
   * in this repo, and a bug in this repo should not be flattened into a polite
   * message the renderer displays.
   */
  get<T>(key: string): T {
    const descriptor = this.byKey.get(key)
    if (!descriptor) throw new RangeError(`unknown setting: ${key}`)
    if (descriptor.scope !== 'durable') {
      throw new RangeError(`setting "${key}" is view-scoped and does not live in main`)
    }
    return this.values[key] as T
  }

  /**
   * Read the rows a cascade walks straight off the table rather than off
   * `values`.
   *
   * `values` holds resolved globals with defaults already filled in, and a
   * cascade has to tell a global row holding the default from no global row at
   * all — the two produce different provenance and a different revert
   * affordance. Two indexed point lookups is the honest way to get that.
   */
  resolve<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): SettingCascade<T> {
    if (descriptor.scope !== 'durable') {
      throw new RangeError(`setting "${descriptor.key}" is view-scoped and does not live in main`)
    }
    return resolveCascade(
      descriptor,
      cascadeLayers(descriptor, scope, (level) => this.store.readKey(descriptor.key, level))
    )
  }

  getAll(): GetAllSettingsResult {
    return {
      values: { ...this.values },
      storedKeys: [...this.stored],
      notices: [...this.notices]
    }
  }

  /**
   * Every override row at one scope, unresolved and unfiltered by value.
   *
   * Rows for keys this build does not know, or that do not cascade to this kind
   * of entity, are dropped rather than returned: the first are another branch's
   * and the renderer has no descriptor to resolve them with, and the second
   * cannot have been written by this build at all. Neither is deleted — the
   * unknown-key preservation rule applies to a read as much as to a reset.
   */
  getOverrides(scope: SettingScopeRef): GetSettingOverridesResult {
    const { stored, malformed } = this.store.readScope(scope)

    const kept: GetSettingOverridesResult['stored'] = {}
    for (const [key, entry] of Object.entries(stored)) {
      const descriptor = this.byKey.get(key)
      if (!descriptor || descriptor.scope !== 'durable') continue
      if (scope.kind !== 'global' && !descriptor.cascade.includes(scope.kind)) continue
      kept[key] = entry
    }

    return { scope, stored: kept, notices: malformed }
  }

  loadNotices(): readonly SettingNotice[] {
    return this.notices
  }

  /**
   * Write one key, after validating it here.
   *
   * A value the validator rejects is an error rather than a quiet fallback. That
   * is the opposite of what `load` does with the same rejection, and the
   * asymmetry is the point: a bad value already on disk is the user's history and
   * must not cost them the app, whereas a bad value arriving over IPC is a caller
   * getting it wrong right now and should be told so. A value the validator
   * *repairs* — a number clamped into range — is accepted, and the repaired value
   * is what gets stored and returned.
   */
  set({ key, value, scope = GLOBAL_SCOPE }: SetSettingRequest): SettingsChange[] {
    const descriptor = this.requireDurable(key)
    assertScope(descriptor, scope)

    const resolved = validateValue(descriptor, value)
    if (resolved.notice) {
      throw new OscineError('invalid-request', `${key}: ${resolved.notice.reason}`)
    }

    this.store.put([{ key, scope, value: resolved.value, version: descriptor.version }], this.now())
    if (scope.kind === 'global') {
      this.values[key] = resolved.value
      this.stored.add(key)
    }

    return this.announce([{ key, scope, value: resolved.value, cleared: false }])
  }

  /**
   * Drop stored values so their keys fall back to the default.
   *
   * Only registry keys are targeted. A row whose key has no descriptor belongs to
   * a branch this build has not heard of, and clearing it would make "reset
   * settings" a way to lose another branch's work — the same preservation rule
   * `load` follows.
   */
  reset({ key, category, scope = GLOBAL_SCOPE }: ResetSettingsRequest): SettingsChange[] {
    const requested = this.resetTargets(key, category)

    // Naming one key means the caller asserted it belongs at this scope, so a
    // mismatch is an error. A category or whole-store reset is a sweep, and
    // skips the keys that do not cascade here rather than failing on the first.
    let targets: readonly SettingDescriptor[]
    if (key !== undefined) {
      assertScope(requested[0], scope)
      targets = requested
    } else {
      targets = requested.filter(
        (descriptor) => scope.kind === 'global' || descriptor.cascade.includes(scope.kind)
      )
    }

    const removed = new Set(
      this.store.removeMany(
        targets.map((descriptor) => descriptor.key),
        scope
      )
    )

    const changes: SettingsChange[] = []
    for (const descriptor of targets) {
      if (scope.kind !== 'global') {
        if (!removed.has(descriptor.key)) continue
        // Dropping an override leaves the global value in effect: there is
        // nothing between the two for it to fall through to. `cleared` is what
        // tells a listener that apart from setting the override *to* that value.
        changes.push({
          key: descriptor.key,
          scope,
          value: this.values[descriptor.key],
          cleared: true
        })
        continue
      }

      const next = resolveDefault(descriptor)
      const differs = !sameJson(this.values[descriptor.key], next)
      this.values[descriptor.key] = next
      this.stored.delete(descriptor.key)
      if (differs || removed.has(descriptor.key)) {
        changes.push({ key: descriptor.key, scope, value: next, cleared: true })
      }
    }

    return this.announce(changes)
  }

  /**
   * The configuration as a file.
   *
   * Built before the dialog opens, so what lands on disk is what the operator
   * was looking at when they asked rather than whatever a background write left
   * behind while they browsed for a folder — the same ordering
   * `SqlitePlaylistService.exportM3u8` keeps, for the same reason.
   *
   * `.json` is appended here rather than relied on from the dialog, because GTK
   * hands back whatever was typed and a profile that does not announce itself as
   * JSON is one nothing on the machine will open.
   */
  async exportProfile(): Promise<SettingsProfileExportResult | null> {
    const { profile, excluded } = buildSettingsProfile({
      descriptors: this.registry,
      values: this.values,
      storedKeys: this.stored,
      ...(this.appVersion === undefined ? {} : { app: this.appVersion }),
      exportedAt: new Date(this.now()).toISOString()
    })

    const picked = await this.pickExportFile(SETTINGS_PROFILE_FILE_NAME)
    if (picked === null) return null
    const destination = picked.toLowerCase().endsWith('.json') ? picked : `${picked}.json`

    try {
      // Indented and newline-terminated: the format is advertised as
      // human-readable, and a file meant to be read in a diff or a bug report is
      // not one to minify.
      await writeFile(destination, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
    } catch (error) {
      // The path is logged in main and deliberately not forwarded: an
      // `IpcErrorPayload` never carries one. See `toSafeError`.
      console.error(`[settings] export to ${destination} failed:`, error)
      throw new OscineError('io-error', 'Those settings could not be written to disk.')
    }

    return {
      fileName: basename(destination),
      keyCount: Object.keys(profile.settings).length,
      excluded
    }
  }

  /**
   * Read a profile without applying it.
   *
   * Separate from `importProfile` because the preview between them is the point
   * of the card: the operator picks a file, sees what it would do, and then
   * decides — including deciding between merge and replace, which is a question
   * they cannot answer before seeing the diff.
   */
  async readProfile(): Promise<SettingsProfileFile | null> {
    const picked = await this.pickImportFile()
    if (picked === null) return null

    let text: string
    try {
      text = await readFile(picked, 'utf8')
    } catch (error) {
      console.error(`[settings] import from ${picked} failed:`, error)
      throw new OscineError('io-error', 'That file could not be read.')
    }

    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch (error) {
      throw new OscineError('invalid-request', `That file is not valid JSON: ${asMessage(error)}`)
    }

    const parsed = parseSettingsProfile(raw)
    if (!parsed.ok) {
      throw new OscineError(
        'invalid-request',
        `That file is not a Fermata settings profile: ${parsed.reason}.`
      )
    }

    return { fileName: basename(picked), profile: parsed.profile }
  }

  /**
   * Apply a profile, and return the plan that was applied.
   *
   * The plan is recomputed here rather than taken from the renderer, which has
   * already computed the same one to draw the preview. That is not duplicated
   * work being tolerated — it is the only way the boundary keeps its promise
   * that main validates every write, and because both sides call the same pure
   * function over the same values, the preview and the outcome agree.
   *
   * Unknown keys are written but not announced: there is no descriptor for a
   * listener to resolve them with, and a store that broadcast one would be
   * telling the renderer about a key it cannot type.
   */
  importProfile({ profile, mode }: ImportSettingsProfileRequest): SettingsImportPlan {
    const plan = planSettingsImport({
      descriptors: this.registry,
      profile,
      values: this.values,
      storedKeys: this.stored,
      mode
    })

    const entries: WriteEntry[] = [...plan.apply, ...plan.preserve].map((write) => ({
      key: write.key,
      scope: GLOBAL_SCOPE,
      value: write.value,
      version: write.version
    }))
    if (entries.length > 0) this.store.put(entries, this.now())
    if (plan.clear.length > 0) this.store.removeMany([...plan.clear], GLOBAL_SCOPE)

    const changes: SettingsChange[] = []
    for (const write of plan.apply) {
      this.values[write.key] = write.value
      this.stored.add(write.key)
      changes.push({ key: write.key, scope: GLOBAL_SCOPE, value: write.value, cleared: false })
    }
    for (const key of plan.clear) {
      const next = resolveDefault(this.byKey.get(key) as SettingDescriptor)
      this.values[key] = next
      this.stored.delete(key)
      changes.push({ key, scope: GLOBAL_SCOPE, value: next, cleared: true })
    }

    this.announce(changes)
    return plan
  }

  private resetTargets(key?: string, category?: string): readonly SettingDescriptor[] {
    if (key !== undefined) return [this.requireDurable(key)]

    const durable = this.registry.filter((descriptor) => descriptor.scope === 'durable')
    if (category === undefined) return durable

    if (!SETTING_CATEGORIES.some((entry) => entry.id === category)) {
      throw new OscineError('invalid-request', `Unknown settings category: ${category}`)
    }
    return durable.filter((descriptor) => descriptor.category === category)
  }

  /**
   * The descriptor for a key a caller across IPC named.
   *
   * An unknown key is refused rather than stored. The unknown-key preservation
   * rule is about values already on disk — it says a build must not *delete* what
   * it does not recognise, not that it should accept arbitrary new ones.
   */
  private requireDurable(key: string): SettingDescriptor {
    const descriptor = this.byKey.get(key)
    if (!descriptor) throw new OscineError('invalid-request', `Unknown setting: ${key}`)
    if (descriptor.scope !== 'durable') {
      throw new OscineError('invalid-request', `${key} is view-scoped and is not stored in main.`)
    }
    return descriptor
  }

  private announce(changes: SettingsChange[]): SettingsChange[] {
    if (changes.length > 0) this.onChanged(changes)
    return changes
  }
}

/**
 * A scope a key actually accepts.
 *
 * `cascade` is the descriptor's own declaration of which entities may override
 * it, so this is where a renderer asking to set `interface.theme` per-track gets
 * refused rather than quietly writing a row nothing will ever read.
 */
function assertScope(descriptor: SettingDescriptor, scope: SettingScopeRef): void {
  if (scope.kind === 'global') {
    if (scope.id !== null) {
      throw new OscineError('invalid-request', 'The global scope has no id.')
    }
    return
  }

  if (!descriptor.cascade.includes(scope.kind)) {
    throw new OscineError(
      'invalid-request',
      `${descriptor.key} cannot be overridden per ${scope.kind}.`
    )
  }
  if (!Number.isInteger(scope.id) || (scope.id as number) < 1) {
    throw new OscineError('invalid-request', `A ${scope.kind} scope needs a positive id.`)
  }
}

/** A thrown value's message, without assuming it was an `Error`. */
function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Structural equality, matching how the kernel compares setting values. */
function sameJson(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}
