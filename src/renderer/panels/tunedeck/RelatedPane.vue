<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { RelatedStrand } from '@shared/related'
import { visibleRange } from '@renderer/panels/listViewport'
import { buildRelatedRows, type RelatedRow } from '@renderer/panels/tunedeck/relatedRows'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useRelatedStore } from '@renderer/stores/related'

/**
 * What else in the library connects to what is playing (W7-5).
 *
 * The deck's third dimension. Up-next says what happens next, the trail says
 * what already did, and this says what the current track sits *among* — which
 * is the axis that turns a player into a way of getting back into a library you
 * stopped being able to hold in your head.
 *
 * ## Two halves, and the pane says which is which
 *
 * The catalog strands are derived from identity: this album, this artist's
 * records, the compilations they turn up on. The neighbourhood strands are
 * derived from coincidence — a shared genre string, a shared year, a shared
 * parent folder — and any of the three can be an accident of how the files were
 * tagged or downloaded. They appear under their own heading, below, with the
 * reason stated once. Ranking them into a single list would have implied a
 * confidence the weaker half has not earned.
 *
 * ## Local only
 *
 * Nothing here reaches the network, and in phase 1 there is nothing to reach.
 * The MusicBrainz artist-relations pane is a different notion of "related" —
 * a claim about the world rather than about these files — and it lands in M7 on
 * its own channel.
 *
 * ## Queueing, not jumping
 *
 * Double-click adds to the end of the up-next queue rather than playing. This
 * is a browsing surface: the operator is reading it *while* something plays,
 * and a pane where a stray double-click cuts off the current track is one they
 * will stop opening. Enqueueing is the non-destructive verb, and the footnote
 * says so before anyone has to find out.
 */

const playback = usePlaybackStore()
const related = useRelatedStore()

const ROW_PX = 36

const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

/** The album whose contents are in flight, so a second double-click is ignored. */
const busyAlbumId = ref<number | null>(null)

const STRAND_ICONS: Record<RelatedStrand, string> = {
  'album-tracks': 'i-tabler-disc',
  'artist-albums': 'i-tabler-microphone-2',
  compilations: 'i-tabler-users',
  genre: 'i-tabler-tag',
  year: 'i-tabler-calendar',
  folder: 'i-tabler-folder'
}

/**
 * The seed follows the transport.
 *
 * `immediate`, because the deck is opened mid-track far more often than it is
 * open at the moment one starts — without it the pane would be blank until the
 * next track change, which reads as broken rather than as loading.
 */
watch(
  () => playback.nowPlaying?.id ?? null,
  (trackId) => void related.load(trackId),
  { immediate: true }
)

onMounted(() => {
  // The watcher above covers the seed, but not the case where the pane is
  // remounted while the same track is still playing and a previous mount's
  // query failed. Cheap, and it makes a transient failure self-healing.
  if (related.failed) void related.refresh()
})

const rows = computed(() => buildRelatedRows(related.result))

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

/** Only the two row kinds that stand for something playable are interactive. */
function isActivatable(row: RelatedRow): boolean {
  return row.kind === 'track' || row.kind === 'album'
}

async function activate(row: RelatedRow): Promise<void> {
  if (row.kind === 'track') {
    playback.enqueue([row.track])
    return
  }
  if (row.kind !== 'album') return
  if (busyAlbumId.value !== null) return

  busyAlbumId.value = row.album.albumId
  try {
    const tracks = await related.albumTracks(row.album.albumId)
    // An album that emptied between the query and the click enqueues nothing
    // rather than an empty run, which the queue would otherwise record as a
    // no-op the operator cannot see or undo.
    if (tracks.length > 0) playback.enqueue(tracks)
  } catch {
    // Same reasoning as the store's: a discovery pane may not throw into the
    // transport. The row simply does not queue, and the next click retries.
  } finally {
    busyAlbumId.value = null
  }
}

