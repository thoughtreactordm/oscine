<script setup lang="ts">
import CoverArt from '@renderer/panels/CoverArt.vue'
import { useShellStore } from '@renderer/stores/shell'

/**
 * The sidebar container: fixed furniture, changeable contents.
 *
 * What sits in the slot belongs to whichever tab is showing. What sits below it
 * does not — the cover pane is frame chrome, toggled from the transport bar,
 * and it stays put across a tab change so the record on screen does not blink
 * out because the user went looking at playlists.
 *
 * Read-only on the flag, like the panel it replaces: this is a mount point and
 * a collapse animation, and everything about what is drawn belongs to
 * `CoverArt`.
 */
const shell = useShellStore()
</script>

<template>
  <UCard
    as="aside"
    variant="soft"
    class="h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'flex h-full min-h-0 flex-col p-0 sm:p-0' }"
    aria-label="Sidebar"
  >
    <div class="flex min-h-0 flex-1 flex-col">
      <slot />
    </div>

    <Transition name="coverSlot">
      <div v-if="shell.coverExpanded" class="cover-slot shrink-0">
        <div class="cover-slot-inner">
          <CoverArt />
        </div>
      </div>
    </Transition>
  </UCard>
</template>

<style scoped>
/*
 * `0fr` → `1fr` rather than a height transition: the pane's height depends on
 * the sidebar's width, so there is no pixel value to animate to that would
 * still be right after a resize. The grid row is the measurement.
 */
.cover-slot {
  display: grid;
  grid-template-rows: 1fr;
}

.cover-slot-inner {
  min-height: 0;
  overflow: hidden;
}

.coverSlot-enter-active,
.coverSlot-leave-active {
  transition: grid-template-rows 260ms ease;
}

.coverSlot-enter-from,
.coverSlot-leave-to {
  grid-template-rows: 0fr;
}

@media (prefers-reduced-motion: reduce) {
  .coverSlot-enter-active,
  .coverSlot-leave-active {
    transition-duration: 0ms;
  }
}
</style>
