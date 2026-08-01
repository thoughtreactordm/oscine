/**
 * The settings kernel: descriptor types, `defineSetting`, and the pure
 * functions that turn a stored value into a usable one.
 *
 * Nothing here reads or writes anything. Storage is W8-2's problem, reactivity
 * is W8-3's, and rendering is W8-4's; all three are downstream of these types
 * and none of them may invent a default of their own.
 *
 * Domain modules import from here. The assembled registry lives one level up in
 * `../settings.ts`, which is what the rest of the app imports — the split is
 * what keeps `defineSetting` and the registry out of an import cycle.
 */

/**
 * Where a key's value lives.
 *
 * `durable` means the SQLite settings table: main can read it before the window
 * exists, and W8-8's export bundle carries it between machines. `view` means
 * the renderer's own local storage: window geometry, pane widths, the shuffle
 * toggle — state that
 * is *about this machine* and would be actively wrong to sync.
 */
export type SettingScope = 'durable' | 'view'

/**
 * Entity kinds a cascading key may be overridden on (W8-5).
 *
 * The type is derived from the list rather than declared beside it, so the
 * runtime array a validator checks against cannot fall behind the union a
 * descriptor is written against.
 */
export const SETTING_ENTITY_KINDS = ['track', 'album', 'artist', 'playlist', 'podcast'] as const

export type SettingEntityKind = (typeof SETTING_ENTITY_KINDS)[number]

/**
 * The category rail on the settings view.
 *
 * Held here rather than derived from the descriptors so the rail has a stable
 * order and a label that does not change when the last key in a category moves.
 */
export const SETTING_CATEGORIES = [
  { id: 'audio', label: 'Audio', icon: 'i-tabler-wave-sine', order: 10 },
  { id: 'playback', label: 'Playback', icon: 'i-tabler-player-play', order: 20 },
  { id: 'library', label: 'Library', icon: 'i-tabler-library', order: 30 },
  { id: 'interface', label: 'Interface', icon: 'i-tabler-layout-2', order: 40 },
  { id: 'podcasts', label: 'Podcasts', icon: 'i-tabler-microphone', order: 50 },
  { id: 'network', label: 'Network', icon: 'i-tabler-world', order: 60 }
] as const

export type SettingCategoryId = (typeof SETTING_CATEGORIES)[number]['id']

export function settingCategory(id: SettingCategoryId): (typeof SETTING_CATEGORIES)[number] {
  const found = SETTING_CATEGORIES.find((c) => c.id === id)
  if (!found) throw new RangeError(`unknown settings category: ${id}`)
  return found
}

/**
 * A validator's answer: the value it accepts, or why it will not.
 *
 * A validator may return a *different* value than it was given — clamping a
 * number into range, trimming a string. That is a repair, and the caller learns
 * about it through `SettingResolution.changed`.
 */
export type SettingValidation<T> = { ok: true; value: T } | { ok: false; reason: string }

export function acceptValue<T>(value: T): SettingValidation<T> {
  return { ok: true, value }
}

export function rejectValue<T>(reason: string): SettingValidation<T> {
  return { ok: false, reason }
}

export type SettingValidator<T> = (raw: unknown) => SettingValidation<T>

/** One choice in a `select` control. */
export interface SettingOption<T> {
  value: T
  label: string
  help?: string
}

/**
 * How W8-4 should render a key.
 *
 * A hint, not a contract: the control never decides what a value may be, the
 * validator does. `custom` is the escape hatch for the genuinely bespoke ones
 * and names a component the settings view resolves.
 */
export type SettingControl<T> =
  | { kind: 'toggle' }
  | { kind: 'number'; min?: number; max?: number; step?: number; unit?: string }
  | { kind: 'slider'; min: number; max: number; step?: number; unit?: string }
  | { kind: 'select'; options: readonly SettingOption<T>[] }
  | { kind: 'path'; select: 'file' | 'directory' }
  | { kind: 'custom'; component: string }

/**
 * Migrate one version step.
 *
 * Called once per bump rather than once per gap, so a key at version 4 never
 * needs a branch on how far back the stored value came from — see
 * `migrateValue`. `oldVersion` is the version being upgraded *from*.
 */
export type SettingUpgrade = (oldValue: unknown, oldVersion: number) => unknown

/** What a domain module hands to `defineSetting`. */
export interface SettingDefinition<
  T,
  C extends readonly SettingEntityKind[] = readonly SettingEntityKind[]
