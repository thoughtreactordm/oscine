import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { AUDIO_EQ_ACTIVE, AUDIO_EQ_PRESET_ID, AUDIO_EQ_PRESETS } from '@shared/settings'
import type { EqualizerPreset, EqualizerSpec } from '@shared/audio/equalizer'
import type { Track } from '@shared/library'
import {
  createEqAssignmentBinding,
  type AssignmentLibrary
} from '../../../src/renderer/playback/eqAssignmentBinding'
import { settingsStoreFixture } from '../settings/fixture'

const loudSpec: EqualizerSpec = {
  enabled: true,
  preampDb: 0,
  bands: [{ id: 'b1', type: 'peaking', frequencyHz: 1000, gainDb: 6, q: 1, enabled: true }]
}
const loud: EqualizerPreset = { id: 'p1', name: 'Loud', spec: loudSpec }

type Facets = { albumId: number | null; artistId: number | null }

/** A library that resolves each track id to fixed album/artist ids. */
function libraryByTrack(map: Record<number, Facets>): AssignmentLibrary {
  return {
    trackFacets: async (trackId) => map[trackId] ?? { albumId: null, artistId: null },
    listAlbums: async () => ({ albums: [], total: 0 }),
    listArtists: async () => ({ artists: [], total: 0 }),
    listPlaylists: async () => [],
    listAssignments: async () => ({ assignments: [] })
  }
}

/** Let the binding's async facets probe, override load and computed all settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await nextTick()
}

type Settings = ReturnType<typeof settingsStoreFixture>['settings']

function makeBinding(settings: Settings, library: AssignmentLibrary) {
  const nowPlaying = ref<Track | null>(null)
  const playingPlaylistId = ref<number | null>(null)
  const overrides: (EqualizerSpec | null)[] = []
  const binding = createEqAssignmentBinding({
    nowPlaying,
    playingPlaylistId,
    settings,
    library,
    applyOverride: (spec) => overrides.push(spec)
  })
  return { nowPlaying, playingPlaylistId, binding, overrides, last: () => overrides.at(-1) }
}

describe('createEqAssignmentBinding — override layer', () => {
  it('reports the assigned preset curve as the override, and never writes the global', async () => {
    const { settings } = settingsStoreFixture()
    await settings.set(AUDIO_EQ_PRESETS.key, [loud])
    await settings.setOverride(AUDIO_EQ_PRESET_ID, { kind: 'album', id: 10 }, 'p1')
    const globalBefore = settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)

    const h = makeBinding(settings, libraryByTrack({ 1: { albumId: 10, artistId: null } }))
    h.nowPlaying.value = { id: 1 } as Track
    await settle()

    expect(h.last()).toEqual(loudSpec)
    // The operator's global curve is a derived-over base, never mutated.
    expect(settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)).toEqual(globalBefore)
  })

  it('reports no override when the track carries no assignment', async () => {
    const { settings } = settingsStoreFixture()
    await settings.set(AUDIO_EQ_PRESETS.key, [loud])
    await settings.setOverride(AUDIO_EQ_PRESET_ID, { kind: 'album', id: 10 }, 'p1')

    const h = makeBinding(settings, libraryByTrack({ 1: { albumId: 20, artistId: null } }))
    h.nowPlaying.value = { id: 1 } as Track
    await settle()

    expect(h.last()).toBeNull()
  })

  it('clears the override when moving from an assigned track to an unassigned one', async () => {
    const { settings } = settingsStoreFixture()
    await settings.set(AUDIO_EQ_PRESETS.key, [loud])
    await settings.setOverride(AUDIO_EQ_PRESET_ID, { kind: 'album', id: 10 }, 'p1')
    const globalBefore = settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)

    const h = makeBinding(
      settings,
      libraryByTrack({
        1: { albumId: 10, artistId: null },
        2: { albumId: 20, artistId: null }
      })
    )

    h.nowPlaying.value = { id: 1 } as Track
    await settle()
    expect(h.last()).toEqual(loudSpec)

    // Leaving assigned content is not a restore — the override simply goes null.
    h.nowPlaying.value = { id: 2 } as Track
    await settle()
    expect(h.last()).toBeNull()

    // The global curve was never touched at any point in the round trip.
    expect(settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)).toEqual(globalBefore)
  })

  it('reports no override when the assigned preset id dangles', async () => {
    const { settings } = settingsStoreFixture()
    // An album points at 'p1', but no preset by that id exists — it must play flat
    // (no override), not carry a stale curve.
    await settings.setOverride(AUDIO_EQ_PRESET_ID, { kind: 'album', id: 10 }, 'p1')

    const h = makeBinding(settings, libraryByTrack({ 1: { albumId: 10, artistId: null } }))
    h.nowPlaying.value = { id: 1 } as Track
    await settle()

    expect(h.last()).toBeNull()
  })
})
