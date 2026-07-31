<script setup lang="ts">
import { computed, ref } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import { queueEntryLabel } from '@renderer/playback/queueCommands'
import type { QueueEntry } from '@renderer/playback/upNextQueue'
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
 *
 * ## The two tiers (§5 amendment)
 *
 * The rows come in two kinds and the surface has to say which is which: a
 * hand-queued row is a promise the operator made, and a session row is the
 * scope they are playing through, made visible. Drawn as one scroll container
 * with a header row per tier rather than two lists, because the session tier is
 * the first queue that can genuinely be thousands of rows and two virtualized
 * containers in one popover would be two scroll positions to reconcile. The
 * headers are ordinary rows of the same height, so the arithmetic is unchanged.
 */

const playback = usePlaybackStore()
const commands = useQueueCommandsStore()

const ROW_PX = 36
const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

/** A tier label, or a queued row with its position within its own tier. */
type Row =
  | {
      readonly kind: 'header'
      readonly key: string
      readonly label: string
      readonly count: number
    }
  | {
      readonly kind: 'entry'
      readonly key: string
      readonly entry: QueueEntry
      readonly position: number
    }

const rows = computed<Row[]>(() => {
  const built: Row[] = []
  const tiers = [
    { key: 'user', label: 'Queued by you', entries: playback.queuedUserEntries },
    { key: 'session', label: 'Continuing', entries: playback.queuedSessionEntries }
  ]
  for (const tier of tiers) {
    if (tier.entries.length === 0) continue
    built.push({
      kind: 'header',
      key: `h:${tier.key}`,
      label: tier.label,
      count: tier.entries.length
    })
    // Numbered within the tier: "3 of the ones I queued" is what the operator
    // is counting, and a session row's number is its place in the scope.
    tier.entries.forEach((entry, index) =>
      built.push({ kind: 'entry', key: entry.id, entry, position: index + 1 })
    )
  }
  return built
})

const window = computed(() =>
  visibleRange({
    total: rows.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => rows.value.slice(window.value.first, window.value.last + 1))

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
      <!--
        Clears the hand-queued rows and not the scope. The session tier is not
        the operator's to lose — it comes back on the next click, so a Clear
        that wiped it would be a button that undoes nothing it did.
      -->
      <UButton
        v-if="playback.queuedUserCount > 0"
        label="Clear"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="commands.clearUser()"
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
          :key="row.key"
          class="group flex items-center gap-2 px-2"
          :style="{ height: `${ROW_PX}px` }"
        >
          <!--
            A tier label is a row like any other, which is what keeps one set of
            virtualization arithmetic over both tiers.
          -->
          <template v-if="row.kind === 'header'">
            <span class="flex-1 truncate text-xs font-semibold uppercase tracking-wide text-dimmed">
              {{ row.label }}
            </span>
            <span class="shrink-0 text-xs tabular-nums text-dimmed">
              {{ row.count.toLocaleString() }}
            </span>
          </template>

          <!--
            The row is the jump: a queued entry is something to play, and the
            count in front of it is where it sits in its tier rather than
            decoration.
          -->
          <template v-else>
            <UButton
              color="neutral"
              variant="ghost"
              class="min-w-0 flex-1 justify-start gap-2 text-left"
              :title="queueEntryLabel(row.entry)"
              @click="commands.jumpTo(row.entry.id)"
            >
              <span class="w-5 shrink-0 text-right text-xs tabular-nums text-dimmed">
                {{ row.position }}
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
          </template>
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