> {
  /** Dotted and namespaced by domain: `audio.crossfadeMs`. */
  key: string
  scope: SettingScope
  /** Authoritative. Nothing outside this registry may hardcode one. */
  default: T
  /** Starts at 1 and bumps whenever the stored shape changes. */
  version?: number
  upgrade?: SettingUpgrade
  validate: SettingValidator<T>
  /** Entity kinds this key accepts per-entity overrides on. Durable keys only. */
  cascade?: C
  /** Required unless `internal`. */
  control?: SettingControl<T>
  category: SettingCategoryId
  label: string
  help: string
  /** Extra search terms for W8-4 beyond the key, label and help. */
  keywords?: readonly string[]
  /** Position within the category. Required unless `internal`. */
  order?: number
  /**
   * State the registry owns but nobody sets by hand.
   *
   * Column widths, open tabs, dragged pane sizes: values with a default, a
   * shape and a validator — everything a descriptor is for — but no row on the
   * settings view, because the control that edits them is the table header and
   * the tab strip. W8-3 absorbed them so that "what a stored blob may contain"
   * is answered in one place rather than five, not so they could grow a second
   * editor. W8-6 renders `settingsInCategory` minus these.
   *
   * An internal key needs no `control` and no `order`, and is exempt from the
   * one-key-per-category-slot audit that only exists to keep the rail tidy.
   */
  internal?: boolean
  /** Presentation flags. Neither changes what the key does. */
  advanced?: boolean
  requiresRestart?: boolean
}

/**
 * A definition with every optional field resolved.
 *
 * `C` is the cascade's entity kinds, carried in the type so that W8-5's
 * `resolveCascade` can refuse a scope the key does not accept at compile time
 * rather than at runtime. It only survives on a descriptor imported directly —
 * `SETTINGS_REGISTRY` is a list of the erased form, and a caller that reached a
 * descriptor through the registry gets the runtime check instead. That is the
 * trade the registry has always made: one list of heterogeneous keys cannot also
 * be a list of their individual types.
 */
export interface SettingDescriptor<
  T = unknown,
  C extends readonly SettingEntityKind[] = readonly SettingEntityKind[]
> {
  readonly key: string
  readonly scope: SettingScope
  readonly default: T
  readonly version: number
  readonly upgrade: SettingUpgrade | null
  readonly validate: SettingValidator<T>
  readonly cascade: C
  /** Null exactly when `internal`. */
  readonly control: SettingControl<T> | null
  readonly category: SettingCategoryId
  readonly label: string
  readonly help: string
  readonly keywords: readonly string[]
  readonly order: number
  readonly internal: boolean
  readonly advanced: boolean
  readonly requiresRestart: boolean
}

const KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

/**
 * Build a descriptor, refusing to build a broken one.
 *
 * The throws here fire at module evaluation, which means the first `npm test`
 * or `npm run build` after a bad edit fails outright rather than shipping a key
 * whose default its own validator rejects. That asymmetry is deliberate: a
 * *stored* value that fails validation falls back quietly with a notice,
 * because the user's disk is not the developer's to crash on. A *default* that
 * fails validation is a bug in this repo and gets the loud treatment.
 *
 * `C` is inferred `const`, so a definition that writes `cascade: ['album',
 * 'playlist']` produces a descriptor whose type says exactly that. Supplying `T`
 * explicitly opts out — TypeScript infers all type arguments or none — which is
 * why the keys that want the narrowing let `T` be inferred from their `default`
 * and `validate` instead of naming it.
 */
export function defineSetting<
  T,
  const C extends readonly SettingEntityKind[] = readonly SettingEntityKind[]
