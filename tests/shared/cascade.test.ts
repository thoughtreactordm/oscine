import { describe, expect, it } from 'vitest'
import {
  assertCascadeScope,
  AUDIO_CROSSFADE_MS,
  cascadeLayers,
  defineSetting,
  DEFAULT_PROVENANCE,
  GLOBAL_SCOPE,
  integerValue,
  provenanceLabel,
  resolveCascade,
  sameProvenance,
  storedProvenance,
  stringValue,
  type CascadeLayer,
  type SettingScopeRef,
  type StoredSetting
} from '@shared/settings'

// `as const` rather than annotated `SettingScopeRef`: the erased shape is exactly
// what `CascadeScopeRef` refuses, so annotating these would be testing the guard
// by tripping over it.
const PLAYLIST = { kind: 'playlist', id: 7 } as const
const ALBUM = { kind: 'album', id: 3 } as const

/** The entity kinds `audio.crossfadeMs` accepts, as its descriptor's type says. */
type CrossfadeCascade = typeof AUDIO_CROSSFADE_MS.cascade

/** A row as the store would hand one over, at the descriptor's current version. */
function row(value: unknown, version = 1): StoredSetting {
  return { value, version }
}

/** The card's three levels, most specific first, as `cascadeLayers` builds them. */
function layers(
  entity: StoredSetting | null,
  global: StoredSetting | null
): CascadeLayer<CrossfadeCascade>[] {
  return [
    { scope: PLAYLIST, stored: entity },
    { scope: GLOBAL_SCOPE, stored: global }
  ]
}

describe('resolveCascade', () => {
  it('falls back to the descriptor default when no level holds a row', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(null, null))

    expect(resolved.value).toBe(0)
    expect(resolved.provenance).toEqual(DEFAULT_PROVENANCE)
    expect(resolved.overridden).toBe(false)
    expect(resolved.inherited).toBe(0)
    expect(resolved.inheritedFrom).toEqual(DEFAULT_PROVENANCE)
    expect(resolved.notices).toEqual([])
  })

  it('takes the global row over the default, and reports it as inherited', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(null, row(2000)))

    expect(resolved.value).toBe(2000)
    expect(resolved.provenance).toEqual(storedProvenance(GLOBAL_SCOPE))
    expect(resolved.overridden).toBe(false)
    // Nothing at this level, so what is in effect and what is inherited agree.
    expect(resolved.inherited).toBe(2000)
    expect(resolved.inheritedFrom).toEqual(storedProvenance(GLOBAL_SCOPE))
  })

  it('takes the entity row over the global one, and reports what reverting restores', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row(500), row(2000)))

    expect(resolved.value).toBe(500)
    expect(resolved.provenance).toEqual(storedProvenance(PLAYLIST))
    expect(resolved.overridden).toBe(true)
    expect(resolved.inherited).toBe(2000)
    expect(resolved.inheritedFrom).toEqual(storedProvenance(GLOBAL_SCOPE))
  })

  /**
   * The state the card singles out. An operator who pinned this playlist to the
   * value the global happened to hold did so precisely so that moving the global
   * would not move the playlist — collapsing it into "inheriting" would throw
   * that away at the exact moment it was meant to take effect.
   */
  it('keeps an override that equals its inherited value', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row(2000), row(2000)))

    expect(resolved.value).toBe(2000)
    expect(resolved.overridden).toBe(true)
    expect(resolved.provenance).toEqual(storedProvenance(PLAYLIST))
    expect(resolved.inherited).toBe(2000)
    expect(resolved.inheritedFrom).toEqual(storedProvenance(GLOBAL_SCOPE))
  })

  it('keeps an override equal to the default when there is no global row', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row(0), null))

    expect(resolved.overridden).toBe(true)
    expect(resolved.provenance).toEqual(storedProvenance(PLAYLIST))
    expect(resolved.inheritedFrom).toEqual(DEFAULT_PROVENANCE)
  })

  it('resolves the global level itself, where an override is a global row', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, [{ scope: GLOBAL_SCOPE, stored: row(750) }])

    expect(resolved.value).toBe(750)
    expect(resolved.overridden).toBe(true)
    expect(resolved.inherited).toBe(0)
    expect(resolved.inheritedFrom).toEqual(DEFAULT_PROVENANCE)
  })

  it('accepts a repaired value, because a clamp is not a rejection', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row(99_999), row(2000)))

    expect(resolved.value).toBe(12_000)
    expect(resolved.overridden).toBe(true)
    expect(resolved.notices).toEqual([])
  })
})

