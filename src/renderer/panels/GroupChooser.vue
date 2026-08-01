<script setup lang="ts">
import PanelSettingsPopover from '@renderer/panels/settings/PanelSettingsPopover.vue'
import { panelSettingsSurface } from '@renderer/panels/settings/panelSettings'
import { useTrackGroupingStore } from '@renderer/stores/grouping'

/**
 * Album grouping, from the toolbar. One preference, wherever it is mounted.
 *
 * The two knobs in here — whether to group and how large the sleeves are — are
 * registry keys with descriptors, so as of W8-8 this draws them rather than
 * writing them out. It used to hand-letter its own: "Group by album" against the
 * descriptor's "Group tracks by album", "Sleeve size" against "Album header
 * artwork". Nothing was wrong with either phrasing; what was wrong is that there
 * were two of them, and the second one only changes when somebody remembers it
 * exists. Now the popover is a projection of the same descriptors the settings
 * view renders, each row links through to its place there, and each carries the
 * revert the hand-written "Reset" button used to approximate.
 *
 * Grouping only has anything to draw under an album-major ordering — under any
 * other column the albums interleave and there are no runs — so the popover says
 * as much rather than leaving a switch that appears to do nothing. The setting
 * itself stays live either way: turning it on while sorted by Title is a
 * statement about what to do once the list is sorted by album, not a no-op to be
 * swallowed.
 *
 * Whether *this* list can be grouped is a prop rather than something read out of
 * a store, and that is the island rule doing real work: this used to ask
 * `trackList` — the library's song list — which was invisibly wrong the moment
 * the chooser appeared over a second list. The playlist contents pane is always
 * groupable, because turning it on re-sorts the pane rather than waiting for a
 * column that pane does not have.
 */
const grouping = useTrackGroupingStore()

withDefaults(
  defineProps<{
    /** Whether the list this sits over has runs to head right now. */
    groupable: boolean
    /** Shown when it does not, to say what would make it groupable. */
    hint?: string
  }>(),
  { hint: undefined }
)

const surface = panelSettingsSurface('track-grouping')
</script>

<template>
  <PanelSettingsPopover
    :surface="surface"
    :active="grouping.enabled && groupable"
    :hint="groupable ? undefined : hint"
  />
</template>