>(definition: SettingDefinition<T, C>): SettingDescriptor<T, C> {
  const {
    key,
    scope,
    version = 1,
    upgrade,
    validate,
    cascade = [] as unknown as C,
    control,
    category,
    label,
    help,
    keywords = [],
    order = 0,
    internal = false,
    advanced = false,
    requiresRestart = false
  } = definition

  // Annotated on the binding, not the arrow, so control-flow analysis knows a
  // call to it ends the branch and narrows what follows.
  const fail: (why: string) => never = (why) => {
    throw new TypeError(`setting "${key}": ${why}`)
  }

  if (!KEY_PATTERN.test(key)) fail('key must be dotted and namespaced, e.g. "audio.crossfadeMs"')
  if (!label.trim()) fail('label is required')
  if (!Number.isInteger(version) || version < 1) fail('version must be an integer >= 1')
  if (upgrade && version === 1) fail('upgrade is meaningless at version 1')
  if (version > 1 && !upgrade) fail(`version ${version} needs an upgrade to reach it from 1`)
  if (cascade.length && scope !== 'durable') fail('cascade requires durable scope')
  if (new Set(cascade).size !== cascade.length) fail('cascade lists an entity kind twice')
  if (!SETTING_CATEGORIES.some((c) => c.id === category)) fail(`unknown category "${category}"`)
  if (!internal && !control) fail('control is required unless the key is internal')
  if (!internal && definition.order === undefined)
    fail('order is required unless the key is internal')
  if (internal && control) fail('an internal key has no row to render, so it takes no control')

  let checked: SettingValidation<T>
  try {
    checked = validate(definition.default)
  } catch (error) {
    return fail(`validate threw on its own default: ${(error as Error).message}`)
  }
  if (!checked.ok) fail(`default is rejected by its own validate: ${checked.reason}`)
  // A default must be a fixed point, not merely acceptable. Bounds clamp rather
  // than reject by default, so an out-of-range default would otherwise sail
  // through here and quietly become a different number at every read.
  if (!sameSettingValue(checked.value, definition.default)) {
    fail(`default is repaired by its own validate to ${JSON.stringify(checked.value)}`)
  }

  if (control?.kind === 'select') {
    if (!control.options.length) fail('a select control needs at least one option')
    if (!control.options.some((o) => sameSettingValue(o.value, definition.default))) {
      fail('the default is not one of the select options')
    }
  }
  if (control?.kind === 'custom' && !control.component.trim()) {
    fail('a custom control must name a component')
  }

  return Object.freeze({
    key,
    scope,
    default: definition.default,
    version,
    upgrade: upgrade ?? null,
    validate,
    cascade: Object.freeze([...cascade]) as unknown as C,
    control: control ?? null,
    category,
    label,
    help,
    keywords: Object.freeze([...keywords]),
    order,
    internal,
    advanced,
    requiresRestart
  })
}

/**
 * Structural equality, enough for the small values settings hold.
 *
 * Exported because "is this value the same as that one" is asked in four places
 * — the kernel's own repair check, both renderer stores, and W8-7's
 * changed-from-default filter — and a filter that answered it differently from
 * the store it reads would show rows that have not moved.
 */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Has this value moved off the key's default?
 *
 * The whole of W8-7's filter, in one line, and deliberately a question about the
 * *value* rather than about whether a row exists. A row holding exactly the
 * default has changed nothing and belongs nowhere near a list of "what have I
 * broken" — it is still worth being able to delete, which is a different
 * question and a different affordance.
 */
export function changedFromDefault(descriptor: SettingDescriptor, value: unknown): boolean {
  return !sameSettingValue(value, descriptor.default)
}

/** A persisted value together with the version it was written under. */
export interface StoredSetting {
  value: unknown
  version: number
}

/** Why a stored value did not survive, in terms a log or a toast can carry. */
export interface SettingNotice {
  key: string
  reason: string
  /** What was on disk. Kept so the notice can say what it replaced. */
  rejected: unknown
}

export interface SettingResolution<T> {
  value: T
  /** Null when the stored value was taken as-is. */
  notice: SettingNotice | null
  /** The persisted form is stale — a caller that can write should rewrite it. */
  changed: boolean
}

/**
 * The default for a key, safe to hand to a mutable store.
 *
 * Object and array defaults are cloned. A descriptor's `default` is frozen at
 * definition only one level deep, and a store that mutated a shared default
 * would poison every later read of that key in the process.
 */
export function resolveDefault<T>(descriptor: SettingDescriptor<T>): T {
  const value = descriptor.default
  return value !== null && typeof value === 'object' ? (structuredClone(value) as T) : value
}

function fallback<T>(
  descriptor: SettingDescriptor<T>,
  rejected: unknown,
  reason: string
): SettingResolution<T> {
  return {
    value: resolveDefault(descriptor),
    notice: { key: descriptor.key, reason, rejected },
    changed: true
  }
}

/**
 * Run a raw value through its validator, falling back rather than throwing.
 *
 * A validator that throws is treated as a rejection. Settings load on the
 * startup path; one careless domain module must not be able to stop the app
 * from opening.
 */
export function validateValue<T>(
  descriptor: SettingDescriptor<T>,
  raw: unknown
): SettingResolution<T> {
  let result: SettingValidation<T>
  try {
    result = descriptor.validate(raw)
  } catch (error) {
    return fallback(descriptor, raw, `validator failed: ${(error as Error).message}`)
  }
  if (!result.ok) return fallback(descriptor, raw, result.reason)
  return { value: result.value, notice: null, changed: !sameSettingValue(result.value, raw) }
}

