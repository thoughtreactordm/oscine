import { afterEach, describe, expect, it } from 'vitest'
import { computed, effectScope, watch } from 'vue'
import { AUDIO_CROSSFADE_MS, GLOBAL_SCOPE } from '../../../src/shared/settings'
import {
  createSettingsStore,
  type SettingsStore
} from '../../../src/renderer/settings/settingsStore'
import { durableBridgeFixture, viewSettingsFixture, type DurableBridgeOptions } from './fixture'

/**
 * The renderer's half of W8-5.
 *
 * The resolution itself is proved in `tests/shared/cascade.test.ts` against the
 * pure function. What is under test here is everything around it: that override
 * rows arrive, that a change to the *global* re-resolves every entity inheriting
 * it without another round trip, and that a broadcast which drops an override is
 * told apart from one that sets it to the same value.
 */

const KEY = AUDIO_CROSSFADE_MS.key
const PLAYLIST = { kind: 'playlist', id: 7 } as const
const OTHER = { kind: 'playlist', id: 8 } as const

interface Harness {
  store: SettingsStore
  bridge: ReturnType<typeof durableBridgeFixture>
}

function harness(options: DurableBridgeOptions & { debounceMs?: number } = {}): Harness {
  const { debounceMs = 0, ...bridgeOptions } = options
  const bridge = durableBridgeFixture(bridgeOptions)
  const view = viewSettingsFixture()
  const store = createSettingsStore({ durable: bridge, view: view.settings, debounceMs })
  return { store, bridge }
}

const scopes: ReturnType<typeof effectScope>[] = []

afterEach(() => {
  while (scopes.length > 0) scopes.pop()?.stop()
})

/** A reactive read, as a control binding one would make. */
function tracked(store: SettingsStore, scope: typeof PLAYLIST | typeof GLOBAL_SCOPE) {
  const scoped = effectScope()
  scopes.push(scoped)
  const seen: number[] = []
  const cascade = scoped.run(() => {
    const c = computed(() => store.cascade(AUDIO_CROSSFADE_MS, scope))
    watch(
      () => c.value.value,
      (next) => seen.push(next)
    )
    return c
  })
  return { cascade: cascade as NonNullable<typeof cascade>, seen }
}

describe('reading a cascade', () => {
  it('reports what the entity inherits until its overrides have loaded', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    bridge.seedOverride(PLAYLIST, KEY, 500)
    await store.ready

    // Nothing has asked main for this playlist's rows yet, so the honest answer
    // is what it would inherit — and nothing writes that anywhere.
    expect(store.overridesLoaded(PLAYLIST)).toBe(false)
    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST)).toMatchObject({
      value: 2000,
      overridden: false
    })

    await store.loadOverrides(PLAYLIST)

    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST)).toMatchObject({
      value: 500,
      overridden: true,
      inherited: 2000,
      provenance: { level: 'stored', scope: PLAYLIST }
    })
  })

  it('fetches one scope once, however many callers ask', async () => {
    const { store, bridge } = harness()
    await store.ready

    await Promise.all([
      store.loadOverrides(PLAYLIST),
      store.loadOverrides(PLAYLIST),
      store.loadOverrides(OTHER)
    ])
    await store.loadOverrides(PLAYLIST)

    expect(bridge.calls.getOverrides).toEqual([PLAYLIST, OTHER])
  })

  /**
   * The reason resolution lives in the renderer rather than in main. An entity
   * that inherits has no row of its own to be told about, so a resolved value
   * pushed from main would simply be stale.
   */
  it('re-resolves an inheriting entity when the global moves, without a round trip', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    await store.ready
    await store.loadOverrides(PLAYLIST)
    const before = bridge.calls.getOverrides.length

    const watcher = tracked(store, PLAYLIST)
    await store.set(KEY, 4000)

    expect(watcher.seen).toEqual([4000])
    expect(watcher.cascade.value).toMatchObject({ value: 4000, overridden: false })
    expect(bridge.calls.getOverrides).toHaveLength(before)
  })

  it('leaves an overriding entity alone when the global moves', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    bridge.seedOverride(PLAYLIST, KEY, 500)
    await store.ready
    await store.loadOverrides(PLAYLIST)

    const watcher = tracked(store, PLAYLIST)
    await store.set(KEY, 4000)

    expect(watcher.seen).toEqual([])
    expect(watcher.cascade.value).toMatchObject({
      value: 500,
      overridden: true,
      // What reverting would now restore — which did move.
      inherited: 4000
    })
  })

  it('tells a global row from the shipped default', async () => {
    const { store } = harness()
    await store.ready

    expect(store.cascade(AUDIO_CROSSFADE_MS, GLOBAL_SCOPE)).toMatchObject({
      value: 0,
      overridden: false,
      provenance: { level: 'default' }
    })

    // Set to exactly the default: the value cannot say, so the row has to.
    await store.set(KEY, 0)
    expect(store.cascade(AUDIO_CROSSFADE_MS, GLOBAL_SCOPE)).toMatchObject({
      overridden: true,
      provenance: { level: 'stored', scope: { kind: 'global' } }
    })

    await store.reset(KEY)
    expect(store.cascade(AUDIO_CROSSFADE_MS, GLOBAL_SCOPE).overridden).toBe(false)
  })

  it('refuses a key that does not cascade to the scope asked about', async () => {
    const { store } = harness()
    await store.ready

    expect(() =>
      // @ts-expect-error audio.crossfadeMs cascades to album and playlist only
      store.cascade(AUDIO_CROSSFADE_MS, { kind: 'track', id: 1 })
    ).toThrow(/cannot be overridden per track/)
  })
})

