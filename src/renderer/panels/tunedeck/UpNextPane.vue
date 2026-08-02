<script setup lang="ts">
import { computed, ref } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import type { DropSide } from '@renderer/panels/playlistReorder'
import { buildUpNextRows, createQueueReorder } from '@renderer/panels/tunedeck/upNextRows'
import { queueEntryLabel } from '@renderer/playback/queueCommands'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'

/**
 * The up-next queue, as a surface: reorder, remove, clear, jump.
 *
 * D5's transient queue had no visible editor anywhere in the app, and this is
 * it. The pane is the Tunedeck's, but it is not *shaped* like the deck — it has
 * no title, no width and no chrome, so the host supplies the heading and the
 * bounds. That is what lets the play-next overlay render the same component
 * over the transport rather than a second implementation of it, which was the
 * failure mode W5-7 deferred this card to avoid.
 *
 * ## The seven rules, where the pane can show them
 *
 * The acceptance criterion is that §5 is *observable here*, not merely
 * implemented underneath, so four of the rules have a mark on screen:
 *
 * - **Rule 1** — the head carries a "Next" badge. The queue winning over the
 *   playing playlist's own upcoming order is the whole of the first arm, and
 *   with no badge it is a claim the operator has to take on trust.
 * - **Rule 3, and 6** — the two tiers are labelled and counted separately, so
 *   playing something else visibly replaces "Continuing" and leaves "Queued by
 *   you" standing, and toggling shuffle visibly refills the one and not the
 *   other. The session header says "shuffled" when it is.
 * - **Rule 5** — the footnote. A queue that will not survive a restart is
 *   otherwise indistinguishable from one that will until the restart, and rule
 *   5 is a decision rather than an omission.
 * - **Rule 7** — repeat-one suppresses the "Next" badge and says why. This is
 *   the rule with no other symptom: the queue sits there looking exactly as it
 *   does when it is about to play, and does not.
 *
 * Rules 2 and 4 are visible as things that do *not* happen — queueing moves
 * neither the transport nor this pane's ordering, and deleting a playlist
 * leaves its queued rows here — so there is nothing to draw for them.
 *
 * The currently-playing entry never appears: §5 rule 1's shift takes it out of
 * the queue at the moment the advance commits, so the pane lists what is still
 * to come and the playing row is `NowPlaying`'s to show. See `upNextRows` for
 * why the rows are built from the global order rather than the two tiers.
 */

const playback = usePlaybackStore()
const commands = useQueueCommandsStore()

const ROW_PX = 36
const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

const rows = computed(() => buildUpNextRows(playback.queuedEntries))

/** Rule 7 overrides rule 1, so the head is not next while it is on. */
const queueSuspended = computed(() => playback.repeatMode === 'one')

