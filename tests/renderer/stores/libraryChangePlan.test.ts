import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_REFETCH_PLAN,
  isEmptyRefetchPlan,
  namesId,
  planLibraryRefetch,
  refreshTrackTagCache
} from '../../../src/renderer/stores/libraryChangePlan'
import type { TrackTagsRow, TrackTagView } from '@shared/tags'

/**
 * The renderer half of `library.changed` — **D36.9**. Pure, so the decisions
 * (what to re-read, and that a self-made change re-reads nothing) are proved
 * here without Pinia or a window.
 */

describe('planLibraryRefetch', () => {
  it('maps each kind onto the re-read it calls for', () => {
    const plan = planLibraryRefetch({
      origin: 'agent',
      changes: {
        playlistEntries: [4],
        overrides: [1, 2],
        tags: [9],
        tagOverrides: 'all'
      }
    })
    expect(plan).toEqual({
      playlists: true,
      playlistEntries: [4],
      trackRows: true,
      tagTracks: [9],
      tagVocabulary: true,
      tagOverrides: 'all'
    })
  })

  it('re-reads only the rail for a playlist row change', () => {
    const plan = planLibraryRefetch({ origin: 'main', changes: { playlists: 'all' } })
    expect(plan.playlists).toBe(true)
    expect(plan.trackRows).toBe(false)
    expect(plan.tagVocabulary).toBe(false)
    expect(isEmptyRefetchPlan(plan)).toBe(false)
  })

  it('plans nothing for a change the renderer made itself, however often it arrives', () => {
    const event = {
      origin: 'renderer' as const,
      changes: { overrides: [1], tags: 'all' as const, playlists: [2] }
    }
    expect(planLibraryRefetch(event)).toBe(EMPTY_REFETCH_PLAN)
    expect(planLibraryRefetch(event)).toBe(EMPTY_REFETCH_PLAN)
    expect(isEmptyRefetchPlan(EMPTY_REFETCH_PLAN)).toBe(true)
  })
})

describe('namesId', () => {
  it('matches a listed id or all, never a null pane', () => {
    expect(namesId([1, 2], 2)).toBe(true)
    expect(namesId([1, 2], 3)).toBe(false)
    expect(namesId('all', 3)).toBe(true)
    expect(namesId('all', null)).toBe(false)
  })
})

function view(...user: string[]): TrackTagView {
  return { file: ['Rock'], user: user.map((label, i) => ({ id: i + 1, label, source: 'user' })) }
}

describe('refreshTrackTagCache', () => {
  it('re-reads only cached tracks the payload names and writes what moved', async () => {
    const cache = new Map<number, TrackTagView>([
      [1, view()],
      [2, view('Calm')]
    ])
    const fetch = vi.fn(async (ids: number[]): Promise<TrackTagsRow[]> =>
      ids.filter((id) => id === 1).map((trackId) => ({ trackId, ...view('Late') }))
    )
    const changed = await refreshTrackTagCache(cache, [1, 2, 3], fetch)

    // 3 was never cached: it is read on demand when something draws it.
    expect(fetch).toHaveBeenCalledWith([1, 2])
    expect(changed).toEqual([1, 2])
    expect(cache.get(1)).toEqual(view('Late'))
    // Absent from the answer means it carries nothing now.
    expect(cache.get(2)).toEqual({ file: [], user: [] })
    expect(cache.has(3)).toBe(false)
  })

  it('treats all as every cached track', async () => {
    const cache = new Map<number, TrackTagView>([
      [5, view()],
      [6, view()]
    ])
    const fetch = vi.fn(async (): Promise<TrackTagsRow[]> => [])
    await refreshTrackTagCache(cache, 'all', fetch)
    expect(fetch).toHaveBeenCalledWith([5, 6])
  })

  it('is idempotent: a repeated payload rewrites nothing', async () => {
    const cache = new Map<number, TrackTagView>([[1, view('Calm')]])
    const fetch = async (): Promise<TrackTagsRow[]> => [{ trackId: 1, ...view('Calm') }]
    const before = cache.get(1)
    expect(await refreshTrackTagCache(cache, [1], fetch)).toEqual([])
    expect(await refreshTrackTagCache(cache, [1], fetch)).toEqual([])
    // Same object: no reactive write happened.
    expect(cache.get(1)).toBe(before)
  })
})
