import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { TRACK_ACTIVATION_KEY } from '@shared/settings'
import type { Track } from '@shared/library'
import { createTrackActivation } from '../../../src/renderer/panels/trackActivation'
import { settingsStoreFixture } from '../settings/fixture'

/**
 * What a double-click does, with no list and no queue under it.
 *
 * The gesture is the track list's and the verb is not, which is the whole reason
 * this module exists — so the test drives it the way the two panels do: one
 * `playNow` supplied by the surface, three shared verbs recorded, and a viewed
 * playlist that can be taken away.
 */

function track(id: number): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Someone',
    album: 'Something',
    albumArtist: null,
    trackNo: 1,
    discNo: null,
    year: null,
    codec: 'flac',
    durationSec: 200,
    sampleRateHz: 44_100,
    bitDepth: 16,
    channels: 2,
    encodedBytes: 1_000_000
  } as Track
}

async function harness(options: { viewedPlaylistId?: number | null } = {}) {
  const { settings } = settingsStoreFixture()
  await settings.ready

  const calls: Array<{ verb: string; ids: number[] }> = []
  const viewedPlaylistId = ref<number | null>(
    options.viewedPlaylistId === undefined ? 12 : options.viewedPlaylistId
  )

  const activation = createTrackActivation({
    settings,
    playNow: (row, index) => calls.push({ verb: `playNow@${index}`, ids: [row.id] }),
    playNext: (rows) => {
      calls.push({ verb: 'playNext', ids: rows.map((row) => row.id) })
      return Promise.resolve(rows.length)
    },
    addToQueue: (rows) => {
      calls.push({ verb: 'addToQueue', ids: rows.map((row) => row.id) })
      return Promise.resolve(rows.length)
    },
    viewedPlaylistId,
    addToViewedPlaylist: (playlistId, trackIds) => {
      calls.push({ verb: `addTo:${playlistId}`, ids: [...trackIds] })
      return Promise.resolve()
    }
  })

  return { activation, settings, calls, viewedPlaylistId }
}

describe('the four verbs', () => {
  it('plays by default, through the surface that supplied the verb', async () => {
    const h = await harness()
    await h.activation.activate(track(5), 3)
    expect(h.calls).toEqual([{ verb: 'playNow@3', ids: [5] }])
  })

  it('plays next', async () => {
    const h = await harness()
    await h.settings.set(TRACK_ACTIVATION_KEY, 'playNext')
    await h.activation.activate(track(5), 3)
    expect(h.calls).toEqual([{ verb: 'playNext', ids: [5] }])
  })

  it('queues', async () => {
    const h = await harness()
    await h.settings.set(TRACK_ACTIVATION_KEY, 'queue')
    await h.activation.activate(track(5), 3)
    expect(h.calls).toEqual([{ verb: 'addToQueue', ids: [5] }])
  })

  it('adds to the playlist Curate is showing', async () => {
    const h = await harness()
    await h.settings.set(TRACK_ACTIVATION_KEY, 'addToViewedPlaylist')
    await h.activation.activate(track(5), 3)
    expect(h.calls).toEqual([{ verb: 'addTo:12', ids: [5] }])
  })

  it('follows a change without being rebuilt', async () => {
    const h = await harness()
    await h.activation.activate(track(1), 0)
    await h.settings.set(TRACK_ACTIVATION_KEY, 'queue')
    await h.activation.activate(track(2), 1)
    expect(h.calls.map((call) => call.verb)).toEqual(['playNow@0', 'addToQueue'])
  })
})

describe('with nowhere to add to', () => {
  it('plays instead of doing nothing', async () => {
    const h = await harness({ viewedPlaylistId: null })
    await h.settings.set(TRACK_ACTIVATION_KEY, 'addToViewedPlaylist')

    expect(h.activation.action.value).toBe('addToViewedPlaylist')
    expect(h.activation.effective.value).toBe('play')
    expect(h.activation.hint.value).toMatch(/Open a playlist/)

    await h.activation.activate(track(5), 3)
    expect(h.calls).toEqual([{ verb: 'playNow@3', ids: [5] }])
  })

  it('starts adding the moment a playlist is opened, with no hint left over', async () => {
    const h = await harness({ viewedPlaylistId: null })
    await h.settings.set(TRACK_ACTIVATION_KEY, 'addToViewedPlaylist')
    h.viewedPlaylistId.value = 12

    expect(h.activation.hint.value).toBeNull()
    await h.activation.activate(track(5), 3)
    expect(h.calls).toEqual([{ verb: 'addTo:12', ids: [5] }])
  })

  it('says nothing about a fallback it is not making', async () => {
    const h = await harness({ viewedPlaylistId: null })
    expect(h.activation.hint.value).toBeNull()
  })
})
