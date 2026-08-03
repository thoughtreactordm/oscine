import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { FACET_ACTIVATION_KEY } from '@shared/settings'
import { createFacetActivation } from '../../../src/renderer/panels/facetActivation'
import { settingsStoreFixture } from '../settings/fixture'

/**
 * What double-clicking an artist or an album does, with no sidebar under it.
 *
 * Driven the way `Sources` drives it: a target that is two closures — play this
 * row's predicate, widen this row into track ids — and the three shared verbs
 * recorded. The target being closures is the point of the module, so the test
 * asserts on which closure ran rather than on a facet id it never sees.
 */

async function harness(options: { viewedPlaylistId?: number | null } = {}) {
  const { settings } = settingsStoreFixture()
  await settings.ready

  const calls: Array<{ verb: string; ids: number[] }> = []
  const viewedPlaylistId = ref<number | null>(
    options.viewedPlaylistId === undefined ? 12 : options.viewedPlaylistId
  )

  const activation = createFacetActivation({
    settings,
    playNext: (trackIds) => {
      calls.push({ verb: 'playNext', ids: [...trackIds] })
      return Promise.resolve(trackIds.length)
    },
    addToQueue: (trackIds) => {
      calls.push({ verb: 'addToQueue', ids: [...trackIds] })
      return Promise.resolve(trackIds.length)
    },
    viewedPlaylistId,
    addToViewedPlaylist: (playlistId, trackIds) => {
      calls.push({ verb: `addTo:${playlistId}`, ids: [...trackIds] })
      return Promise.resolve()
    }
  })

  /** One artist row: it plays as a predicate, or widens into three tracks. */
  let widened = 0
  const target = {
    play: () => calls.push({ verb: 'play', ids: [] }),
    trackIds: () => {
      widened += 1
      return Promise.resolve([7, 8, 9] as readonly number[])
    }
  }

  return { activation, settings, calls, target, viewedPlaylistId, widened: () => widened }
}

describe('the five verbs', () => {
  it('plays the whole row by default, through the predicate and not a track list', async () => {
    const h = await harness()
    await h.activation.activate(h.target)
    expect(h.calls).toEqual([{ verb: 'play', ids: [] }])
    // The one verb that must never resolve ids: playing an artist adopts their
    // slice of the library order, it does not materialize it.
    expect(h.widened()).toBe(0)
  })

  it('plays all of it next', async () => {
    const h = await harness()
    await h.settings.set(FACET_ACTIVATION_KEY, 'playNext')
    await h.activation.activate(h.target)
    expect(h.calls).toEqual([{ verb: 'playNext', ids: [7, 8, 9] }])
  })

  it('queues all of it', async () => {
    const h = await harness()
    await h.settings.set(FACET_ACTIVATION_KEY, 'queue')
    await h.activation.activate(h.target)
    expect(h.calls).toEqual([{ verb: 'addToQueue', ids: [7, 8, 9] }])
  })

  it('adds all of it to the playlist Curate is showing', async () => {
    const h = await harness()
    await h.settings.set(FACET_ACTIVATION_KEY, 'addToViewedPlaylist')
    await h.activation.activate(h.target)
    expect(h.calls).toEqual([{ verb: 'addTo:12', ids: [7, 8, 9] }])
  })

  /**
   * The option the song list has no need for. A double-clicked artist is a
   * hundred tracks, and an operator who only ever meant to select the row has
   * to be able to say so.
   */
  it('does nothing at all when that is what was asked for', async () => {
    const h = await harness()
    await h.settings.set(FACET_ACTIVATION_KEY, 'none')
    await h.activation.activate(h.target)
    expect(h.calls).toEqual([])
    expect(h.widened()).toBe(0)
  })

  it('follows a change without being rebuilt', async () => {
    const h = await harness()
    await h.activation.activate(h.target)
    await h.settings.set(FACET_ACTIVATION_KEY, 'queue')
    await h.activation.activate(h.target)
    expect(h.calls.map((call) => call.verb)).toEqual(['play', 'addToQueue'])
  })
})

describe('with nowhere to add to', () => {
  it('plays instead of doing nothing, and says why', async () => {
    const h = await harness({ viewedPlaylistId: null })
    await h.settings.set(FACET_ACTIVATION_KEY, 'addToViewedPlaylist')

    expect(h.activation.action.value).toBe('addToViewedPlaylist')
    expect(h.activation.effective.value).toBe('play')
    expect(h.activation.hint.value).toMatch(/Open a playlist/)

    await h.activation.activate(h.target)
    expect(h.calls).toEqual([{ verb: 'play', ids: [] }])
  })

  it('starts adding the moment a playlist is opened, with no hint left over', async () => {
    const h = await harness({ viewedPlaylistId: null })
    await h.settings.set(FACET_ACTIVATION_KEY, 'addToViewedPlaylist')
    h.viewedPlaylistId.value = 12

    expect(h.activation.hint.value).toBeNull()
    await h.activation.activate(h.target)
    expect(h.calls).toEqual([{ verb: 'addTo:12', ids: [7, 8, 9] }])
  })

  it('says nothing about a fallback it is not making', async () => {
    const h = await harness({ viewedPlaylistId: null })
    expect(h.activation.hint.value).toBeNull()
  })

  /** `none` is a chosen verb, not an absence, so it is not rescued. */
  it('leaves "nothing" alone', async () => {
    const h = await harness({ viewedPlaylistId: null })
    await h.settings.set(FACET_ACTIVATION_KEY, 'none')
    expect(h.activation.effective.value).toBe('none')
    expect(h.activation.hint.value).toBeNull()
  })
})