describe('writing an override', () => {
  it('lands in the surface before it lands in main', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 }, debounceMs: 5000 })
    await store.ready
    await store.loadOverrides(PLAYLIST)

    const settled = store.setOverride(AUDIO_CROSSFADE_MS, PLAYLIST, 500)
    // Visible immediately; the write behind it is still sitting in the debounce.
    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST)).toMatchObject({
      value: 500,
      overridden: true
    })
    expect(bridge.calls.set).toEqual([])

    await store.flush()
    await settled
    expect(bridge.calls.set).toEqual([{ key: KEY, value: 500, scope: PLAYLIST }])
    expect(bridge.overrides.get('playlist:7')?.get(KEY)).toBe(500)
  })

  it('keeps the global and an override as independent writes', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    await store.ready
    await store.loadOverrides(PLAYLIST)

    await Promise.all([store.set(KEY, 4000), store.setOverride(AUDIO_CROSSFADE_MS, PLAYLIST, 500)])

    // Two rows, two writes. Keying the queue by key alone would have coalesced
    // them and silently dropped one.
    expect(bridge.calls.set).toHaveLength(2)
    expect(store.get<number>(KEY)).toBe(4000)
    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST).value).toBe(500)
  })

  it('reconciles to the value main actually stored', async () => {
    const { store } = harness({ stored: { [KEY]: 2000 }, repair: () => 750 })
    await store.ready
    await store.loadOverrides(PLAYLIST)

    await store.setOverride(AUDIO_CROSSFADE_MS, PLAYLIST, 500)

    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST).value).toBe(750)
  })

  it('rolls back to inheriting when main refuses the write', async () => {
    const { store } = harness({
      stored: { [KEY]: 2000 },
      refuse: (request) => (request.scope?.kind === 'playlist' ? 'nope' : null)
    })
    await store.ready
    await store.loadOverrides(PLAYLIST)

    const result = await store.setOverride(AUDIO_CROSSFADE_MS, PLAYLIST, 500)

    expect(result.ok).toBe(false)
    // There was no override before the refused write, so there is none after it.
    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST)).toMatchObject({
      value: 2000,
      overridden: false
    })
  })

  it('refuses locally what a validator would refuse in main', async () => {
    const { store, bridge } = harness()
    await store.ready
    await store.loadOverrides(PLAYLIST)

    const result = await store.setOverride(AUDIO_CROSSFADE_MS, PLAYLIST, 'loud' as never)

    expect(result.ok).toBe(false)
    expect(bridge.calls.set).toEqual([])
  })
})

describe('reverting an override', () => {
  it('restores what the entity inherits', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    bridge.seedOverride(PLAYLIST, KEY, 500)
    await store.ready
    await store.loadOverrides(PLAYLIST)

    await store.clearOverride(AUDIO_CROSSFADE_MS, PLAYLIST)

    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST)).toMatchObject({
      value: 2000,
      overridden: false,
      provenance: { level: 'stored', scope: { kind: 'global' } }
    })
    expect(bridge.overrides.get('playlist:7')?.has(KEY)).toBe(false)
    // The global row it fell back to is untouched.
    expect(bridge.rows.get(KEY)).toBe(2000)
  })

  it('reverts an override that equalled its inherited value', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    bridge.seedOverride(PLAYLIST, KEY, 2000)
    await store.ready
    await store.loadOverrides(PLAYLIST)

    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST).overridden).toBe(true)
    await store.clearOverride(AUDIO_CROSSFADE_MS, PLAYLIST)
    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST).overridden).toBe(false)
  })
})

describe('another window’s change', () => {
  it('applies an override to a scope this window is watching', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    await store.ready
    await store.loadOverrides(PLAYLIST)

    bridge.announce([{ key: KEY, scope: PLAYLIST, value: 6000, cleared: false }])

    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST)).toMatchObject({
      value: 6000,
      overridden: true
    })
  })

  /**
   * The pair `cleared` exists for. Both announcements carry 2000 and mean
   * opposite things; without the flag the second would look like "set to 2000"
   * and the override would come back from the dead every time it was reverted.
   */
  it('tells a cleared override from one set to the inherited value', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    await store.ready
    await store.loadOverrides(PLAYLIST)

    bridge.announce([{ key: KEY, scope: PLAYLIST, value: 2000, cleared: false }])
    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST).overridden).toBe(true)

    bridge.announce([{ key: KEY, scope: PLAYLIST, value: 2000, cleared: true }])
    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST).overridden).toBe(false)
  })

  it('ignores a scope this window has never loaded', async () => {
    const { store, bridge } = harness({ stored: { [KEY]: 2000 } })
    await store.ready

    // Caching it would leave `playlist:8` looking populated, and the later
    // `loadOverrides` would trust that and never ask.
    bridge.announce([{ key: KEY, scope: OTHER, value: 6000, cleared: false }])
    expect(store.cascade(AUDIO_CROSSFADE_MS, OTHER).overridden).toBe(false)

    bridge.seedOverride(OTHER, KEY, 750)
    await store.loadOverrides(OTHER)
    expect(store.cascade(AUDIO_CROSSFADE_MS, OTHER).value).toBe(750)
  })

  it('does not overtake a local write with an in-flight fetch', async () => {
    const { store, bridge } = harness()
    bridge.seedOverride(PLAYLIST, KEY, 500)
    await store.ready

    // The fetch is asked for first and answered later; the write happens in
    // between and is the newer fact.
    const loading = store.loadOverrides(PLAYLIST)
    const written = store.setOverride(AUDIO_CROSSFADE_MS, PLAYLIST, 3000)
    await Promise.all([loading, written])

    expect(store.cascade(AUDIO_CROSSFADE_MS, PLAYLIST).value).toBe(3000)
  })
})
