/**
 * The always-on wiring that makes per-entity EQ assignments apply during
 * playback (W19-6).
 *
 * Lives beside the playback controller and is created once at store construction
 * — like the presence emitter — rather than in the equalizer pane, because an
 * assignment has to take effect whether or not the pane is open. It observes the
 * audible track, resolves the album/artist/playlist cascade for it, and reports
 * the resolved curve as the current track's **override** through `applyOverride`.
 *
 * The override is a derived layer, never a write-back: `bindAudioPreferences`
 * plays `override ?? global`, so an assignment masks the operator's global curve
 * (`audio.eq.active`) for the track it applies to and never mutates it. Leaving
 * assigned content is not a restore — the override simply goes null and the
 * global plays again. There is no baseline, no suspension, no swap; the global is
 * only ever what the operator picks in the pane.
 *
 * The one impure thing the pure layers cannot hold lives here: the entity ids (a
 * track carries names, not ids — `library.trackFacets` resolves them).
 *
 * Switching at the boundary rather than mid-track falls out of keying on
 * `nowPlaying`: it is the *audible* track, updated when a track becomes current,
 * so resolving against it applies a new profile as the track starts and never
 * during the crossfade out of the last one.
 */

import { computed, ref, watch, type Ref } from 'vue'
import {
  AUDIO_EQ_PRESETS,
  AUDIO_EQ_PRESET_ID,
  type CascadeScopeRef,
  type SettingCascade,
  type SettingDescriptor,
  type SettingEntityKind,
  type SettingScopeRef
} from '@shared/settings'
import type { EqualizerPreset, EqualizerSpec } from '@shared/audio/equalizer'
import type { ListAlbumsResult, ListArtistsResult, Track } from '@shared/library'
import type { Playlist } from '@shared/playlists'
import { pickAssignedPresetId, resolveEqAssignment, type AssignmentLayer } from './eqAssignment'

/** An entity scope a preset can be assigned at — never global. */
export type AssignmentScope = { kind: 'album' | 'artist' | 'playlist'; id: number }

/** The settings surface the binding reads the cascade and writes overrides through. */
export interface AssignmentSettings {
  get<T>(key: string): T
  set<T>(key: string, value: T): unknown
  cascade<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): SettingCascade<T>
  loadOverrides(scope: SettingScopeRef): Promise<void>
  setOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>,
    value: T
  ): Promise<unknown>
  clearOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): Promise<void>
}

/** The IPC the binding needs to resolve entity ids and display names. */
export interface AssignmentLibrary {
  trackFacets: (trackId: number) => Promise<{ albumId: number | null; artistId: number | null }>
  listAlbums: (query: {
    offset: number
    limit: number
    albumIds: number[]
  }) => Promise<ListAlbumsResult>
  listArtists: (query: {
    offset: number
    limit: number
    artistIds: number[]
  }) => Promise<ListArtistsResult>
  listPlaylists: () => Promise<Playlist[]>
  listAssignments: (key: string) => Promise<{
    assignments: { scope: { kind: SettingEntityKind; id: number }; stored: { value: unknown } }[]
  }>
}

export interface EqAssignmentBindingDeps {
  nowPlaying: Ref<Track | null>
  playingPlaylistId: Ref<number | null>
  settings: AssignmentSettings
  library: AssignmentLibrary
  /**
   * Push the current track's resolved override curve, or null when it carries no
   * assignment. The store wires this to the ref `bindAudioPreferences` layers over
   * the global — the one and only way an assignment reaches the audio.
   */
  applyOverride: (spec: EqualizerSpec | null) => void
}

/** One assignment as the pane lists it: the entity, the preset, and its health. */
export interface AssignmentRow {
  scope: AssignmentScope
  entityName: string
  presetId: string
  /** The assigned preset's name, or null when the id no longer names one. */
  presetName: string | null
  /** The id points at no live preset — the entity plays flat until reassigned. */
  dangling: boolean
}

export interface EqAssignmentBinding {
  /** Every entity assigned a preset, for the pane's list. */
  assignments: Ref<AssignmentRow[]>
  /** Reload the list — the pane calls this on mount and after it mutates one. */
  refreshAssignments: () => Promise<void>
  /** Assign a preset to an entity, or clear its assignment when `presetId` is null. */
  assign: (scope: AssignmentScope, presetId: string | null) => Promise<void>
  /** The preset id currently assigned at an entity, or null — for a menu's check mark. */
  assignedAt: (scope: AssignmentScope) => string | null
}

