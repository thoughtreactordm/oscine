import { describe, expect, it } from 'vitest'
import { createReorderDrag, destinationIndex } from '../../../src/renderer/panels/playlistReorder'

describe('the reorder destination', () => {
  const order = [1, 2, 3, 4]

  it('is an index into the list with the dragged item already removed', () => {
    // Alpha (0) dropped after Delta (3): the visible insertion point is 4, but
    // the mover splices Alpha out first, so the item it should land after is at
    // 2 by then.
    expect(destinationIndex(order, 1, 4, 'after')).toBe(3)
    expect(destinationIndex(order, 1, 3, 'after')).toBe(2)
    expect(destinationIndex(order, 1, 3, 'before')).toBe(1)
  })

  it('does not shift a backward drag, which removes from beyond the target', () => {
    expect(destinationIndex(order, 4, 1, 'before')).toBe(0)
    expect(destinationIndex(order, 4, 2, 'after')).toBe(2)
    expect(destinationIndex(order, 3, 1, 'before')).toBe(0)
  })

  it('is null for the gestures that change nothing', () => {
    expect(destinationIndex(order, 2, 2, 'before')).toBeNull()
    expect(destinationIndex(order, 2, 2, 'after')).toBeNull()
    // The gap after my previous neighbour is the gap I am already in.
    expect(destinationIndex(order, 2, 1, 'after')).toBeNull()
    expect(destinationIndex(order, 2, 3, 'before')).toBeNull()
  })

  it('is null when either item is not in the list', () => {
    expect(destinationIndex(order, 9, 2, 'before')).toBeNull()
    expect(destinationIndex(order, 2, 9, 'before')).toBeNull()
  })
})

describe('the shared reorder drag', () => {
  function drag(order = [1, 2, 3, 4]) {
    const moves: Array<[number, number]> = []
    const begins: number[] = []
    const model = createReorderDrag(
      () => order,
      (playlistId, toIndex) => {
        moves.push([playlistId, toIndex])
      },
      () => begins.push(1)
    )
    return { model, moves, begins }
  }

  it('moves through the caller and clears the indicator', async () => {
    const h = drag()
    h.model.begin(1)
    expect(h.model.over(3, 'after')).toBe(true)
    expect(h.model.indicator(3)).toBe('after')

    await h.model.drop()

    expect(h.moves).toEqual([[1, 2]])
    expect(h.model.indicator(3)).toBeNull()
    expect(h.model.dragId.value).toBeNull()
  })

  it('shows no indicator over a gap the item already occupies', () => {
    const h = drag()
    h.model.begin(2)
    expect(h.model.over(1, 'after')).toBe(true)
    expect(h.model.indicator(1)).toBeNull()
  })

  it('declines a drag it did not start, so a track drop can fall through', () => {
    const h = drag()
    expect(h.model.over(2, 'before')).toBe(false)
    expect(h.model.indicator(2)).toBeNull()
  })

  it('sends nothing when a drag ends outside any drop point', async () => {
    const h = drag()
    h.model.begin(1)
    await h.model.drop()
    expect(h.moves).toHaveLength(0)
  })

  it('tells its owner a drag has begun, which is how a rename is abandoned', () => {
    const h = drag()
    h.model.begin(1)
    expect(h.begins).toHaveLength(1)
  })
})