/**
 * Bring a stored value up to the descriptor's version, then validate it.
 *
 * `upgrade` runs once per version step, so a key that has bumped three times
 * supplies one function that knows three small transitions rather than one that
 * knows nine paths. An upgrade that throws is a rejection, not a crash.
 *
 * A value written by a *newer* build is left alone: the running build reads the
 * default so it behaves sanely, but reports `changed: false` so the caller does
 * not overwrite what the newer build wrote. This is the version-shaped sibling
 * of the unknown-key rule — switching branches must not destroy settings.
 */
export function migrateValue<T>(
  descriptor: SettingDescriptor<T>,
  stored: StoredSetting
): SettingResolution<T> {
  const from =
    Number.isInteger(stored.version) && stored.version >= 1 ? Math.trunc(stored.version) : 1

  if (from > descriptor.version) {
    return {
      value: resolveDefault(descriptor),
      notice: {
        key: descriptor.key,
        reason: `stored at version ${from}, newer than this build's ${descriptor.version}`,
        rejected: stored.value
      },
      changed: false
    }
  }

  let value = stored.value
  for (let version = from; version < descriptor.version; version += 1) {
    // defineSetting guarantees an upgrade exists whenever version > 1.
    const upgrade = descriptor.upgrade as SettingUpgrade
    try {
      value = upgrade(value, version)
    } catch (error) {
      return fallback(
        descriptor,
        stored.value,
        `upgrade from version ${version} failed: ${(error as Error).message}`
      )
    }
  }

  const resolved = validateValue(descriptor, value)
  return { ...resolved, changed: resolved.changed || from !== descriptor.version }
}

// --- validator builders ------------------------------------------------------
//
// Domain modules should reach for these before hand-rolling a validator, so
// that "must be an integer between 0 and 100" reads the same way everywhere and
// the rejection reasons stay uniform enough to show a user.

export function booleanValue(): SettingValidator<boolean> {
  return (raw) => (typeof raw === 'boolean' ? acceptValue(raw) : rejectValue('expected a boolean'))
}

export interface NumberBounds {
  min?: number
  max?: number
  /** Reject a value outside the bounds instead of clamping it into them. */
  strict?: boolean
}

function boundNumber(raw: number, { min, max, strict }: NumberBounds): SettingValidation<number> {
  if (min !== undefined && raw < min) {
    return strict ? rejectValue(`must be at least ${min}`) : acceptValue(min)
  }
  if (max !== undefined && raw > max) {
    return strict ? rejectValue(`must be at most ${max}`) : acceptValue(max)
  }
  return acceptValue(raw)
}

export function numberValue(bounds: NumberBounds = {}): SettingValidator<number> {
  return (raw) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return rejectValue('expected a finite number')
    }
    return boundNumber(raw, bounds)
  }
}

export function integerValue(bounds: NumberBounds = {}): SettingValidator<number> {
  return (raw) => {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return rejectValue('expected an integer')
    return boundNumber(raw, bounds)
  }
}

export interface StringBounds {
  maxLength?: number
  /** Accept the empty string. Off by default — a blank path is rarely meant. */
  allowEmpty?: boolean
}

export function stringValue({
  maxLength,
  allowEmpty = false
}: StringBounds = {}): SettingValidator<string> {
  return (raw) => {
    if (typeof raw !== 'string') return rejectValue('expected a string')
    const trimmed = raw.trim()
    if (!allowEmpty && !trimmed) return rejectValue('must not be empty')
    if (maxLength !== undefined && trimmed.length > maxLength) {
      return rejectValue(`must be at most ${maxLength} characters`)
    }
    return acceptValue(trimmed)
  }
}

export function enumValue<T extends string>(allowed: readonly T[]): SettingValidator<T> {
  return (raw) => {
    if (typeof raw !== 'string') return rejectValue('expected a string')
    return allowed.includes(raw as T)
      ? acceptValue(raw as T)
      : rejectValue(`must be one of ${allowed.join(', ')}`)
  }
}

/**
 * A plain object whose values all pass `inner`.
 *
 * Entries that fail are dropped rather than failing the whole record: these
 * back things like per-pane widths, where one bad pane id should not reset the
 * window layout.
 */
export function recordValue<T>(inner: SettingValidator<T>): SettingValidator<Record<string, T>> {
  return (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return rejectValue('expected an object')
    }
    const out: Record<string, T> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const result = inner(value)
      if (result.ok) out[key] = result.value
    }
    return acceptValue(out)
  }
}
