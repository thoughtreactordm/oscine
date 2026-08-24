import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchQuery, SearchResult } from '@shared/search'
import { createPaletteSearch } from '../../../src/renderer/shell/paletteSearch'

/**
 * The entity side of the palette, RQ1's async half. The parts that are wrong in
 * ways review cannot see: a keystroke that hits main before the debounce, a
 * prefix mode that never reaches the wire firing anyway, and a slow response
 * painting over a newer one.
 */

const DEBOUNCE = 150

function groupsFor(label: string): SearchResult {
  return {
    groups: [
      {
        kind: 'artist',
        hits: [{ kind: 'artist', id: 1, title: label, subtitle: null, artworkHash: null, score: 1 }]
      }
    ]
  }
}

interface Deferred {
  promise: Promise<SearchResult>
  resolve: (value: SearchResult) => void
}

function deferred(): Deferred {
  let resolve!: (value: SearchResult) => void
  const promise = new Promise<SearchResult>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createPaletteSearch', () => {
  it('debounces a blended query, then calls main with the parsed text and cap', async () => {
    const query = vi.fn(async (): Promise<SearchResult> => ({ groups: [] }))
    const search = createPaletteSearch({ query, debounceMs: DEBOUNCE, limitPerGroup: 6 })

    search.setTerm('kid a')
    expect(query).not.toHaveBeenCalled()
    expect(search.loading.value).toBe(true)

    await vi.advanceTimersByTimeAsync(DEBOUNCE)

    expect(query).toHaveBeenCalledWith({ text: 'kid a', mode: 'blended', limitPerGroup: 6 })
    expect(search.loading.value).toBe(false)
  })

  it('scopes the query to a prefix mode', async () => {
    const query = vi.fn<(q: SearchQuery) => Promise<SearchResult>>(async () => ({ groups: [] }))
    const search = createPaletteSearch({ query, debounceMs: DEBOUNCE })

    search.setTerm('@radiohead')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)

    const sent = query.mock.calls[0][0]
    expect(sent.mode).toBe('artist')
    expect(sent.text).toBe('radiohead')
  })

  it('never calls main for action or setting modes', async () => {
    const query = vi.fn(async (): Promise<SearchResult> => ({ groups: [] }))
    const search = createPaletteSearch({ query, debounceMs: DEBOUNCE })

    search.setTerm('>play')
    search.setTerm('/theme')
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2)

    // Their groups are renderer registries — the wire is not involved.
    expect(query).not.toHaveBeenCalled()
    expect(search.loading.value).toBe(false)
  })

  it('never calls main for an empty query', async () => {
    const query = vi.fn(async (): Promise<SearchResult> => ({ groups: [] }))
    const search = createPaletteSearch({ query, debounceMs: DEBOUNCE })

    search.setTerm('@')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)

    expect(query).not.toHaveBeenCalled()
  })

  it('drops a stale response that resolves after a newer query', async () => {
    const first = deferred()
    const second = deferred()
    const query = vi
      .fn<(q: SearchQuery) => Promise<SearchResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const search = createPaletteSearch({ query, debounceMs: DEBOUNCE })

    search.setTerm('rad')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    search.setTerm('radiohead')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)

    // The first query resolves last — the out-of-order case the seq guard exists for.
    second.resolve(groupsFor('radiohead'))
    first.resolve(groupsFor('rad'))
    await vi.advanceTimersByTimeAsync(0)

    expect(search.result.value.groups[0].hits[0].title).toBe('radiohead')
  })

  it('reset drops the state and ignores an in-flight response', async () => {
    const inflight = deferred()
    const query = vi.fn(() => inflight.promise)
    const search = createPaletteSearch({ query, debounceMs: DEBOUNCE })

    search.setTerm('rad')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    search.reset()
    inflight.resolve(groupsFor('rad'))
    await vi.advanceTimersByTimeAsync(0)

    expect(search.result.value.groups).toEqual([])
    expect(search.loading.value).toBe(false)
  })
})
