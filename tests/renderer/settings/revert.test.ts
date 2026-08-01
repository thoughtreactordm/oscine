import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, watch } from 'vue'
import {
  AUDIO_CROSSFADE_MS,
  DEFAULT_PROVENANCE,
  GLOBAL_SCOPE,
  provenanceLabel
} from '../../../src/shared/settings'
import { settingsStoreFixture, storedValue } from './fixture'
import { VIEW_STORAGE_PREFIX } from '../../../src/renderer/settings/viewStore'

/**
 * W8-7: the delta, and the three ways of undoing it.
 *
 * The pair that makes "apply immediately with no Cancel" safe. Everything here
 * is about the two questions the surface has to be able to answer — *what have I
 * changed* and *put this back* — and about the one distinction the store is the
 * only layer that can draw: a row that exists is not the same as a value that
 * has moved, and the two come apart exactly where it matters.
 *
 * The catalog's half of the filter is proved in
 * `tests/renderer/panels/settingsCatalog.test.ts` against the pure function; the
 * cascade half of revert is proved in `cascade.test.ts`. What is left, and what
 * is here, is the store.
 */

const CROSSFADE = AUDIO_CROSSFADE_MS.key
const THEME = 'interface.theme'
/** A view key sharing Interface with `THEME`, so a sweep has both halves to hit. */
const GROUPING = 'view.trackGroupingEnabled'
const REPEAT = 'playback.repeat'
/** A row from a branch this build has never heard of. Nothing may delete it. */
const FOREIGN = 'audio.fromAnotherBranch'

const scopes: ReturnType<typeof effectScope>[] = []

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
})

function watched<T>(read: () => T): { seen: T[] } {
  const scope = effectScope()
  scopes.push(scope)
  const seen: T[] = []
  scope.run(() => watch(read, (next) => seen.push(next)))
  return { seen }
}

describe('the changed-from-default delta', () => {
  it('names a moved key in either scope, and nothing else', async () => {
    const { settings } = settingsStoreFixture({
      stored: { [CROSSFADE]: 3000 },
      seed: { [REPEAT]: 'all' }
    })
    await settings.ready

    const changed = new Set(settings.changedKeys.value)
    expect(changed.has(CROSSFADE)).toBe(true)
    expect(changed.has(REPEAT)).toBe(true)
    // Never written, and never written *to its default* either — the surface
    // holds the descriptor's value in both cases and neither is a change.
    expect(changed.has(THEME)).toBe(false)
    expect(changed.has(GROUPING)).toBe(false)
  })

  it('leaves out a stored key this build has no descriptor for', async () => {
    // It cannot be a row on the surface, so it cannot be part of the operator's
    // delta — and reporting a key nothing can render would send a bug report
    // chasing a knob that does not exist in this build.
    const { settings } = settingsStoreFixture({ stored: { [FOREIGN]: 5 } })
    await settings.ready

    expect(settings.changedKeys.value).not.toContain(FOREIGN)
  })

  it('moves as values move', async () => {
    const { settings } = settingsStoreFixture()
    await settings.ready

    const { seen } = watched(() => [...settings.changedKeys.value])

    await settings.set(CROSSFADE, 2000)
    expect(seen.at(-1)).toContain(CROSSFADE)

    await settings.reset(CROSSFADE)
    expect(seen.at(-1)).not.toContain(CROSSFADE)
  })

  /**
   * The case the two predicates exist for.
   *
   * A row holding exactly the default has changed nothing on screen, so it stays
   * out of the delta — but it is still the row that stops this key following the
   * default when a later build moves it, so there is something to revert and the
   * affordance has to be offered.
   */
  it('excludes a row that holds the default, while `isStored` still reports it', async () => {
    const { settings } = settingsStoreFixture({ stored: { [CROSSFADE]: 0 } })
    await settings.ready

    expect(settings.changedKeys.value).not.toContain(CROSSFADE)
    expect(settings.isStored(CROSSFADE)).toBe(true)
  })

  it('reports a view entry as stored, and forgets it once reverted', async () => {
    const { settings } = settingsStoreFixture({ seed: { [GROUPING]: false } })
    await settings.ready

    expect(settings.isStored(GROUPING)).toBe(true)
    await settings.reset(GROUPING)
    expect(settings.isStored(GROUPING)).toBe(false)
  })
})

