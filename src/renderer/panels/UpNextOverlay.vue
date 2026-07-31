<script setup lang="ts">
import { computed, ref } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import { queueEntryLabel } from '@renderer/playback/queueCommands'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * What is queued, over the transport.
 *
 * Deliberately the smaller surface. M5's Tunedeck (D15) owns the real up-next
 * editor and W7-2 replaces this body with it; building that editor twice is the
 * failure mode this card exists to avoid, so there is no reordering here and the
 * verbs it does have come from `queueCommands` rather than from this file.
 *
 * Virtualized, because the standing invariant has no exception for popovers — a
 * queue is as easily a thousand rows as three. The queue is already in memory,
 * so this needs the arithmetic and none of `trackWindow`: see `listViewport`.
 */

const playback = usePlaybackStore()
const commands = useQueueCommandsStore()

const ROW_PX = 36
const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

const entries = computed(() => playback.queuedEntries)

const window = computed(() =>
  visibleRange({
    total: entries.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() =>
  entries.value.slice(window.value.first, window.value.last + 1).map((entry, offset) => ({
    entry,
    index: window.value.first + offset
  }))
)

function onScroll(): void {
  const element = list.value
  if (element === null) return
  scrollTop.value = element.scrollTop
  viewportPx.value = element.clientHeight
}

function measure(element: unknown): void {
  list.value = element instanceof HTMLElement ? element : null
  if (list.value !== null) viewportPx.value = list.value.clientHeight
}
</script>

<template>
  <div class="flex max-h-80 w-80 flex-col">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default px-3">
      <UIcon name="i-tabler-playlist" class="size-4 text-primary" />
      <h2 class="text-sm font-semibold text-highlighted">Up next</h2>
      <span class="ml-auto text-xs tabular-nums text-muted">
        {{ playback.queuedCount.toLocaleString() }}
      </span>
      <UButton
        v-if="playback.queuedCount > 0"
        label="Clear"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="commands.clear()"
      />
    </div>

    <!--
      One scroll container, two spacers, and only the rows between them. The
      queue is in memory, so the whole of the virtualization is the padding.
    -->
    <div
      v-if="playback.queuedCount > 0"
      :ref="measure"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
    >
      <div :style="{ height: `${window.topPx}px` }" aria-hidden="true" />
      <ul class="m-0 list-none p-0">
        <li
          v-for="row in drawn"
          :key="row.entry.id"
          class="group flex items-center gap-2 px-2"
          :style="{ height: `${ROW_PX}px` }"
        >
          <!--
            The row is the jump: a queued entry is something to play, and the
            count in front of it is where it sits in the queue rather than
            decoration.
          -->
          <UButton
            color="neutral"
            variant="ghost"
            class="min-w-0 flex-1 justify-start gap-2 text-left"
            :title="queueEntryLabel(row.entry)"
            @click="commands.jumpTo(row.entry.id)"
          >
            <span class="w-5 shrink-0 text-right text-xs tabular-nums text-dimmed">
              {{ row.index + 1 }}
            </span>
            <span class="min-w-0 flex-1 truncate text-sm text-default">
              {{ row.entry.track.title }}
            </span>
          </UButton>
          <UButton
            icon="i-tabler-x"
            size="xs"
            color="neutral"
            variant="ghost"
            class="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            :aria-label="`Remove ${row.entry.track.title} from the queue`"
            @click="commands.remove(row.entry.id)"
          />
        </li>
      </ul>
      <div :style="{ height: `${window.bottomPx}px` }" aria-hidden="true" />
    </div>

    <p v-else class="px-3 py-6 text-center text-xs text-muted">
      Nothing queued. Use <span class="text-default">Play next</span> or
      <span class="text-default">Add to queue</span> on any selection.
    </p>
  </div>
</template>
