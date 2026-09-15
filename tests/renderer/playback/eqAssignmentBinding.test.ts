import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import {
  AUDIO_EQ_ACTIVE,
  AUDIO_EQ_ENABLED,
  AUDIO_EQ_PRESET_ID,
  AUDIO_EQ_PRESETS
} from '@shared/settings'
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

/** A library whose track always resolves to one album and no artist. */
function libraryOnAlbum(albumId: number): AssignmentLibrary {
  return {
    trackFacets: async () => ({ albumId, artistId: null }),
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

describe('createEqAssignmentBinding — suspend on manual edit', () => {
  it('flips suspended when the operator edits the curve of an assigned track', async () => {
    const { settings } = settingsStoreFixture()
    await settings.set(AUDIO_EQ_ENABLED.key, true)
    await settings.set(AUDIO_EQ_PRESETS.key, [loud])
    await settings.setOverride(AUDIO_EQ_PRESET_ID, { kind: 'album', id: 10 }, 'p1')

    const nowPlaying = ref<Track | null>(null)
    const playingPlaylistId = ref<number | null>(null)
    const binding = createEqAssignmentBinding({
      nowPlaying,
      playingPlaylistId,
      settings,
      library: libraryOnAlbum(10)
    })

    // A track on the assigned album starts. The assignment should reach the curve.
    nowPlaying.value = { id: 1 } as Track
    await settle()
    expect(settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)).toEqual(loudSpec)
    expect(binding.suspended.value).toBe(false)

    // The operator drags a band — a write to the curve the applier did not make.
    const editedSpec: EqualizerSpec = {
      ...loudSpec,
      bands: [{ ...loudSpec.bands[0], gainDb: -6 }]
    }
    settings.value<EqualizerSpec>(AUDIO_EQ_ACTIVE.key).value = editedSpec
    await settle()

    // The edit stands — reconcile must not revert it — and it suspends the
    // assignment, which is what lights the pane's banner and its Resume button.
    expect(settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)).toEqual(editedSpec)
    expect(binding.suspended.value).toBe(true)
  })

  it('resume re-applies the assignment after a suspension', async () => {
    const { settings } = settingsStoreFixture()
    await settings.set(AUDIO_EQ_ENABLED.key, true)
    await settings.set(AUDIO_EQ_PRESETS.key, [loud])
    await settings.setOverride(AUDIO_EQ_PRESET_ID, { kind: 'album', id: 10 }, 'p1')

    const nowPlaying = ref<Track | null>(null)
    const playingPlaylistId = ref<number | null>(null)
    const binding = createEqAssignmentBinding({
      nowPlaying,
      playingPlaylistId,
      settings,
      library: libraryOnAlbum(10)
    })

    nowPlaying.value = { id: 1 } as Track
    await settle()
    settings.value<EqualizerSpec>(AUDIO_EQ_ACTIVE.key).value = {
      ...loudSpec,
      bands: [{ ...loudSpec.bands[0], gainDb: -6 }]
    }
    await settle()
    expect(binding.suspended.value).toBe(true)

    binding.resume()
    await settle()

    expect(binding.suspended.value).toBe(false)
    expect(settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)).toEqual(loudSpec)
  })
})
