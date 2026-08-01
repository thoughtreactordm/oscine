import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, watch } from 'vue'
import {
  AUDIO_CROSSFADE_MS_KEY,
  defineSetting,
  integerValue,
  type SettingDescriptor
} from '../../../src/shared/settings'
import {
  createSettingsStore,
  type SettingsStore,
  type SettingsStoreDeps
} from '../../../src/renderer/settings/settingsStore'
import { createViewSettings } from '../../../src/renderer/settings/viewStore'
import { durableBridgeFixture, viewSettingsFixture, type DurableBridgeOptions } from './fixture'

/**
 * The reactive surface, and the loop that must not oscillate.
 *
 * Everything here drives the real store against a faked main, because the
 * property W8-4 claims is about *this* half: that a value is visible before it
 * is persisted, that main's answer is what finally stands, and that main
 * announcing a change the renderer itself made settles rather than starting the
 * volley again.
 */

const CROSSFADE = AUDIO_CROSSFADE_MS_KEY
const REPEAT = 'playback.repeat'

interface Harness {
  store: SettingsStore
  bridge: ReturnType<typeof durableBridgeFixture>
  view: ReturnType<typeof viewSettingsFixture>
}

function harness(
  options: DurableBridgeOptions &
    Partial<Pick<SettingsStoreDeps, 'debounceMs' | 'descriptors'>> = {}
): Harness {
  const { debounceMs = 0, descriptors, ...bridgeOptions } = options
  const bridge = durableBridgeFixture({ ...bridgeOptions, descriptors })
  const view = viewSettingsFixture()
  const store = createSettingsStore({
    durable: bridge,
    view: view.settings,
    debounceMs,
    ...(descriptors ? { descriptors } : {})
  })
  return { store, bridge, view }
}

/** Vue only recomputes a watcher inside a scope; disposed after each test. */
const scopes: ReturnType<typeof effectScope>[] = []

function watched<T>(read: () => T): { seen: T[] } {
  const scope = effectScope()
  scopes.push(scope)
  const seen: T[] = []
  scope.run(() => watch(read, (next) => seen.push(next)))
  return { seen }
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
})

