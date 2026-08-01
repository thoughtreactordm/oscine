import { describe, expect, it } from 'vitest'
import {
  parsePodcastSession,
  serializePodcastSession,
  type PodcastSession
} from '../../../src/renderer/panels/podcastSession'

/**
 * Open show tabs are operator-writable storage that outlives an upgrade, so
 * every case here is about a value the reader must not trust. Degrading to no
 * tabs open is always acceptable — the subscription rail is right there — and
 * is preferable to a tab bar built out of a hand-edited file.
 */
const EMPTY: PodcastSession = { openIds: [], viewedId: null, focusEpisodeId: null }

describe('reading a stored podcast session', () => {
  it('round-trips what it wrote', () => {
    const session: PodcastSession = { openIds: [4, 1, 9], viewedId: 1, focusEpisodeId: null }
    expect(parsePodcastSession(serializePodcastSession(session))).toEqual(session)
  })

  it('is empty when there is nothing stored', () => {
    expect(parsePodcastSession(null)).toEqual(EMPTY)
    expect(parsePodcastSession('')).toEqual(EMPTY)
  })

  it('is empty for anything that is not an object of the right shape', () => {
    expect(parsePodcastSession('{ not json')).toEqual(EMPTY)
    expect(parsePodcastSession('null')).toEqual(EMPTY)
    expect(parsePodcastSession('42')).toEqual(EMPTY)
    expect(parsePodcastSession('{"openIds":"1,2"}')).toEqual(EMPTY)
  })

  it('drops ids that are not usable row ids', () => {
    expect(parsePodcastSession('{"openIds":[1,0,-3,"7",null,2.5,4]}').openIds).toEqual([1, 4])
  })

  it('collapses duplicate tabs', () => {
    expect(parsePodcastSession('{"openIds":[3,3,7,3]}').openIds).toEqual([3, 7])
  })

  it('forgets a viewed show that is not one of the open tabs', () => {
    expect(parsePodcastSession('{"openIds":[1,2],"viewedId":3}').viewedId).toBeNull()
    expect(parsePodcastSession('{"openIds":[1,2],"viewedId":2}').viewedId).toBe(2)
    expect(parsePodcastSession('{"openIds":[1,2],"viewedId":"2"}').viewedId).toBeNull()
  })

  it('never restores a scroll target', () => {
    // focusEpisodeId is a one-shot instruction to the show pane, not state. A
    // restored session that still carries one would yank the list on launch.
    const restored = parsePodcastSession(
      serializePodcastSession({ openIds: [1], viewedId: 1, focusEpisodeId: 55 })
    )
    expect(restored.focusEpisodeId).toBeNull()
    expect(
      serializePodcastSession({ openIds: [1], viewedId: 1, focusEpisodeId: 55 })
    ).not.toContain('focusEpisodeId')
  })
})
