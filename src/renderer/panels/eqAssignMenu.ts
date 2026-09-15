/**
 * The "EQ preset" context-menu submenu (W19-6).
 *
 * One builder for the album and artist rows in `Sources` and the playlist rows
 * in `PlaylistRail`, so the three entry points cannot drift. Assigning writes the
 * per-entity `audio.eq.presetId` override through the always-on binding — the
 * same path the EQ pane's list revokes through — so a preset bound here applies
 * itself the next time a track from this entity plays.
 *
 * The check mark reads the entity's own cascade row, which is only known once its
 * overrides have loaded; the builder kicks that load so a re-open is right even
 * when the first paint had to assume "none". Assigning does not depend on it.
 */

import type { ContextMenuItem } from '@nuxt/ui'
import { AUDIO_EQ_PRESETS } from '@shared/settings'
import type { EqualizerPreset } from '@shared/audio/equalizer'
import { useSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import type { AssignmentScope } from '@renderer/playback/eqAssignmentBinding'

export function eqPresetMenuItem(scope: AssignmentScope): ContextMenuItem {
  const settings = useSettings()
  const assignment = usePlaybackStore().equalizerAssignment
  // So a second open reflects a row this build had not fetched yet.
  void settings.loadOverrides(scope)

  const presets = settings.get<readonly EqualizerPreset[]>(AUDIO_EQ_PRESETS.key)
  if (presets.length === 0) {
    return {
      label: 'EQ preset',
      icon: 'i-tabler-adjustments',
      disabled: true
    }
  }

  const current = assignment.assignedAt(scope)
  const children: ContextMenuItem[] = [
    {
      label: 'None',
      icon: current === null ? 'i-tabler-check' : undefined,
      onSelect: () => void assignment.assign(scope, null)
    },
    { type: 'separator' },
    ...presets.map((preset): ContextMenuItem => ({
      label: preset.name,
      icon: current === preset.id ? 'i-tabler-check' : undefined,
      onSelect: () => void assignment.assign(scope, preset.id)
    }))
  ]

  return {
    label: 'EQ preset',
    icon: 'i-tabler-adjustments',
    children
  }
}