describe('a level this build cannot read', () => {
  it('falls through to the next level rather than to the default', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row('nonsense'), row(2000)))

    // The global row is perfectly good and one level down. Resetting to shipped
    // gapless while it sat there unread would be the bug.
    expect(resolved.value).toBe(2000)
    expect(resolved.provenance).toEqual(storedProvenance(GLOBAL_SCOPE))
    expect(resolved.overridden).toBe(false)
    expect(resolved.notices).toHaveLength(1)
    expect(resolved.notices[0]).toMatchObject({ key: 'audio.crossfadeMs', rejected: 'nonsense' })
    expect(resolved.notices[0].reason).toContain('playlist:7')
  })

  it('lets a good override survive a damaged global row', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row(500), row(false)))

    expect(resolved.value).toBe(500)
    expect(resolved.overridden).toBe(true)
    // Reverting the override lands on the default, not on the row it cannot read.
    expect(resolved.inherited).toBe(0)
    expect(resolved.inheritedFrom).toEqual(DEFAULT_PROVENANCE)
    expect(resolved.notices[0].reason).toContain('global')
  })

  it('falls through a row written by a newer build without rewriting it', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row(500, 9), row(2000)))

    expect(resolved.value).toBe(2000)
    expect(resolved.overridden).toBe(false)
    expect(resolved.notices[0].reason).toContain('newer than this build')
  })

  it('reports one notice per unreadable level', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, layers(row([]), row('also nonsense')))

    expect(resolved.value).toBe(0)
    expect(resolved.provenance).toEqual(DEFAULT_PROVENANCE)
    expect(resolved.notices).toHaveLength(2)
  })
})

describe('upgrading a stored override', () => {
  const versioned = defineSetting({
    key: 'audio.example',
    scope: 'durable',
    default: 100,
    version: 2,
    // v1 held seconds; v2 holds milliseconds.
    upgrade: (value) => (typeof value === 'number' ? value * 1000 : value),
    validate: integerValue({ min: 0, max: 10_000 }),
    cascade: ['playlist'],
    control: { kind: 'number' },
    category: 'audio',
    label: 'Example',
    help: '',
    order: 900
  })

  it('runs the upgrade chain per level before comparing them', () => {
    const resolved = resolveCascade(versioned, [
      { scope: PLAYLIST, stored: row(2, 1) },
      { scope: GLOBAL_SCOPE, stored: row(9000, 2) }
    ])

    expect(resolved.value).toBe(2000)
    expect(resolved.overridden).toBe(true)
    expect(resolved.inherited).toBe(9000)
  })
})

describe('scopes a key does not accept', () => {
  const global = defineSetting<string>({
    key: 'interface.example',
    scope: 'durable',
    default: 'dark',
    validate: stringValue(),
    control: { kind: 'toggle' },
    category: 'interface',
    label: 'Example',
    help: '',
    order: 900
  })

  it('refuses an entity scope on a key that declares no cascade', () => {
    expect(() => assertCascadeScope(global, PLAYLIST)).toThrow(/cannot be overridden per playlist/)
  })

  it('refuses an entity kind outside the key’s cascade', () => {
    expect(() => assertCascadeScope(AUDIO_CROSSFADE_MS, { kind: 'track', id: 1 })).toThrow(
      /cannot be overridden per track/
    )
  })

  it('refuses an entity scope without a usable id', () => {
    expect(() => assertCascadeScope(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: null })).toThrow(
      /positive id/
    )
    expect(() => assertCascadeScope(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: 0 })).toThrow(
      /positive id/
    )
  })

  it('refuses a global scope carrying an id', () => {
    expect(() => assertCascadeScope(AUDIO_CROSSFADE_MS, { kind: 'global', id: 4 })).toThrow(/no id/)
  })

  /**
   * The card asks for a *type* error, not a runtime one. The runtime checks
   * above are for callers the registry has erased; this is the check for one
   * holding the descriptor itself, and it is verified by `npm run typecheck`
   * rather than at runtime — a `@ts-expect-error` that stops being an error is
   * a failed build.
   */
  it('refuses a non-cascading entity kind at compile time', () => {
    expect(() =>
      // @ts-expect-error 'track' is not among this key's cascade kinds
      cascadeLayers(AUDIO_CROSSFADE_MS, { kind: 'track', id: 1 }, () => null)
    ).toThrow(/cannot be overridden per track/)
  })
})

