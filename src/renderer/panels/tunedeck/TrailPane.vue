<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import { buildTrailRows, type TrailRow } from '@renderer/panels/tunedeck/playTrail'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlayHistoryStore } from '@renderer/stores/playHistory'

/**
 * The play-history trail: what has been played, newest first, with jump-back.
 *
 * This is what makes the deck a session view rather than a track inspector. The
 * up-next pane above it says what is about to happen and this says what did,
 * and between them the deck describes a listening session rather than a file.
 *
 * ## Jump-back is a detour
 *
 * Double-clicking a row plays that track *out of turn* and leaves everything
 * else exactly where it was — see `controller.replay`. That is §5 rule 1's
 * first arm and nothing else: the playing playlist, the order, the anchor and
 * both queue tiers are untouched, and when the replayed track ends, playback
 * resumes at the row it interrupted. The pane says so in its footnote, because
 * "go back" could as easily have meant "re-enter what I was playing then", and
 * an operator with a queue they have spent ten minutes building deserves to
 * know which one this is before they click.
 *
 * The head row is the audible track — a play is recorded when the transport
 * commits to it, so the trail's newest row is always what is playing — and is
 * marked rather than offered as a jump-back to itself.
 */

const playback = usePlaybackStore()
const trail = usePlayHistoryStore()

const ROW_PX = 36
/** Coarser than the labels' own resolution, so a "now" ages into "1 min" late rather than never. */
const TICK_MS = 30_000

const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

/**
 * The clock the relative labels are read against.
 *
 * A ref rather than `Date.now()` inside the computed, because the latter is not
 * a reactive dependency: the labels would freeze at whatever they said when the
 * trail last changed, which between two tracks is four minutes of a row
 * insisting it played "now". The interval only runs while the pane is mounted.
 */
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  // The one read of the trail per app run. Deferred to here rather than done at
  // store creation: the deck is shut on most launches, and this is five hundred
  // display rows.
  void trail.load()
  tick = setInterval(() => {
    now.value = Date.now()
  }, TICK_MS)
})

onBeforeUnmount(() => {
  if (tick !== null) clearInterval(tick)
  tick = null
})

const rows = computed(() =>
  buildTrailRows({
    entries: trail.entries,
    nowPlayingId: playback.nowPlaying?.id ?? null,
    now: now.value
  })
)

const visible = computed(() =>
  visibleRange({
    total: rows.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => rows.value.slice(visible.value.first, visible.value.last + 1))

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

/**
 * Double-click, matching the up-next pane and the playlist rail.
 *
 * The audible row is not a jump-back target: replaying it would restart the
 * track under the operator's hands, which is not what clicking the thing marked
 * "Playing" asks for.
 */
function activate(row: TrailRow): void {
  if (row.isPlaying) return
  void playback.replay(row.entry.track)
}

function rowLabel(row: TrailRow): string {
  const track = row.entry.track
  return track.artist === null ? track.title : `${track.artist} — ${track.title}`
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-1.5">
    <!--
      Virtualized from the first commit, per the standing invariant. The trail
      is in memory and bounded by `PLAY_HISTORY_CAP`, so — as with the up-next
      pane — the whole of the virtualization is the two spacers.
    -->
    <div
      v-if="rows.length > 0"
      :ref="measure"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
    >
      <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />
      <ul class="m-0 list-none p-0">
        <li
          v-for="row in drawn"
          :key="row.key"
          class="group relative flex cursor-default items-center gap-1.5 rounded-sm px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :class="row.isPlaying ? '' : 'hover:bg-elevated/60'"
          :style="{ height: `${ROW_PX}px` }"
          :tabindex="row.isPlaying ? -1 : 0"
          :title="rowLabel(row)"
          @dblclick="activate(row)"
          @keydown.enter="activate(row)"
        >
          <UIcon
            :name="row.isPlaying ? 'i-tabler-volume' : 'i-tabler-corner-up-left'"
            class="size-3.5 shrink-0"
            :class="
              row.isPlaying ? 'text-primary' : 'text-dimmed opacity-0 group-hover:opacity-100'
            "
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-sm text-default">
            {{ row.entry.track.title }}
            <span v-if="row.entry.track.artist !== null" class="text-muted">
              · {{ row.entry.track.artist }}
            </span>
          </span>
          <!--
            Consecutive replays are one row. The count is the only thing that
            says an hour of repeat-one was an hour rather than a single play.
          -->
          <UBadge
            v-if="row.plays > 1"
            :label="`×${row.plays}`"
            size="sm"
            color="neutral"
            variant="subtle"
            class="shrink-0"
          />
          <span
            v-if="row.isPlaying"
            class="shrink-0 text-xs font-medium uppercase tracking-wide text-primary"
          >
            Playing
          </span>
          <span v-else class="w-10 shrink-0 text-right text-xs tabular-nums text-dimmed">
            {{ row.when }}
          </span>
        </li>
      </ul>
      <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
    </div>

    <!--
      The empty state stays prose: when it shows it is the pane's whole content,
      not a caption on it. Which of the two readings of "go back" a double-click
      is — it cuts in, then playback resumes where it was — moved to the tooltip
      on the deck's "Trail" header. It is a fact about the gesture, and it was
      being restated under the list on every render.
    -->
    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      Nothing played yet. Everything you play lands here, newest first.
    </p>
  </div>
</template>
