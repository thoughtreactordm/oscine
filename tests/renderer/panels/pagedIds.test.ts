import { describe, expect, it } from 'vitest'
import { collectPagedIds, type IdPage } from '../../../src/renderer/panels/pagedIds'

/** A facet standing for `total` tracks, served `pageSize` at a time. */
function library(total: number) {
  const asked: Array<{ offset: number; limit: number }> = []
  const fetchPage = (offset: number, limit: number): Promise<IdPage> => {
    asked.push({ offset, limit })
    return Promise.resolve({
      ids: Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => offset + i
      ),
      total
    })
  }
  return { asked, fetchPage }
}

describe('walking an id query to the end', () => {
  it('takes one page when one is enough', async () => {
    const source = library(3)
    expect(await collectPagedIds(10, source.fetchPage)).toEqual([0, 1, 2])
    expect(source.asked).toEqual([{ offset: 0, limit: 10 }])
  })

  it('takes nothing from an empty facet', async () => {
    const source = library(0)
    expect(await collectPagedIds(10, source.fetchPage)).toEqual([])
  })

  it('walks past the page ceiling, in order', async () => {
    const source = library(25)
    const ids = await collectPagedIds(10, source.fetchPage)

    expect(ids).toHaveLength(25)
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => i))
    expect(source.asked).toEqual([
      { offset: 0, limit: 10 },
      { offset: 10, limit: 10 },
      { offset: 20, limit: 10 }
    ])
  })

  it('stops on an exact final page without asking for another', async () => {
    // The case a short-page check alone would get wrong: 20 of 20 is not short.
    const source = library(20)
    expect(await collectPagedIds(10, source.fetchPage)).toHaveLength(20)
    expect(source.asked).toHaveLength(2)
  })

  it('stops when the pages run out early, whatever the total claimed', async () => {
    // A row deleted between two pages: `total` says there is more and there is
    // not. Without the empty-page backstop this spins forever.
    let calls = 0
    const ids = await collectPagedIds(10, (offset, limit) => {
      calls++
      return Promise.resolve({
        ids: offset === 0 ? Array.from({ length: limit }, (_, i) => i) : [],
        total: 500
      })
    })

    expect(ids).toHaveLength(10)
    expect(calls).toBe(2)
  })

  it('lets a failure through rather than returning a short answer', async () => {
    await expect(collectPagedIds(10, () => Promise.reject(new Error('gone')))).rejects.toThrow(
      'gone'
    )
  })
})
