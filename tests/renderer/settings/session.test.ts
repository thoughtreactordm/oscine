import { describe, expect, it } from 'vitest'
import { RESTORE_SESSION_KEY, type TabSession } from '@shared/settings'
import { restoredTabSession } from '../../../src/renderer/settings/session'
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
