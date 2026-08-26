import { describe, expect, it } from 'vitest'
import {
  EMPTY_QUEUE_SESSION,
  QUEUE_SESSION_KEY,
  RESTORE_QUEUE_KEY,
  RESTORE_SESSION_KEY,
  type QueueSession,
  type TabSession
} from '@shared/settings'
import { restoredQueueSession, restoredTabSession } from '../../../src/renderer/settings/session'
import { storedValue, viewSettingsFixture } from './fixture'

/**
 * The launch gate over the two tab sessions.
 *
 * Driven against the real view store rather than a stub, for the reason the
 * absorbed modules are: the property under test is what a *stored* session does
 * when the gate is shut, and a fake store with its own idea of storage would be
 * answering a different question.
 */

const PLAYLIST_TABS = 'view.playlistTabs'
const PODCAST_TABS = 'view.podcastTabs'

const LAST_SESSION: TabSession = { openIds: [4, 7, 9], viewedId: 7 }

describe('restoredTabSession', () => {
  it('brings the tabs back by default', () => {
    const { settings } = viewSettingsFixture({ [PLAYLIST_TABS]: LAST_SESSION })
    expect(restoredTabSession(settings, PLAYLIST_TABS)).toEqual(LAST_SESSION)
  })

  it('opens on nothing when the gate is shut', () => {
    const { settings } = viewSettingsFixture({
      [RESTORE_SESSION_KEY]: false,
      [PLAYLIST_TABS]: LAST_SESSION
    })
    expect(restoredTabSession(settings, PLAYLIST_TABS)).toEqual({ openIds: [], viewedId: null })
  })

  /**
   * The gate is a read and nothing else.
   *
   * Not a claim that the session survives a suppressed launch — it does not, and
   * should not: each store's own watcher goes on recording what is open, so a
   * launch that opened nothing records nothing, and turning the setting back on
   * reopens what was genuinely last open. What this pins is that the *gate* is
   * not the thing that writes, which is what makes that behaviour the stores'
   * and keeps this from becoming a second session mechanism.
   */
  it('reads without writing, and answers again the moment it is turned on', () => {
    const { settings, storage } = viewSettingsFixture({
      [RESTORE_SESSION_KEY]: false,
      [PLAYLIST_TABS]: LAST_SESSION
    })
    restoredTabSession(settings, PLAYLIST_TABS)

    expect(storedValue(storage, PLAYLIST_TABS)).toEqual(LAST_SESSION)

    settings.set(RESTORE_SESSION_KEY, true)
    expect(restoredTabSession(settings, PLAYLIST_TABS)).toEqual(LAST_SESSION)
  })

  it('gates both strips off the one key', () => {
    const { settings } = viewSettingsFixture({
      [RESTORE_SESSION_KEY]: false,
      [PLAYLIST_TABS]: LAST_SESSION,
      [PODCAST_TABS]: { openIds: [2], viewedId: 2 }
    })
    expect(restoredTabSession(settings, PLAYLIST_TABS).openIds).toEqual([])
    expect(restoredTabSession(settings, PODCAST_TABS).openIds).toEqual([])
  })

  // Podcasts fall back to Discover rather than to the leftmost show, and the
  // gate must hand back *that* store's default rather than a shape of its own.
  it("hands back the key's own default, not one shape for both", () => {
    const { settings } = viewSettingsFixture({ [RESTORE_SESSION_KEY]: false })
    expect(restoredTabSession(settings, PODCAST_TABS)).toEqual({ openIds: [], viewedId: null })
  })
})

/**
 * The launch gate over the last play queue — G2, W14-6.
 *
 * `view.restoreQueue` differs from the tab gate in one deliberate way: it is off
 * by default, and it gates the write too (in `usePlaybackStore`). So a shut gate
 * returns the empty session and the store never records — the read side of that
 * is what these pin.
 */
describe('restoredQueueSession', () => {
  const LAST_QUEUE: QueueSession = {
    intent: { kind: 'playlist', playlistId: 7 },
    baseIndex: 3,
    trackId: 88,
    elapsedMs: 4200
  }

  it('does not restore by default — the gate is off', () => {
    const { settings } = viewSettingsFixture({ [QUEUE_SESSION_KEY]: LAST_QUEUE })
    expect(restoredQueueSession(settings)).toEqual(EMPTY_QUEUE_SESSION)
  })

  it('brings the queue back once the gate is on', () => {
    const { settings } = viewSettingsFixture({
      [RESTORE_QUEUE_KEY]: true,
      [QUEUE_SESSION_KEY]: LAST_QUEUE
    })
    expect(restoredQueueSession(settings)).toEqual(LAST_QUEUE)
  })

  it('hands back the empty session, never a stored queue, while shut', () => {
    const { settings } = viewSettingsFixture({
      [RESTORE_QUEUE_KEY]: false,
      [QUEUE_SESSION_KEY]: LAST_QUEUE
    })
    expect(restoredQueueSession(settings)).toEqual(EMPTY_QUEUE_SESSION)
  })
})