describe('settings store', () => {
  describe('hydration', () => {
    it('reads defaults until main answers, then main', async () => {
      const { store, bridge } = harness({ stored: { [CROSSFADE]: 2000 }, deferGetAll: true })

      expect(store.hydrated.value).toBe(false)
      // Not a placeholder: the descriptor default is the honest answer to "what
      // is the crossfade" before anything better has arrived.
      expect(store.get<number>(CROSSFADE)).toBe(0)

      bridge.answerGetAll()
      await store.ready

      expect(store.hydrated.value).toBe(true)
      expect(store.get<number>(CROSSFADE)).toBe(2000)
    })

    it('carries what did not survive the load in main', async () => {
      const notice = { key: CROSSFADE, reason: 'stored value was a string', rejected: 'lots' }
      const { store } = harness({ notices: [notice] })
      await store.ready
      expect(store.notices.value).toContainEqual(notice)
    })

    it('keeps a write that raced the hydration', async () => {
      const { store, bridge } = harness({ stored: { [CROSSFADE]: 2000 }, deferGetAll: true })

      // The operator moved the slider before the first `getAll` came back. The
      // answer to a question asked before that is not newer than the answer.
      const written = store.set(CROSSFADE, 750)
      bridge.answerGetAll()
      await store.ready
      await written

      expect(store.get<number>(CROSSFADE)).toBe(750)
    })

    it('paints defaults and says why when main cannot be reached', async () => {
      const bridge = durableBridgeFixture()
      bridge.getAll = () => Promise.reject(new Error('no such channel'))
      const store = createSettingsStore({
        durable: bridge,
        view: viewSettingsFixture().settings,
        debounceMs: 0
      })

      await store.ready
      expect(store.hydrated.value).toBe(true)
      expect(store.get<number>(CROSSFADE)).toBe(0)
      expect(store.notices.value.at(-1)?.reason).toContain('no such channel')
    })
  })

  describe('writes', () => {
    it('propagates before it persists', async () => {
      const { store, bridge } = harness({ debounceMs: 50 })
      await store.ready

      const seen = watched(() => store.get<number>(CROSSFADE))
      const written = store.set(CROSSFADE, 3000)

      // Visible to every consumer with nothing awaited, and not yet on its way
      // to main. That gap is the point of the card.
      expect(store.get<number>(CROSSFADE)).toBe(3000)
      expect(bridge.calls.set).toHaveLength(0)

      await store.flush()
      await written
      expect(bridge.calls.set).toHaveLength(1)
      await Promise.resolve()
      expect(seen.seen).toEqual([3000])
    })

    it('reconciles to what main actually stored', async () => {
      // A validated pair (W8-9) or a main whose descriptor has moved on: the
      // response is the authority, not the value the renderer sent.
      const { store } = harness({ repair: () => 500 })
      await store.ready

      const result = await store.set(CROSSFADE, 3000)
      expect(result).toEqual({ ok: true, value: 500 })
      expect(store.get<number>(CROSSFADE)).toBe(500)
    })

    it('repairs locally so the control does not snap back later', async () => {
      const { store, bridge } = harness()
      await store.ready

      // Clamped by the descriptor's own validator, before the round trip.
      const result = await store.set(CROSSFADE, 40_000)
      expect(result).toEqual({ ok: true, value: 12_000 })
      expect(bridge.calls.set[0]?.value).toBe(12_000)
    })

    it('rolls back and reports when main refuses', async () => {
      const { store } = harness({
        stored: { [CROSSFADE]: 2000 },
        refuse: () => 'the library is read-only'
      })
      await store.ready

      const result = await store.set(CROSSFADE, 4000)

      expect(result.ok).toBe(false)
      // The optimistic value never happened, so it does not get to stay on
      // screen looking like it did.
      expect(store.get<number>(CROSSFADE)).toBe(2000)
      expect(store.notices.value.at(-1)?.reason).toContain('read-only')
    })

    it('refuses an invalid value without asking main', async () => {
      const { store, bridge } = harness()
      await store.ready

      const result = await store.set(CROSSFADE, 'loud')

      expect(result).toEqual({ ok: false, reason: 'expected an integer' })
      expect(bridge.calls.set).toHaveLength(0)
      expect(store.get<number>(CROSSFADE)).toBe(0)
      expect(store.notices.value.at(-1)?.key).toBe(CROSSFADE)
    })

    it('rejects a key no descriptor claims', async () => {
      const { store } = harness()
      await store.ready
      expect(() => store.get('audio.imaginary')).toThrow(RangeError)
    })
  })

  describe('debounce', () => {
    it('coalesces a drag into one write', async () => {
      vi.useFakeTimers()
      const { store, bridge } = harness({ debounceMs: 50 })
      await store.ready

      for (const milliseconds of [250, 500, 750, 1000]) store.set(CROSSFADE, milliseconds)
      expect(bridge.calls.set).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(50)

      expect(bridge.calls.set).toHaveLength(1)
      expect(bridge.calls.set[0]?.value).toBe(1000)
      // Propagation was never debounced — only the write was.
      expect(store.get<number>(CROSSFADE)).toBe(1000)
    })

    it('flush writes what the debounce is still holding', async () => {
      const { store, bridge } = harness({ debounceMs: 5000 })
      await store.ready

      const written = store.set(CROSSFADE, 1500)
      await store.flush()
      await written

      expect(bridge.calls.set).toHaveLength(1)
      expect(bridge.rows.get(CROSSFADE)).toBe(1500)
    })
  })

  describe('broadcast', () => {
    it('lands without a poll', async () => {
      const { store, bridge } = harness()
      await store.ready

      const seen = watched(() => store.get<number>(CROSSFADE))
      bridge.announce([{ key: CROSSFADE, scope: { kind: 'global', id: null }, value: 4000 }])
      await Promise.resolve()

      expect(store.get<number>(CROSSFADE)).toBe(4000)
      expect(seen.seen).toEqual([4000])
    })

    /** The obvious bug, and the reason the card says to test it explicitly. */
    it('settles rather than echoing back out', async () => {
      const { store, bridge } = harness()
      await store.ready

      await store.set(CROSSFADE, 2500)
      expect(bridge.calls.set).toHaveLength(1)

      // Main announces to every window including the one that asked. A store
      // that treated an incoming change as a change *of its own* would write
      // again here, and the two would volley for as long as anyone watched.
      bridge.announce([{ key: CROSSFADE, scope: { kind: 'global', id: null }, value: 2500 }])
      await store.flush()

      expect(bridge.calls.set).toHaveLength(1)
      expect(store.get<number>(CROSSFADE)).toBe(2500)
    })

    it('lets a newer local write outrank the echo of an older one', async () => {
      const { store, bridge } = harness({ debounceMs: 5000 })
      await store.ready

      store.set(CROSSFADE, 800)
      bridge.announce([{ key: CROSSFADE, scope: { kind: 'global', id: null }, value: 200 }])

      expect(store.get<number>(CROSSFADE)).toBe(800)
    })

    it('leaves per-entity overrides to the cascade', async () => {
      const { store, bridge } = harness({ stored: { [CROSSFADE]: 1000 } })
      await store.ready

      // W8-5 owns resolution; this surface has one slot per key and it holds the
      // global value, so a playlist's override must not land in it.
      bridge.announce([{ key: CROSSFADE, scope: { kind: 'playlist', id: 7 }, value: 6000 }])

      expect(store.get<number>(CROSSFADE)).toBe(1000)
    })
  })

  describe('both scopes, one surface', () => {
    it('routes a view key to the view store and never to main', async () => {
      const { store, bridge, view } = harness()
      await store.ready

      await store.set(REPEAT, 'all')

      expect(store.get<string>(REPEAT)).toBe('all')
      expect(view.settings.get<string>(REPEAT)).toBe('all')
      expect(bridge.calls.set).toHaveLength(0)
    })

    it('follows the view store when something else writes it', async () => {
      const { store, view } = harness()
      await store.ready

      view.settings.set(REPEAT, 'one')

      expect(store.get<string>(REPEAT)).toBe('one')
    })

    it('reports the notices of both halves', async () => {
      const { store, view } = harness()
      await store.ready

      view.settings.set(REPEAT, 'sideways')

      expect(store.notices.value.at(-1)?.key).toBe(REPEAT)
    })

    it('resets a durable key by dropping its row', async () => {
      const { store, bridge } = harness({ stored: { [CROSSFADE]: 3000 } })
      await store.ready

      await store.reset(CROSSFADE)

      // Deleted rather than written as the default, so a later build that
      // changes the default reaches a profile that never overrode it.
      expect(bridge.rows.has(CROSSFADE)).toBe(false)
      expect(store.get<number>(CROSSFADE)).toBe(0)
    })
  })

  describe('requiresRestart', () => {
    const RESTART_KEY = 'audio.exclusiveMode'

    const descriptors: readonly SettingDescriptor[] = [
      defineSetting<number>({
        key: RESTART_KEY,
        scope: 'durable',
        default: 0,
        validate: integerValue({ min: 0, max: 2 }),
        control: { kind: 'number', min: 0, max: 2 },
        category: 'audio',
        label: 'Exclusive mode',
        help: 'Taken at device open.',
        order: 10,
        requiresRestart: true
      })
    ]

    function restartHarness() {
      const bridge = durableBridgeFixture({ descriptors, stored: { [RESTART_KEY]: 1 } })
      const store = createSettingsStore({
        durable: bridge,
        // The same descriptor list on both halves; this one holds no view keys.
        view: createViewSettings({ descriptors: [], debounceMs: 0 }),
        descriptors,
        debounceMs: 0
      })
      return { store, bridge }
    }

    it('badges a key that has moved since launch, from the flag alone', async () => {
      const { store } = restartHarness()
      await store.ready

      expect(store.restartRequired.value).toEqual([])

      await store.set(RESTART_KEY, 2)
      expect(store.restartRequired.value).toEqual([RESTART_KEY])

      // Put back what it launched with and the badge goes: the running process
      // is once again doing what the setting says.
      await store.set(RESTART_KEY, 1)
      expect(store.restartRequired.value).toEqual([])
    })

    it('stores it like any other key', async () => {
      const { store, bridge } = restartHarness()
      await store.ready

      await store.set(RESTART_KEY, 2)

      // The flag is presentation. It does not defer the write, and it does not
      // stage the value somewhere a restart would have to collect it from.
      expect(bridge.rows.get(RESTART_KEY)).toBe(2)
      expect(store.get<number>(RESTART_KEY)).toBe(2)
    })
  })
})
