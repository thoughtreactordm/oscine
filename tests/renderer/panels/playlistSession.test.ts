import { describe, expect, it } from 'vitest'
import {
  emptyPlaylistSession,
  parsePlaylistSession,
  serializePlaylistSession
} from '../../../src/renderer/panels/playlistSession'

/**
 * The stored tab set is operator-writable storage that outlives an upgrade, so
 * every one of these is about a value the reader must not trust. The bar is not
 * "does it round-trip" — it is "does a hand-edited or stale value degrade to no
 * tabs open", which is recoverable because the rail is right there.
 */
describe('reading a stored playlist session', () => {
  it('round-trips what it wrote', () => {
    const session = { openIds: [4, 1, 9], viewedId: 1 }
    expect(parsePlaylistSession(serializePlaylistSession(session))).toEqual(session)
  })

  it('is empty when there is nothing stored', () => {
    expect(parsePlaylistSession(null)).toEqual(emptyPlaylistSession())
  })

  it('is empty for anything that is not an object of the right shape', () => {
    expect(parsePlaylistSession('{ not json')).toEqual(emptyPlaylistSession())
    expect(parsePlaylistSession('null')).toEqual(emptyPlaylistSession())
    expect(parsePlaylistSession('42')).toEqual(emptyPlaylistSession())
    expect(parsePlaylistSession('[1,2,3]')).toEqual(emptyPlaylistSession())
    expect(parsePlaylistSession('{"openIds":"1,2"}')).toEqual(emptyPlaylistSession())
  })

  it('drops ids that are not ids', () => {
    const raw = '{"openIds":[1,"2",null,3.5,-4,0,5],"viewedId":5}'
    expect(parsePlaylistSession(raw)).toEqual({ openIds: [1, 5], viewedId: 5 })
  })

  it('collapses duplicates, which would render one playlist as two tabs', () => {
    expect(parsePlaylistSession('{"openIds":[7,7,2,7],"viewedId":2}')).toEqual({
      openIds: [7, 2],
      viewedId: 2
    })
  })

  it('falls back to the first tab when the viewed one is not among them', () => {
    expect(parsePlaylistSession('{"openIds":[3,4],"viewedId":9}')).toEqual({
      openIds: [3, 4],
      viewedId: 3
    })
    expect(parsePlaylistSession('{"openIds":[3,4]}')).toEqual({ openIds: [3, 4], viewedId: 3 })
  })

  it('views nothing when nothing is open', () => {
    expect(parsePlaylistSession('{"openIds":[],"viewedId":6}')).toEqual({
      openIds: [],
      viewedId: null
    })
  })

  it('keeps the stored tab order, which is not the library order', () => {
    expect(parsePlaylistSession('{"openIds":[9,2,5],"viewedId":5}').openIds).toEqual([9, 2, 5])
  })
})