describe('layer order', () => {
  const lookup = (scope: SettingScopeRef): StoredSetting | null =>
    scope.kind === 'playlist' ? row(500) : row(2000)

  it('builds most-specific-first with global last', () => {
    const built = cascadeLayers(AUDIO_CROSSFADE_MS, PLAYLIST, lookup)

    expect(built.map((layer) => layer.scope.kind)).toEqual(['playlist', 'global'])
    expect(resolveCascade(AUDIO_CROSSFADE_MS, built).value).toBe(500)
  })

  it('builds a single layer when asked at the global scope', () => {
    const built = cascadeLayers(AUDIO_CROSSFADE_MS, GLOBAL_SCOPE, lookup)

    expect(built).toHaveLength(1)
    expect(resolveCascade(AUDIO_CROSSFADE_MS, built).value).toBe(2000)
  })

  it('refuses a list with the global layer anywhere but last', () => {
    expect(() =>
      resolveCascade(AUDIO_CROSSFADE_MS, [
        { scope: GLOBAL_SCOPE, stored: row(2000) },
        { scope: PLAYLIST, stored: row(500) }
      ])
    ).toThrow(/least specific/)
  })

  it('refuses a repeated scope', () => {
    expect(() =>
      resolveCascade(AUDIO_CROSSFADE_MS, [
        { scope: PLAYLIST, stored: row(500) },
        { scope: PLAYLIST, stored: row(600) },
        { scope: GLOBAL_SCOPE, stored: null }
      ])
    ).toThrow(/twice/)
  })

  it('refuses an empty list', () => {
    expect(() => resolveCascade(AUDIO_CROSSFADE_MS, [])).toThrow(/at least one layer/)
  })

  /**
   * More than one entity layer is not what the card's three levels describe, but
   * the walk is written over a list rather than over two named slots so that the
   * album-inside-a-playlist question can be answered later by ordering the list
   * rather than by rewriting this.
   */
  it('walks more than two levels, most specific first', () => {
    const resolved = resolveCascade(AUDIO_CROSSFADE_MS, [
      { scope: ALBUM, stored: null },
      { scope: PLAYLIST, stored: row(500) },
      { scope: GLOBAL_SCOPE, stored: row(2000) }
    ])

    expect(resolved.value).toBe(500)
    expect(resolved.overridden).toBe(false)
    expect(resolved.inherited).toBe(500)
  })
})

describe('provenance', () => {
  it('compares by level and scope', () => {
    expect(sameProvenance(DEFAULT_PROVENANCE, DEFAULT_PROVENANCE)).toBe(true)
    expect(sameProvenance(storedProvenance(PLAYLIST), storedProvenance(PLAYLIST))).toBe(true)
    expect(sameProvenance(storedProvenance(PLAYLIST), storedProvenance(ALBUM))).toBe(false)
    expect(sameProvenance(storedProvenance(GLOBAL_SCOPE), DEFAULT_PROVENANCE)).toBe(false)
  })

  it('names a level without naming the entity', () => {
    expect(provenanceLabel(DEFAULT_PROVENANCE)).toBe('the built-in default')
    expect(provenanceLabel(storedProvenance(GLOBAL_SCOPE))).toBe('the global setting')
    expect(provenanceLabel(storedProvenance(PLAYLIST))).toBe('the playlist override')
  })
})