describe('reverting one setting', () => {
  it('deletes a view entry rather than writing the default into it', async () => {
    // The whole reason revert is a delete: a later build that changes this
    // default has to reach a profile that never overrode it.
    const { settings, storage } = settingsStoreFixture({ seed: { [GROUPING]: false } })
    await settings.ready

    await settings.reset(GROUPING)

    expect(storage.read(VIEW_STORAGE_PREFIX + GROUPING)).toBeNull()
    expect(settings.get<boolean>(GROUPING)).toBe(true)
  })

  it('deletes a durable row that held exactly the default', async () => {
    const { settings, bridge } = settingsStoreFixture({ stored: { [CROSSFADE]: 0 } })
    await settings.ready

    await settings.reset(CROSSFADE)

    expect(bridge.rows.has(CROSSFADE)).toBe(false)
    expect(settings.isStored(CROSSFADE)).toBe(false)
  })

  /**
   * The card's "the distinction must be visible in the button's label".
   *
   * Reverting at the global scope restores the descriptor default; reverting at
   * an entity restores what it was inheriting. W8-5's provenance is what tells
   * them apart, and both phrases come out of the one function, so a control that
   * builds its label from `inheritedFrom` cannot say the wrong one.
   */
  it('names a different destination at an entity than at the global', async () => {
    const { settings, bridge } = settingsStoreFixture({ stored: { [CROSSFADE]: 2000 } })
    bridge.seedOverride({ kind: 'playlist', id: 7 }, CROSSFADE, 500)
    await settings.ready
    await settings.loadOverrides({ kind: 'playlist', id: 7 })

    const atEntity = settings.cascade(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: 7 })
    const atGlobal = settings.cascade(AUDIO_CROSSFADE_MS, GLOBAL_SCOPE)

    expect(provenanceLabel(atEntity.inheritedFrom)).toBe('the global setting')
    expect(provenanceLabel(atGlobal.inheritedFrom)).toBe('the built-in default')
    expect(provenanceLabel(DEFAULT_PROVENANCE)).toBe('the built-in default')
  })
})

describe('reverting a section', () => {
  it('sweeps both halves of the category and leaves the others alone', async () => {
    const { settings, storage, bridge } = settingsStoreFixture({
      stored: { [THEME]: 'dark', [CROSSFADE]: 3000 },
      seed: { [GROUPING]: false, [REPEAT]: 'all' }
    })
    await settings.ready

    await settings.resetCategory('interface')

    expect(bridge.rows.has(THEME)).toBe(false)
    expect(storage.read(VIEW_STORAGE_PREFIX + GROUPING)).toBeNull()
    expect(settings.get<string>(THEME)).toBe('system')
    expect(settings.get<boolean>(GROUPING)).toBe(true)

    // Audio and Playback were not asked about and did not move.
    expect(bridge.rows.get(CROSSFADE)).toBe(3000)
    expect(storedValue(storage, REPEAT)).toBe('all')
  })

  it('asks main once for the whole category rather than once per key', async () => {
    // N round trips and N broadcasts for one operator action would be the cost
    // of a loop here, and main already takes a category.
    const { settings, bridge } = settingsStoreFixture({ stored: { [THEME]: 'dark' } })
    await settings.ready

    await settings.resetCategory('interface')

    expect(bridge.calls.reset).toEqual([{ category: 'interface', scope: GLOBAL_SCOPE }])
  })

  it('refuses a category the rail does not have', async () => {
    const { settings } = settingsStoreFixture()
    await settings.ready

    expect(() => settings.resetCategory('nowhere' as never)).toThrow(RangeError)
  })
})

describe('resetting everything', () => {
  it('clears every stored value in both halves', async () => {
    const { settings, storage, bridge } = settingsStoreFixture({
      stored: { [THEME]: 'dark', [CROSSFADE]: 3000 },
      seed: { [GROUPING]: false, [REPEAT]: 'all' }
    })
    await settings.ready

    await settings.resetAll()

    expect(bridge.rows.size).toBe(0)
    expect(storage.read(VIEW_STORAGE_PREFIX + GROUPING)).toBeNull()
    expect(storage.read(VIEW_STORAGE_PREFIX + REPEAT)).toBeNull()
    expect(settings.changedKeys.value).toEqual([])
  })

  it('preserves what it has no descriptor for, in both halves', async () => {
    // "Reset everything" must not be a way to lose a neighbouring branch's
    // settings — the same preservation rule a load follows.
    const { settings, storage, bridge } = settingsStoreFixture({
      stored: { [FOREIGN]: 5 },
      seed: { [GROUPING]: false }
    })
    storage.write(`${VIEW_STORAGE_PREFIX}view.fromAnotherBranch`, JSON.stringify({ value: 9 }))
    await settings.ready

    await settings.resetAll()

    expect(bridge.rows.get(FOREIGN)).toBe(5)
    expect(storage.read(`${VIEW_STORAGE_PREFIX}view.fromAnotherBranch`)).not.toBeNull()
  })

  it('is one request, not one per key', async () => {
    const { settings, bridge } = settingsStoreFixture({ stored: { [THEME]: 'dark' } })
    await settings.ready

    await settings.resetAll()

    expect(bridge.calls.reset).toEqual([{ scope: GLOBAL_SCOPE }])
  })
})
