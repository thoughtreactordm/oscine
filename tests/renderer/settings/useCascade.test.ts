import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { AUDIO_CROSSFADE_MS } from '../../../src/shared/settings'
import { useCascade, type CascadeBinding } from '../../../src/renderer/settings/useCascade'
import { settingsStoreFixture } from './fixture'

/**
 * The card's UI contract, driven through the binding a control would use.
 *
 * Three states, and the one that matters is the third: an override holding the
 * value it would have inherited anyway is still an override. A control that
 * decided by comparing the two would discard the operator's explicit choice at
 * the moment it starts to matter — when the global moves.
 */

const KEY = AUDIO_CROSSFADE_MS.key
const PLAYLIST = { kind: 'playlist', id: 7 } as const
const OTHER = { kind: 'playlist', id: 8 } as const

const scopes: ReturnType<typeof effectScope>[] = []

afterEach(() => {
  while (scopes.length > 0) scopes.pop()?.stop()
})

/** The composable inside a scope, so its watcher runs and is cleaned up. */
function bound(
  settings: Parameters<typeof useCascade>[0],
  scope: Parameters<typeof useCascade<number, typeof AUDIO_CROSSFADE_MS.cascade>>[2]
): CascadeBinding<number> {
  const scoped = effectScope()
  scopes.push(scoped)
  return scoped.run(() => useCascade(settings, AUDIO_CROSSFADE_MS, scope)) as CascadeBinding<number>
}

async function fixture(globalMs: number, overrideMs?: number) {
  const store = settingsStoreFixture({ stored: { [KEY]: globalMs } })
  if (overrideMs !== undefined) store.bridge.seedOverride(PLAYLIST, KEY, overrideMs)
  await store.settings.ready
  return store
}

describe('the three states', () => {
  it('inheriting: no row here, and the source is named', async () => {
    const store = await fixture(2000)
    const binding = bound(store.settings, PLAYLIST)
    await store.settings.loadOverrides(PLAYLIST)

    expect(binding.overridden.value).toBe(false)
    expect(binding.value.value).toBe(2000)
    expect(binding.inherited.value).toBe(2000)
    expect(binding.inheritedFrom.value).toBe('the global setting')
  })

  it('inheriting from the shipped default when nothing is stored at all', async () => {
    const store = settingsStoreFixture()
    await store.settings.ready
    const binding = bound(store.settings, PLAYLIST)
    await store.settings.loadOverrides(PLAYLIST)

    expect(binding.overridden.value).toBe(false)
    expect(binding.inheritedFrom.value).toBe('the built-in default')
  })

  it('overridden here: the local value, and something to revert to', async () => {
    const store = await fixture(2000, 500)
    const binding = bound(store.settings, PLAYLIST)
    await store.settings.loadOverrides(PLAYLIST)

    expect(binding.overridden.value).toBe(true)
    expect(binding.value.value).toBe(500)
    expect(binding.inherited.value).toBe(2000)
    expect(binding.inheritedFrom.value).toBe('the global setting')
  })

  it('set here and equal to inherited: still an override', async () => {
    const store = await fixture(2000, 2000)
    const binding = bound(store.settings, PLAYLIST)
    await store.settings.loadOverrides(PLAYLIST)

    // Indistinguishable from "inheriting" by value, and it must not be drawn
    // that way — the point of the row is to survive a change to the global.
    expect(binding.value.value).toBe(binding.inherited.value)
    expect(binding.overridden.value).toBe(true)

    await store.settings.set(KEY, 4000)
    expect(binding.value.value).toBe(2000)
    expect(binding.inherited.value).toBe(4000)
  })
})

describe('binding it to a control', () => {
  it('writes an override when the control assigns', async () => {
    const store = await fixture(2000)
    const binding = bound(store.settings, PLAYLIST)
    await store.settings.loadOverrides(PLAYLIST)

    binding.value.value = 750
    await store.settings.flush()

    expect(binding.overridden.value).toBe(true)
    expect(store.bridge.overrides.get('playlist:7')?.get(KEY)).toBe(750)
    // The global it was inheriting from is untouched.
    expect(store.bridge.rows.get(KEY)).toBe(2000)
  })

  it('reverts to inheriting', async () => {
    const store = await fixture(2000, 500)
    const binding = bound(store.settings, PLAYLIST)
    await store.settings.loadOverrides(PLAYLIST)

    await binding.revert()

    expect(binding.overridden.value).toBe(false)
    expect(binding.value.value).toBe(2000)
  })

  it('reports what it inherits before the rows arrive, and corrects itself', async () => {
    const store = await fixture(2000, 500)
    const binding = bound(store.settings, PLAYLIST)

    // Rendered on the first frame rather than blocked on a round trip.
    expect(binding.loaded.value).toBe(false)
    expect(binding.value.value).toBe(2000)
    expect(binding.overridden.value).toBe(false)

    await store.settings.loadOverrides(PLAYLIST)

    expect(binding.loaded.value).toBe(true)
    expect(binding.value.value).toBe(500)
    expect(binding.overridden.value).toBe(true)
  })

  it('fetches the scope without being asked to', async () => {
    const store = await fixture(2000, 500)
    bound(store.settings, PLAYLIST)
    await nextTick()

    // The watcher is immediate, so a control never has to remember to load.
    expect(store.bridge.calls.getOverrides).toEqual([PLAYLIST])
  })

  it('follows a scope that changes under it', async () => {
    const store = await fixture(2000, 500)
    store.bridge.seedOverride(OTHER, KEY, 6000)
    await store.settings.ready

    const scope = ref<typeof PLAYLIST | typeof OTHER>(PLAYLIST)
    const binding = bound(store.settings, () => scope.value)
    await store.settings.loadOverrides(PLAYLIST)
    expect(binding.value.value).toBe(500)

    scope.value = OTHER
    await nextTick()
    await store.settings.loadOverrides(OTHER)

    expect(binding.value.value).toBe(6000)
    expect(store.bridge.calls.getOverrides).toEqual([PLAYLIST, OTHER])
  })
})
