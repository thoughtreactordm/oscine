<script setup lang="ts">
import { computed } from 'vue'
import { panelSettingsSurface } from '@renderer/panels/settings/panelSettings'
import PanelSettingsPopover from '@renderer/panels/settings/PanelSettingsPopover.vue'
import UpNextOverlay from '@renderer/panels/UpNextOverlay.vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * The standing modes and readouts on the right of the transport — shuffle,
 * repeat, the up-next queue, crossfade/levelling, and the Tunedeck toggle —
 * lifted out of `NowPlaying` so the bar and the Zen stage share one cluster.
 *
 * All coupling is through stores: this imports neither the deck nor the queue's
 * owner, which is what lets either be docked elsewhere (D4, D15).
 */
const playback = usePlaybackStore()
const tunedeck = useTunedeckStore()

const playbackSettings = panelSettingsSurface('transport')

/**
 * Names the count as well as the control, so the badge is not the only telling.
 * The *hand-queued* count, and the session depth after it — a badge reading 312
 * after every click is noise, and the state the badge exists to make visible is a
 * statement about the tier the operator built by hand (§5 amendment).
 */
const queueLabel = computed(() => {
  const queued =
    playback.queuedUserCount === 0
      ? 'Up next: nothing queued'
      : playback.queuedUserCount === 1
        ? 'Up next: 1 track queued'
        : `Up next: ${playback.queuedUserCount.toLocaleString()} tracks queued`
  if (playback.queuedSessionCount === 0) return queued
  return `${queued}, ${playback.queuedSessionCount.toLocaleString()} more in this selection`
})

const repeatLabel = computed(() => {
  if (playback.repeatMode === 'all') return 'Repeat: all'
  if (playback.repeatMode === 'one') return 'Repeat: this track'
  return 'Repeat: off'
})
</script>

<template>
  <div class="flex items-center gap-3">
    <!--
      Both are modes, so both announce a state rather than only an action:
      `aria-pressed` for shuffle, which is on or off, and a label that names the
      current mode for repeat, which has three.
    -->
    <UTooltip :text="playback.shuffleEnabled ? 'Shuffle: on' : 'Shuffle: off'">
      <UButton
        variant="ghost"
        size="lg"
        :icon="playback.shuffleEnabled ? 'i-tabler-arrows-shuffle' : 'i-tabler-arrows-right'"
        :color="playback.shuffleEnabled ? 'primary' : 'neutral'"
        :aria-pressed="playback.shuffleEnabled"
        aria-label="Shuffle"
        @click="playback.toggleShuffle()"
      />
    </UTooltip>

    <UTooltip :text="repeatLabel">
      <UButton
        variant="ghost"
        size="lg"
        :icon="playback.repeatMode === 'one' ? 'i-tabler-repeat-once' : 'i-tabler-repeat'"
        :color="playback.repeatMode === 'off' ? 'neutral' : 'primary'"
        :aria-pressed="playback.repeatMode !== 'off'"
        :aria-label="repeatLabel"
        @click="playback.cycleRepeat()"
      />
    </UTooltip>

    <!--
      The queued count is on the transport rather than inside the popover,
      because a non-empty queue changes what Next does and must never be
      invisible. The badge is the count; the popover is what it is. The count is
      the *user* tier — the session tier is always non-empty under a playing
      scope, so badging it would make the badge mean "music is playing".
    -->
    <UPopover :ui="{ content: 'p-0' }">
      <UTooltip :text="queueLabel">
        <UButton
          variant="ghost"
          size="lg"
          icon="i-tabler-list-numbers"
          :color="playback.queuedUserCount > 0 ? 'primary' : 'neutral'"
          :aria-label="queueLabel"
        >
          <UBadge
            v-if="playback.queuedUserCount > 0"
            color="primary"
            variant="solid"
            size="sm"
            class="tabular-nums"
          >
            {{ playback.queuedUserCount.toLocaleString() }}
          </UBadge>
        </UButton>
      </UTooltip>

      <template #content> <UpNextOverlay /> </template>
    </UPopover>

    <!--
      Crossfade and levelling, next to the thing they act on. Both are judged by
      ear against what is playing right now, and a round trip to a settings tab to
      move a slider and back to hear it is how a knob stops being tuned. Generated
      from the same descriptors the settings view draws.
    -->
    <PanelSettingsPopover :surface="playbackSettings" />

    <!--
      A mode, like shuffle above it, so it announces a state rather than only an
      action. The store is the entire coupling: this does not import the deck and
      the deck does not import this, which is what lets either be docked elsewhere
      later (D4, D15).
    -->
    <UTooltip
      :text="
        playback.hasTrack
          ? tunedeck.showing
            ? 'Close Tunedeck'
            : 'Open Tunedeck'
          : 'The Tunedeck needs a track'
      "
    >
      <!--
        Disabled with nothing loaded, because every tab in the deck is a readout
        on a track: opening it onto four empty panes would be the button working
        and the feature not. `showing` rather than `open` for the lit state — the
        operator's standing preference survives an empty transport.
      -->
      <UButton
        variant="ghost"
        size="lg"
        icon="i-tabler-device-audio-tape"
        :color="tunedeck.showing ? 'primary' : 'neutral'"
        :disabled="!playback.hasTrack"
        :aria-pressed="tunedeck.showing"
        aria-label="Tunedeck"
        @click="tunedeck.toggle()"
      />
    </UTooltip>
  </div>
</template>
