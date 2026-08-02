<script setup lang="ts">
import UpNextPane from '@renderer/panels/tunedeck/UpNextPane.vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'

/**
 * What is queued, over the transport.
 *
 * A title and a box, and the queue itself is `UpNextPane` — the same component
 * the Tunedeck stacks. W5-7 built this overlay's body and said W7-2 would
 * replace it with the deck's pane; this is that replacement, and the point of
 * making it a replacement rather than an addition is that there is now exactly
 * one virtualized queue list, one set of tier labels and one reorder gesture in
 * the app. Two would have drifted, and the drift would have been §5 wording.
 *
 * All that is left here is the popover's own frame: a heading, a width, and a
 * height. The pane fills what it is given and has no opinion about any of the
 * three, which is what let it be reparented into the deck in the first place.
 *
 * Clear is the host's, and this is the second host to have to draw it. The pane
 * used to carry it as a right-aligned button on a row of its own — 28px of
 * mostly empty space above the list, in both hosts. It moved out to the chrome:
 * the deck puts it on the group header, and this puts it here, because a title
 * bar that already has a heading and a count has room for a third thing and the
 * list does not.
 *
 * The height is **definite and not a `max-h`**, which is the one thing here that
 * is not arbitrary. A column sized by its content gives its children no height
 * to resolve against, so the pane's list would take its own ceiling, overflow
 * this box and have rule 5's footnote clipped off the bottom — a popover that is
 * visibly the right size and quietly a hundred pixels taller than it looks. Only
 * once there is something to show: an empty queue is two lines and should not
 * open a fixed pane of nothing.
 */

const playback = usePlaybackStore()
const commands = useQueueCommandsStore()
</script>

<template>
  <div class="flex w-80 flex-col" :class="playback.queuedCount > 0 ? 'h-96' : ''">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default px-3">
      <UIcon name="i-tabler-playlist" class="size-4 text-primary" />
      <h2 class="text-sm font-semibold text-highlighted">Up next</h2>
      <span class="ml-auto text-xs tabular-nums text-muted">
        {{ playback.queuedUserCount.toLocaleString() }}
      </span>
      <!--
        Hand-queued rows only, matching the count beside it. The session tier
        comes back on the next click, so clearing it would be a button that
        undoes nothing it did.
      -->
      <UTooltip v-if="playback.queuedUserCount > 0" text="Clear the queue">
        <UButton
          variant="ghost"
          size="xs"
          icon="i-tabler-eraser"
          square
          class="-mr-1 shrink-0 text-dimmed"
          aria-label="Clear the queue"
          @click="commands.clearUser()"
        />
      </UTooltip>
    </div>

    <div class="min-h-0 flex-1 overflow-hidden px-3 py-2">
      <UpNextPane />
    </div>
  </div>
</template>