export function createEqAssignmentBinding(deps: EqAssignmentBindingDeps): EqAssignmentBinding {
  const { nowPlaying, playingPlaylistId, settings, library, applyOverride } = deps

  // The current track's entity ids. A track carries names, so these come from a
  // facets probe and are held here, reset the instant the track changes so a
  // stale album can never resolve against a new track.
  const albumId = ref<number | null>(null)
  const artistId = ref<number | null>(null)

  async function loadScope(scope: SettingScopeRef): Promise<void> {
    await settings.loadOverrides(scope)
  }

  watch(
    () => nowPlaying.value?.id ?? null,
    async (trackId) => {
      albumId.value = null
      artistId.value = null
      if (trackId === null) return
      const facets = await library.trackFacets(trackId)
      // A newer track may have started while the probe was in flight; its watch
      // run owns the ids now, so drop this stale answer.
      if ((nowPlaying.value?.id ?? null) !== trackId) return
      albumId.value = facets.albumId
      artistId.value = facets.artistId
      if (facets.albumId !== null) void loadScope({ kind: 'album', id: facets.albumId })
      if (facets.artistId !== null) void loadScope({ kind: 'artist', id: facets.artistId })
    },
    { immediate: true }
  )

  watch(
    playingPlaylistId,
    (id) => {
      if (id !== null) void loadScope({ kind: 'playlist', id })
    },
    { immediate: true }
  )

  // The resolved assignment for the current track: the cascade, most specific
  // first, mapped to a spec (or a reported dangle) against the live preset list.
  const assignment = computed(() => {
    const layers: AssignmentLayer[] = []
    const probe = (kind: 'album' | 'artist' | 'playlist', id: number | null): void => {
      if (id === null) return
      const resolved = settings.cascade(AUDIO_EQ_PRESET_ID, { kind, id })
      layers.push({ overridden: resolved.overridden, value: resolved.value })
    }
    probe('album', albumId.value)
    probe('artist', artistId.value)
    probe('playlist', playingPlaylistId.value)
    const presets = settings.get<readonly EqualizerPreset[]>(AUDIO_EQ_PRESETS.key)
    return resolveEqAssignment(pickAssignedPresetId(layers), presets)
  })

  // Push the resolved curve as the current track's override whenever the target
  // changes — a new track, a reassignment, a preset edit that moves the assigned
  // curve, or a delete that dangles it. Keyed on the target's *content*, not the
  // `assignment` computed's identity, so it fires exactly when the override the
  // engine should carry actually changes. Null (no assignment, or dangling) means
  // "no override" — the global plays. The master switch and the global curve are
  // not this binding's concern; `bindAudioPreferences` layers this over them.
  const overrideKey = computed(() => {
    const target = assignment.value
    return JSON.stringify([target.spec])
  })
  watch(overrideKey, () => applyOverride(assignment.value.spec), { immediate: true })

  const assignments = ref<AssignmentRow[]>([])

  async function refreshAssignments(): Promise<void> {
    const { assignments: rows } = await library.listAssignments(AUDIO_EQ_PRESET_ID.key)
    const presets = settings.get<readonly EqualizerPreset[]>(AUDIO_EQ_PRESETS.key)

    const albumIds = rows.filter((r) => r.scope.kind === 'album').map((r) => r.scope.id)
    const artistIds = rows.filter((r) => r.scope.kind === 'artist').map((r) => r.scope.id)
    const needsPlaylists = rows.some((r) => r.scope.kind === 'playlist')

    const [albums, artists, playlists] = await Promise.all([
      albumIds.length ? library.listAlbums({ offset: 0, limit: albumIds.length, albumIds }) : null,
      artistIds.length
        ? library.listArtists({ offset: 0, limit: artistIds.length, artistIds })
        : null,
      needsPlaylists ? library.listPlaylists() : null
    ])

    const albumName = new Map(albums?.albums.map((a) => [a.id, a.title]) ?? [])
    const artistName = new Map(artists?.artists.map((a) => [a.id, a.name]) ?? [])
    const playlistName = new Map(playlists?.map((p) => [p.id, p.name]) ?? [])

    const nameFor = (scope: AssignmentScope): string => {
      const found =
        scope.kind === 'album'
          ? albumName.get(scope.id)
          : scope.kind === 'artist'
            ? artistName.get(scope.id)
            : scope.kind === 'playlist'
              ? playlistName.get(scope.id)
              : null
      return found ?? `${scope.kind} #${scope.id}`
    }

    assignments.value = rows.map((row) => {
      // The key cascades only to album/artist/playlist and main filters to that,
      // so every row here is one of those kinds.
      const scope = row.scope as AssignmentScope
      const presetId = String(row.stored.value)
      const preset = presets.find((candidate) => candidate.id === presetId) ?? null
      return {
        scope,
        entityName: nameFor(scope),
        presetId,
        presetName: preset?.name ?? null,
        dangling: preset === null
      }
    })
  }

  async function assign(scope: AssignmentScope, presetId: string | null): Promise<void> {
    if (presetId === null) {
      await settings.clearOverride(AUDIO_EQ_PRESET_ID, scope)
    } else {
      await settings.setOverride(AUDIO_EQ_PRESET_ID, scope, presetId)
    }
    await refreshAssignments()
  }

  function assignedAt(scope: AssignmentScope): string | null {
    // The entity's *own* row, not the inherited value: a menu check mark asks
    // "is a preset set here", which is exactly `overridden`.
    const resolved = settings.cascade(AUDIO_EQ_PRESET_ID, scope)
    return resolved.overridden ? resolved.value : null
  }

  return { assignments, refreshAssignments, assign, assignedAt }
}
