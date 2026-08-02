<script setup lang="ts">
import { computed, ref } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import type { DropSide } from '@renderer/panels/playlistReorder'
import {
  buildUpNextRows,
  createQueueReorder,
  type UpNextRow
} from '@renderer/panels/tunedeck/upNextRows'
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

/** Which row is visibly being dragged. Trails `reorder.dragId` — see `onDragStart`. */
const dragging = ref<string | null>(null)

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
 * Which row a drag is over, and which of its edges.
 *
 * **The whole row, and every pixel of it.** The first version hung the drag off
 * an inner box that `items-center` kept at 24px inside a 36px row, which left a
 * six-pixel dead band above and below every entry — a twelve-pixel gutter
 * between neighbours where `dragover` reached no handler, so nothing called
 * `preventDefault` and Chromium refused the drop outright. That gutter is
 * precisely where a hand aims when dropping *between* two rows, so a third of
 * the list swallowed drops and the gesture read as flaky rather than as broken.
 * The row is the drag surface now, and rows are contiguous.
 *
 * A tier label is a row too, and resolves to the first entry of the tier it
 * labels, for the same reason: no band of the list may do nothing.
 */
function targetOf(event: DragEvent, row: UpNextRow): { id: string; side: DropSide } | null {
  const element = event.currentTarget
  if (!(element instanceof HTMLElement)) return null
  if (row.kind === 'header') return { id: row.firstId, side: 'before' }

  const box = element.getBoundingClientRect()
  return { id: row.entry.id, side: event.clientY < box.top + box.height / 2 ? 'before' : 'after' }
}

function onDragStart(event: DragEvent, row: UpNextRow): void {
  if (row.kind !== 'entry') return
  reorder.begin(row.entry.id)
  // Deferred a frame because Chromium snapshots the drag image from the element
  // as it stands when this handler returns; dimming it here would dim the ghost
  // the operator is carrying rather than the row it came from.
  requestAnimationFrame(() => {
    dragging.value = reorder.dragId.value
  })
  if (event.dataTransfer === null) return
  event.dataTransfer.effectAllowed = 'move'
  // Chromium cancels a drag that carries no payload at all.
  event.dataTransfer.setData('text/plain', row.entry.id)
}

function onDragOver(event: DragEvent, row: UpNextRow): void {
  const target = targetOf(event, row)
  if (target === null) return
  // Claimed only when this pane started the drag, so a track selection dragged
  // in from the library falls through rather than being read as a reorder.
  if (!reorder.over(target.id, target.side)) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
}

function onDragEnd(): void {
  reorder.end()
  dragging.value = null
}

function activate(row: UpNextRow): void {
  if (row.kind === 'entry') commands.jumpTo(row.entry.id)
}

function isDragging(row: UpNextRow): boolean {
  return row.kind === 'entry' && dragging.value === row.entry.id
}

/**
 * A tier label never draws the edge itself.
 *
 * A drag over one resolves to "before the first entry of that tier", so the
 * line belongs on the top of that entry — which is the row immediately below
 * the label, and therefore exactly where the drop is about to happen.
 */
function indicatorFor(row: UpNextRow): DropSide | null {
  return row.kind === 'entry' ? reorder.indicator(row.entry.id) : null
}
</script>

<template>
  <!--
    `h-full` is what makes the pane fill the host it is given. Both hosts now
    give it a definite height — the popover a fixed one, the deck's accordion
    the whole of what the shut groups leave — so the `max-h-112` ceiling that
    used to sit on the scroller is gone. It was there for the old deck, which
    stacked every pane in a column sized by its content; under the accordion it
    stopped being a safety net and became a 448px cap with dead space under it.
  -->
  <div class="flex h-full min-h-0 flex-col gap-1.5">
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
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
      @dragend="reorder.end()"
    >
      <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />
      <ul class="m-0 list-none p-0">
        <!--
          Every handler is on the row, and the row is the full `ROW_PX`. Rows are
          contiguous, so there is nowhere in the list a drag can be that is not
          over exactly one of them — see `targetOf` for what the earlier
          arrangement cost.
        -->
        <li
          v-for="row in drawn"
          :key="row.key"
          class="group relative flex cursor-default items-center gap-1.5 rounded-sm px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :style="{ height: `${ROW_PX}px` }"
          :class="[
            isDragging(row) ? 'opacity-50' : row.kind === 'entry' ? 'hover:bg-elevated/60' : '',
            indicatorFor(row) === 'before'
              ? 'shadow-[inset_0_2px_0_0_var(--ui-primary)]'
              : indicatorFor(row) === 'after'
                ? 'shadow-[inset_0_-2px_0_0_var(--ui-primary)]'
                : ''
          ]"
          :draggable="row.kind === 'entry'"
          :tabindex="row.kind === 'entry' ? 0 : -1"
          :title="row.kind === 'entry' ? queueEntryLabel(row.entry) : undefined"
          @dragstart="onDragStart($event, row)"
          @dragover="onDragOver($event, row)"
          @drop.prevent="reorder.drop()"
          @dragend="onDragEnd()"
          @dblclick="activate(row)"
          @keydown.enter="activate(row)"
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
            <UIcon
              name="i-tabler-grip-vertical"
              class="size-3.5 shrink-0 cursor-grab text-dimmed opacity-0 group-hover:opacity-100"
              aria-hidden="true"
            />
            <span class="w-4 shrink-0 text-right text-xs tabular-nums text-dimmed">
              {{ row.position }}
            </span>
            <!--
              The row is the jump, on double-click rather than click, because it
              is also the thing being dragged around — a single click that
              started audio would fire on every failed grab. Plain text and not
              a nested button: a control inside the drag surface is one more
              thing that has to agree about who owns the gesture.
            -->
            <span class="min-w-0 flex-1 truncate text-sm text-default">
              {{ row.entry.track.title }}
              <span v-if="row.entry.track.artist !== null" class="text-muted">
                · {{ row.entry.track.artist }}
              </span>
            </span>
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
          </template>
        </li>
      </ul>
      <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
    </div>

    <!--
      The empty state stays prose, because when it shows it *is* the pane —
      it is the answer, not a caption on one. §5 rule 5 (the queue does not
      survive a quit) used to be a standing line under the list here; it is now
      the tooltip on the deck's "Up next" header, which is where a fact about
      the feature belongs rather than under every row of it.
    -->
    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      Nothing queued. Use <span class="text-default">Play next</span> or
      <span class="text-default">Add to queue</span> on any selection.
    </p>
  </div>
</template>
