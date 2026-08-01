<script setup lang="ts">
import { tunedeckRegistry } from '@renderer/panels/tunedeck/panes'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * The Tunedeck: a panel island that arranges panes and knows nothing else.
 *
 * D15 calls this "an extended control and information surface opened from
 * NowPlaying", and the temptation is to build it *as* an extension of
 * NowPlaying — reaching into the playback store for a queue, into the track
 * list for a selection. It imports neither, and neither imports it. The only
 * thing crossing the boundary is a boolean in `stores/tunedeck`, which is the
 * same arrangement the sidebar's cover toggle uses.
 *
 * Nothing here is drawer-shaped. There is no scrim, no dismiss gesture, no
 * fixed positioning and no width: the host decides where this sits and how big
 * it is, and this fills what it is given. That is what makes the promotion to a
 * dock pane a change of parent rather than a rewrite, which is the whole reason
 * D4 puts the content in an island in the first place.
 *
 * The panes come from a registry rather than from markup here. A new pane is a
 * component plus a line in `tunedeck/panes.ts`; this file does not change, and
 * that is the seam the card exists to prove.
 */
const tunedeck = useTunedeckStore()
</script>

<template>
  <UCard
    as="aside"
    variant="soft"
    class="h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'flex h-full min-h-0 flex-col p-0 sm:p-0' }"
    aria-label="Tunedeck"
  >
    <header class="flex shrink-0 items-center gap-2 border-b border-default px-3 py-2">
      <UIcon name="i-tabler-device-audio-tape" class="size-4 shrink-0 text-muted" />
      <h2 class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">Tunedeck</h2>
      <UTooltip text="Close Tunedeck">
        <UButton
          variant="ghost"
          size="xs"
          icon="i-tabler-x"
          square
          aria-label="Close Tunedeck"
          @click="tunedeck.close()"
        />
      </UTooltip>
    </header>

    <!--
      The stack scrolls, the header does not. Each pane is given a heading and
      a box and no further opinion — a pane that wants a list virtualizes it
      itself, because a pane is the only thing that knows what it is listing.
    -->
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section
        v-for="pane in tunedeckRegistry.panes"
        :key="pane.id"
        :aria-label="pane.title"
        class="shrink-0 border-b border-default px-3 py-3 last:border-b-0"
      >
        <h3 class="mb-2 flex items-center gap-2 text-xs font-medium uppercase text-dimmed">
          <UIcon :name="pane.icon" class="size-3.5 shrink-0" />
          <span class="min-w-0 truncate">{{ pane.title }}</span>
        </h3>
        <component :is="pane.component" />
      </section>
    </div>
  </UCard>
</template>
