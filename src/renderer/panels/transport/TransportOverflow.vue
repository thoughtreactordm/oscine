<script setup lang="ts">
import NowPlayingActions from '@renderer/panels/transport/NowPlayingActions.vue'
import PlaybackModeButtons from '@renderer/panels/transport/PlaybackModeButtons.vue'
import VolumeControl from '@renderer/panels/transport/VolumeControl.vue'

/**
 * The transport's flanking controls, folded into one popover for when the bar is
 * too narrow to lay them out in a row (§1).
 *
 * The same shared `panels/transport/*` islands the bar and the Zen stage compose
 * inline when there is room — relocated, not duplicated. There is a single
 * instance of each, so `VolumeControl`'s window pointer listeners and
 * `PlaybackModeButtons`' nested popovers keep working; they are simply mounted
 * here instead of in the row. Both the bar and the stage render this behind a
 * `compact` flag, so the fold is defined once for the two surfaces.
 */
</script>

<template>
  <UPopover :ui="{ content: 'p-0' }">
    <UTooltip text="More controls">
      <UButton
        variant="ghost"
        size="lg"
        icon="i-tabler-dots"
        color="neutral"
        aria-label="More controls"
      />
    </UTooltip>

    <template #content>
      <div class="flex flex-col gap-3 p-3">
        <div class="flex items-center justify-between gap-4">
          <VolumeControl />
          <NowPlayingActions />
        </div>
        <div class="flex justify-center border-t border-default pt-3">
          <PlaybackModeButtons />
        </div>
      </div>
    </template>
  </UPopover>
</template>