const visible = computed(() =>
  visibleRange({
    total: rows.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => rows.value.slice(visible.value.first, visible.value.last + 1))

const reorder = createQueueReorder(
  () => playback.queuedEntries,
  (entryId, toIndex) => commands.move(entryId, toIndex)
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

/** Which side of the row's midpoint the pointer fell on decides which edge it drops against. */
function sideOf(event: DragEvent, element: HTMLElement): DropSide {
  const box = element.getBoundingClientRect()
  return event.clientY < box.top + box.height / 2 ? 'before' : 'after'
}

function onDragStart(event: DragEvent, entryId: string): void {
  reorder.begin(entryId)
  if (event.dataTransfer === null) return
  event.dataTransfer.effectAllowed = 'move'
  // Chromium cancels a drag that carries no payload at all.
  event.dataTransfer.setData('text/plain', entryId)
}

function onDragOver(event: DragEvent, entryId: string): void {
  const element = event.currentTarget
  if (!(element instanceof HTMLElement)) return
  // Claimed only when this pane started the drag, so a track selection dragged
  // in from the library falls through rather than being read as a reorder.
  if (!reorder.over(entryId, sideOf(event, element))) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
}
</script>

<template>
  <!--
    `h-full` is what makes the pane fill a host that has a height and stop
    growing at `max-h-112` in one that does not. The deck stacks it in a section
    sized by its content, so the ceiling is what bounds it there; the popover
    gives it a definite height, and without this the scroller would take its
    full 448 inside a 332px box and clip the footnote off the bottom — which is
    the one line rule 5 has.
  -->
  <div class="flex h-full min-h-0 flex-col gap-1.5">
    <div v-if="playback.queuedCount > 0" class="flex shrink-0 items-center gap-2">
      <span class="text-xs tabular-nums text-muted">
        {{ playback.queuedCount.toLocaleString() }} queued
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
        class="ml-auto"
        @click="commands.clearUser()"
      />
    </div>

    <!--
      §5 rule 7, said out loud. Repeat-one overrides everything including the
      queue, and the only symptom without this line is a queue that sits there
      looking ready and never advances into.
    -->
    <p
      v-if="queueSuspended && playback.queuedCount > 0"
      class="flex shrink-0 items-center gap-1.5 rounded-sm bg-elevated px-2 py-1 text-xs text-muted"
    >
      <UIcon name="i-tabler-repeat-once" class="size-3.5 shrink-0 text-primary" />
      <span>Repeat one is on — nothing here plays until it is off.</span>
    </p>

    <!--
      One scroll container, two spacers, and only the rows between them. The
      queue is in memory, so the whole of the virtualization is the padding —
      the session tier alone can be thousands of rows, and the standing
      invariant has no exception for a pane that is usually short.
    -->
    <div
      v-if="rows.length > 0"
      :ref="measure"
      class="max-h-112 min-h-0 flex-1 overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
      @dragend="reorder.end()"
    >
      <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />
      <ul class="m-0 list-none p-0">
        <li
          v-for="row in drawn"
          :key="row.key"
          class="group relative flex items-center gap-1.5"
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
            <span
              v-if="row.origin === 'session' && playback.shuffleEnabled"
              class="shrink-0 text-xs text-dimmed"
            >
              shuffled
            </span>
            <span class="shrink-0 text-xs tabular-nums text-dimmed">
              {{ row.count.toLocaleString() }}
            </span>
          </template>

          <template v-else>
            <div
              class="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 transition-colors"
              :class="[
                reorder.dragId.value === row.entry.id
                  ? 'opacity-50'
                  : 'hover:bg-elevated/60 focus-within:bg-elevated/60',
                reorder.indicator(row.entry.id) === 'before'
                  ? 'shadow-[inset_0_2px_0_0_var(--ui-primary)]'
                  : reorder.indicator(row.entry.id) === 'after'
                    ? 'shadow-[inset_0_-2px_0_0_var(--ui-primary)]'
                    : ''
              ]"
              draggable="true"
              @dragstart="onDragStart($event, row.entry.id)"
              @dragover="onDragOver($event, row.entry.id)"
              @drop.prevent="reorder.drop()"
              @dragend="reorder.end()"
            >
              <UIcon
                name="i-tabler-grip-vertical"
                class="size-3.5 shrink-0 cursor-grab text-dimmed opacity-0 group-hover:opacity-100"
                aria-hidden="true"
              />
              <span class="w-4 shrink-0 text-right text-xs tabular-nums text-dimmed">
                {{ row.position }}
              </span>
              <!--
                The row is the jump. A queued entry is something to play, and
                double-click rather than click because the pane is also a list
                being dragged around — a single click that started audio would
                fire on every failed grab.
              -->
              <button
                type="button"
                class="min-w-0 flex-1 cursor-default truncate text-left text-sm text-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
                :title="queueEntryLabel(row.entry)"
                @dblclick="commands.jumpTo(row.entry.id)"
                @keydown.enter="commands.jumpTo(row.entry.id)"
              >
                {{ row.entry.track.title }}
                <span v-if="row.entry.track.artist !== null" class="text-muted">
                  · {{ row.entry.track.artist }}
                </span>
              </button>
              <!--
                §5 rule 1's first arm: the queue head is what plays next, ahead
                of the playing playlist's own upcoming order. Withdrawn under
                repeat-one, which is rule 7 overriding it.
              -->
              <UBadge
                v-if="row.isNext && !queueSuspended"
                label="Next"
                size="sm"
                color="primary"
                variant="subtle"
                class="shrink-0"
              />
              <UButton
                icon="i-tabler-x"
                size="xs"
                color="neutral"
                variant="ghost"
                class="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                :aria-label="`Remove ${row.entry.track.title} from the queue`"
                @click="commands.remove(row.entry.id)"
              />
            </div>
          </template>
        </li>
      </ul>
      <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
    </div>

    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      Nothing queued. Use <span class="text-default">Play next</span> or
      <span class="text-default">Add to queue</span> on any selection.
    </p>

    <!--
      §5 rule 5, which is a decision and not an omission: playlists persist and
      the queue does not. Said here because it is otherwise indistinguishable
      from a bug, and only when there is something to lose.
    -->
    <p v-if="playback.queuedCount > 0" class="shrink-0 text-xs text-dimmed">
      The queue empties when Fermata quits.
    </p>
  </div>
</template>
