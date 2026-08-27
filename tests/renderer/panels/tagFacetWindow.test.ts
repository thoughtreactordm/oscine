import { describe, expect, it, vi } from 'vitest'
import type { LibraryBrowseFilters, TagFacet } from '@shared/library'
import { createTagFacetWindow } from '../../../src/renderer/panels/tagFacetWindow'

/**
 * The genre/tag browse window — **W15-5**.
 *
 * The lean, key-selecting sibling of `facetWindow`. What is worth testing without
 * a DOM is exactly what makes it its own module: a `Set<string>` selection whose
 * `filterKeys` is stable while its contents are, and a reload that prunes a
 * selection the narrowed vocabulary no longer contains.
 */

function facet(key: string, extra: Partial<TagFacet> = {}): TagFacet {
  return {
    key,
    label: key[0]!.toUpperCase() + key.slice(1),
    trackCount: 1,
    hasFile: true,
    hasUser: false,
    ...extra
  }
}

function windowOver(pages: TagFacet[][]) {
  let call = 0
  const fetch = vi.fn(
    async (_filters: LibraryBrowseFilters) => pages[Math.min(call++, pages.length - 1)]!
  )
  return { model: createTagFacetWindow({ fetch }), fetch }
}

describe('reload and rows', () => {
  it('loads the vocabulary and reports its size', async () => {
    const { model } = windowOver([[facet('rock'), facet('jazz')]])
    await model.reload()
    expect(model.total.value).toBe(2)
    expect(model.rowAt(0)?.key).toBe('rock')
    expect(model.rowAt(1)?.key).toBe('jazz')
  })

  it('refetches on a filter change', async () => {
    const { model, fetch } = windowOver([[facet('rock')], [facet('jazz')]])
    model.setFilters({ rootId: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(fetch).toHaveBeenCalled()
  })
})

describe('selection and filterKeys', () => {
  it('is undefined when empty and a sorted array when not', async () => {
    const { model } = windowOver([[facet('rock'), facet('jazz')]])
    await model.reload()
    expect(model.filterKeys.value).toBeUndefined()

    model.toggle('rock')
    model.toggle('jazz')
    expect(model.filterKeys.value).toEqual(['jazz', 'rock'])
    expect(model.selectionCount.value).toBe(2)
  })

  it('keeps a stable array identity while the contents are unchanged', async () => {
    const { model } = windowOver([[facet('rock'), facet('jazz')]])
    await model.reload()
    model.toggle('rock')
    const first = model.filterKeys.value
    const second = model.filterKeys.value
    expect(second).toBe(first)
  })

  it('toggles a key off and clears the whole selection', async () => {
    const { model } = windowOver([[facet('rock')]])
    await model.reload()
    model.toggle('rock')
    expect(model.isSelected('rock')).toBe(true)
    model.toggle('rock')
    expect(model.isSelected('rock')).toBe(false)

    model.toggle('rock')
    model.clearSelection()
    expect(model.selectionCount.value).toBe(0)
    expect(model.filterKeys.value).toBeUndefined()
  })

  it('selectOnly replaces the selection with one key', async () => {
    const { model } = windowOver([[facet('rock'), facet('jazz')]])
    await model.reload()
    model.toggle('rock')
    model.selectOnly('jazz')
    expect(model.filterKeys.value).toEqual(['jazz'])
  })
})

describe('pruning', () => {
  it('drops a selected key the reloaded vocabulary no longer contains', async () => {
    const { model } = windowOver([
      [facet('rock'), facet('jazz')],
      [facet('rock')] // 'jazz' has left the narrowed vocabulary
    ])
    await model.reload()
    model.toggle('jazz')
    expect(model.filterKeys.value).toEqual(['jazz'])

    await model.reload()
    expect(model.filterKeys.value).toBeUndefined()
    expect(model.isSelected('jazz')).toBe(false)
  })

  it('keeps a selected key that survives the reload', async () => {
    const { model } = windowOver([[facet('rock'), facet('jazz')], [facet('rock')]])
    await model.reload()
    model.toggle('rock')
    await model.reload()
    expect(model.filterKeys.value).toEqual(['rock'])
  })
})
