import { describe, expect, it, vi } from 'vitest'
import { createEntityFavorites } from '../../../src/renderer/stores/entityFavorites'

/**
 * The shared star store — **D24**, the engine behind `usePlaylistFavorites` and
 * `useArtistFavorites`.
 *
 * Tested as the pure factory rather than through Pinia, following the renderer's
 * convention of exercising the logic (`createFavoritesWindow`, `describeIdentity`)
 * and not its store wrapper: the two stores differ only in which channels they
 * hand in, so proving the factory proves both.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A promise whose settlement the test controls, to catch the state mid-flight. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createEntityFavorites', () => {
  it('flips optimistically, then reconciles to the channel answer', async () => {
    const gate = deferred<{ favoritedIds: number[] }>()
    const toggle = vi.fn(() => gate.promise)
    const state = vi.fn(async () => ({ favoritedIds: [] as number[] }))
    const store = createEntityFavorites({ toggle, state })

    const done = store.toggle(5)

    // Painted before the round trip resolves — the point of an optimistic star.
    expect(store.isFavorite(5)).toBe(true)
    expect(store.isPending(5)).toBe(true)
    expect(toggle).toHaveBeenCalledWith(5)

    gate.resolve({ favoritedIds: [5] })
    await done

    expect(store.isFavorite(5)).toBe(true)
    expect(store.isPending(5)).toBe(false)
  })

  it('takes the channel answer even when it contradicts the optimistic guess', async () => {
    // Main is authoritative: a toggle that raced another writer comes back the
    // other way, and the star follows the answer rather than its own prediction.
    const toggle = vi.fn(async () => ({ favoritedIds: [] as number[] }))
    const state = vi.fn(async () => ({ favoritedIds: [] as number[] }))
    const store = createEntityFavorites({ toggle, state })

    await store.toggle(9)

    expect(store.isFavorite(9)).toBe(false)
  })

  it('reverts to the prior value when the toggle rejects', async () => {
    const state = vi.fn(async () => ({ favoritedIds: [7] }))
    const toggle = vi.fn(async () => {
      throw new Error('main said no')
    })
    const store = createEntityFavorites({ toggle, state })

    await store.hydrate([7])
    expect(store.isFavorite(7)).toBe(true)

    await store.toggle(7)

    // Optimistically emptied, then put back — a failed write costs the paint and
    // nothing else, and never throws into whatever rendered the star.
    expect(store.isFavorite(7)).toBe(true)
    expect(store.isPending(7)).toBe(false)
  })

  it('drops a second click while a toggle is in flight', async () => {
    const gate = deferred<{ favoritedIds: number[] }>()
    const toggle = vi.fn(() => gate.promise)
    const state = vi.fn(async () => ({ favoritedIds: [] as number[] }))
    const store = createEntityFavorites({ toggle, state })

    const first = store.toggle(3)
    await store.toggle(3) // returns at once, ignored

    expect(toggle).toHaveBeenCalledTimes(1)

    gate.resolve({ favoritedIds: [3] })
    await first
  })

  it('hydrates a list of ids from one batch read', async () => {
    const toggle = vi.fn(async () => ({ favoritedIds: [] as number[] }))
    const state = vi.fn(async () => ({ favoritedIds: [2] }))
    const store = createEntityFavorites({ toggle, state })

    await store.hydrate([1, 2, 3])

    expect(state).toHaveBeenCalledWith([1, 2, 3])
    expect(store.isFavorite(1)).toBe(false)
    expect(store.isFavorite(2)).toBe(true)
    expect(store.isFavorite(3)).toBe(false)
  })

  it('does not let a batch read clobber an id with a toggle in flight', async () => {
    const gate = deferred<{ favoritedIds: number[] }>()
    const toggle = vi.fn(() => gate.promise)
    const state = vi.fn(async () => ({ favoritedIds: [] as number[] }))
    const store = createEntityFavorites({ toggle, state })

    const clicking = store.toggle(2) // optimistic true, still pending
    await store.hydrate([1, 2]) // says 2 is not favorited — but it is being clicked

    expect(store.isFavorite(1)).toBe(false)
    expect(store.isFavorite(2)).toBe(true)

    gate.resolve({ favoritedIds: [2] })
    await clicking
    await flush()

    expect(store.isFavorite(2)).toBe(true)
  })

  it('is empty for ids nothing has hydrated or toggled', () => {
    const store = createEntityFavorites({
      toggle: vi.fn(async () => ({ favoritedIds: [] as number[] })),
      state: vi.fn(async () => ({ favoritedIds: [] as number[] }))
    })

    expect(store.isFavorite(42)).toBe(false)
    expect(store.isPending(42)).toBe(false)
  })
})
