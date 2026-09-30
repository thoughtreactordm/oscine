import { describe, expect, it } from 'vitest'
import { nextTick, ref, shallowRef } from 'vue'
import {
  AUDIO_EQ_ACTIVE,
  AUDIO_EQ_ENABLED,
  AUDIO_EQ_PRESET_ID,
  AUDIO_EQ_PRESETS
} from '@shared/settings'
import type { EqualizerPreset, EqualizerSpec } from '@shared/audio/equalizer'
import type { Track } from '@shared/library'
import { createEqualizerState } from '../../../src/renderer/stores/equalizerState'
import {
  createEqAssignmentBinding,
  type AssignmentLibrary
} from '../../../src/renderer/playback/eqAssignmentBinding'
import { bindAudioPreferences } from '../../../src/renderer/playback/audioPreferences'
import { settingsStoreFixture } from '../settings/fixture'

/**
 * Integration guard for the derived-override boot flow (W19-6/W19-11): the
 * equalizer state, the assignment binding and `bindAudioPreferences` wired over
 * one shared override ref, exercised across a boot-on-override → play-non-override
 * sequence. The property under test is that an override the binding pushes for the
 * persisted track never strands the operator's global curve for the next
 * non-override track — audibly or in the pane — the failure an operator reported
 * against a desynced dev build and which the units below must keep out of the app.
 */

const bassBoost: EqualizerSpec = {
  enabled: true,
  preampDb: -2,
  bands: [{ id: 'b1', type: 'peaking', frequencyHz: 80, gainDb: 6, q: 1, enabled: true }]
}
const trebleLift: EqualizerSpec = {
  enabled: true,
  preampDb: -1,
  bands: [{ id: 'b2', type: 'highshelf', frequencyHz: 8000, gainDb: 4, q: 1, enabled: true }]
}

const globalPreset: EqualizerPreset = { id: 'pGlobal', name: 'Bass', spec: bassBoost }
const overridePreset: EqualizerPreset = { id: 'pOverride', name: 'Treble', spec: trebleLift }

function libraryByTrack(
  map: Record<number, { albumId: number | null; artistId: number | null }>
): AssignmentLibrary {
  return {
    trackFacets: async (trackId) => map[trackId] ?? { albumId: null, artistId: null },
    listAlbums: async () => ({ albums: [], total: 0 }),
    listArtists: async () => ({ artists: [], total: 0 }),
    listPlaylists: async () => [],
    listAssignments: async () => ({ assignments: [] })
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await nextTick()
}

describe('EQ override boot regression', () => {
  it('a non-override track played after an override boot still gets the global curve', async () => {
    // Main holds a real global curve, the master switch on, and both presets.
    const fixture = settingsStoreFixture({
      deferGetAll: true,
      stored: {
        [AUDIO_EQ_ACTIVE.key]: bassBoost,
        [AUDIO_EQ_ENABLED.key]: true,
        [AUDIO_EQ_PRESETS.key]: [globalPreset, overridePreset]
      }
    })
    const settings = fixture.settings
    // Album 10 carries the override; album 20 carries none.
    fixture.bridge.seedOverride({ kind: 'album', id: 10 }, AUDIO_EQ_PRESET_ID.key, 'pOverride')

    // The playback store's derived-override ref and the audio binding over it.
    const eqOverride = shallowRef<EqualizerSpec | null>(null)
    const audio = bindAudioPreferences(settings, eqOverride)

    // The assignment binding, wired to push into the same ref, on the override track.
    const nowPlaying = ref<Track | null>(null)
    const playingPlaylistId = ref<number | null>(null)
    createEqAssignmentBinding({
      nowPlaying,
      playingPlaylistId,
      settings,
      library: libraryByTrack({
        1: { albumId: 10, artistId: null },
        2: { albumId: 20, artistId: null }
      }),
      applyOverride: (spec) => {
        eqOverride.value = spec
      }
    })

    // The EQ tool's state, targeting the same override ref (mode off by default).
    const eq = createEqualizerState(settings, { override: eqOverride })

    // Boot: the persisted override track becomes current while hydration is still open.
    nowPlaying.value = { id: 1 } as Track
    await settle()
    fixture.bridge.answerGetAll()
    await settle()

    // On the override track: audio plays the override, the tool shows the global.
    expect(eqOverride.value).toEqual(trebleLift)
    expect(audio.equalizer.value.bands).toEqual(trebleLift.bands)
    expect(eq.active.value).toEqual(bassBoost)

    // Now play a non-override track.
    nowPlaying.value = { id: 2 } as Track
    await settle()

    // The override must clear and the global must play again — both audibly and in the tool.
    expect(eqOverride.value).toBeNull()
    expect(audio.equalizer.value.bands).toEqual(bassBoost.bands)
    expect(eq.active.value).toEqual(bassBoost)
  })

  it('the preset selector names the persisted global when the store is built before hydration', async () => {
    const fixture = settingsStoreFixture({
      deferGetAll: true,
      stored: {
        [AUDIO_EQ_ACTIVE.key]: bassBoost,
        [AUDIO_EQ_ENABLED.key]: true,
        [AUDIO_EQ_PRESETS.key]: [globalPreset, overridePreset]
      }
    })
    const eqOverride = shallowRef<EqualizerSpec | null>(null)
    const eq = createEqualizerState(fixture.settings, { override: eqOverride })

    // Built before hydration: the global reads the flat default until getAll lands.
    expect(eq.active.value.bands).toEqual([])

    fixture.bridge.answerGetAll()
    await settle()

    expect(eq.active.value).toEqual(bassBoost)
    expect(eq.appliedPresetId.value).toBe('pGlobal')
  })

  it('leaving the override-edit mode on across a track change does not strand the global', async () => {
    const fixture = settingsStoreFixture({
      stored: {
        [AUDIO_EQ_ACTIVE.key]: bassBoost,
        [AUDIO_EQ_ENABLED.key]: true,
        [AUDIO_EQ_PRESETS.key]: [globalPreset, overridePreset]
      }
    })
    const settings = fixture.settings
    await settings.ready
    fixture.bridge.seedOverride({ kind: 'album', id: 10 }, AUDIO_EQ_PRESET_ID.key, 'pOverride')

    const eqOverride = shallowRef<EqualizerSpec | null>(null)
    const audio = bindAudioPreferences(settings, eqOverride)
    const nowPlaying = ref<Track | null>(null)
    const playingPlaylistId = ref<number | null>(null)
    createEqAssignmentBinding({
      nowPlaying,
      playingPlaylistId,
      settings,
      library: libraryByTrack({
        1: { albumId: 10, artistId: null },
        2: { albumId: 20, artistId: null }
      }),
      applyOverride: (spec) => {
        eqOverride.value = spec
      }
    })
    const eq = createEqualizerState(settings, { override: eqOverride })

    // On the override track, turn the in-situ edit mode on and edit the override.
    nowPlaying.value = { id: 1 } as Track
    await settle()
    eq.editingOverride.value = true
    expect(eq.editingOverrideActive.value).toBe(true)
    eq.active.value = { ...trebleLift, preampDb: -6 }
    await settle()

    // Now play a non-override track with the mode still on.
    nowPlaying.value = { id: 2 } as Track
    await settle()

    expect(eqOverride.value).toBeNull()
    expect(eq.editingOverrideActive.value).toBe(false)
    expect(audio.equalizer.value.bands).toEqual(bassBoost.bands)
    expect(eq.active.value).toEqual(bassBoost)
  })
})