function rowTitle(row: RelatedRow): string {
  if (row.kind === 'track') {
    return row.track.artist === null ? row.track.title : `${row.track.artist} — ${row.track.title}`
  }
  if (row.kind === 'album') return `${row.album.title} — ${row.meta}`
  return ''
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-1.5">
    <!--
      Virtualized from the first commit, per the standing invariant. Every row
      kind — heading, divider, track, album — is `ROW_PX` tall, which is what
      keeps `visibleRange` arithmetic instead of a measurement pass. See
      `relatedRows.ts` for why the sections are one flat list.
    -->
    <div
      v-if="rows.length > 0"
      :ref="measure"
      class="max-h-112 min-h-0 flex-1 overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
    >
      <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />
      <ul class="m-0 list-none p-0">
        <li
          v-for="row in drawn"
          :key="row.key"
          class="flex items-center gap-1.5 rounded-sm px-1 outline-none"
          :class="
            isActivatable(row)
              ? 'group relative cursor-default transition-colors hover:bg-elevated/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70'
              : ''
          "
          :style="{ height: `${ROW_PX}px` }"
          :tabindex="isActivatable(row) ? 0 : -1"
          :title="rowTitle(row)"
          @dblclick="activate(row)"
          @keydown.enter="activate(row)"
        >
          <!-- The caveat for the weaker half, stated once rather than per section. -->
          <template v-if="row.kind === 'group'">
            <span class="flex-1 border-t border-default pt-1 text-xs text-dimmed">
              {{ row.label }} — {{ row.hint }}
            </span>
          </template>

          <template v-else-if="row.kind === 'header'">
            <UIcon
              :name="STRAND_ICONS[row.strand]"
              class="size-3.5 shrink-0 text-dimmed"
              aria-hidden="true"
            />
            <span
              class="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-muted"
            >
              {{ row.label }}
              <span v-if="row.detail !== null" class="normal-case tracking-normal text-dimmed">
                · {{ row.detail }}
              </span>
            </span>
            <span class="shrink-0 text-xs tabular-nums text-dimmed">{{ row.count }}</span>
          </template>

          <template v-else-if="row.kind === 'track'">
            <UIcon
              name="i-tabler-plus"
              class="size-3.5 shrink-0 text-dimmed opacity-0 group-hover:opacity-100"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate pl-2 text-sm text-default">
              <span v-if="row.track.trackNo !== null" class="tabular-nums text-dimmed">
                {{ row.track.trackNo }}.
              </span>
              {{ row.track.title }}
            </span>
          </template>

          <template v-else>
            <UIcon
              name="i-tabler-plus"
              class="size-3.5 shrink-0 text-dimmed opacity-0 group-hover:opacity-100"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate pl-2 text-sm text-default">
              {{ row.album.title }}
              <span class="text-muted">· {{ row.meta }}</span>
            </span>
          </template>
        </li>
      </ul>
      <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
    </div>

    <!--
      Four states, and they are deliberately four. "Nothing is playing", "the
      query is still running", "the query failed" and "the library genuinely
      holds nothing related" are different facts, and collapsing them into one
      grey sentence is exactly the pane-that-looks-broken the card rules out.
    -->
    <p v-else-if="related.seedId === null" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This pane follows the current track.
    </p>

    <div v-else-if="related.failed" class="flex flex-col items-center gap-2 px-1 py-4">
      <p class="text-center text-xs text-muted">Could not read the library.</p>
      <UButton
        label="Try again"
        size="xs"
        color="neutral"
        variant="subtle"
        @click="related.refresh()"
      />
    </div>

    <p v-else-if="related.loading" class="px-1 py-4 text-center text-xs text-dimmed">Looking…</p>

    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      Nothing in the library connects to this track — no other tracks on its album, nothing else by
      its artist, and no shared genre, year or folder.
    </p>

    <!-- Which verb this is, before anyone finds out by clicking. -->
    <p v-if="rows.length > 0" class="shrink-0 text-xs text-dimmed">
      Double-click to add to the end of the queue. Nothing here interrupts what is playing.
    </p>
  </div>
</template>
