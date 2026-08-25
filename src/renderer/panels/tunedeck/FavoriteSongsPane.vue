<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Track } from '@shared/library'
import { visibleRange } from '@renderer/panels/listViewport'
import { nowPlayingIcon, nowPlayingLabel, nowPlayingMark } from '@renderer/panels/nowPlayingMark'
import { favoriteSongsState } from '@renderer/panels/tunedeck/favoriteSongs'
import { useTrackActivation } from '@renderer/panels/useTrackActivation'
import { useArtistFavoritesStore } from '@renderer/stores/artistFavorites'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The playing artist's favorites, newest-hearted first — **D18**.
 *
 * The one group under Artist that answers from this machine alone. The
 * biography and the members are claims about the world behind a network layer;
 * this is a join between two local tables, and it draws the same rows with the
 * cable pulled as with it plugged in. That is **D14**'s third rule, and it is
 * why the pane reads `useArtistFavoritesStore` — which is seeded by *track* —
 * rather than the artist id `artistIdentity` resolves. See the store's note: an
 * artist Oscine cannot resolve still has favorites, and waiting for the call
 * that could resolve one is waiting on a socket.
 *
 * ## Not a `RelatedList`
 *
 * The three relation groups share one component; this one does not join them,
 * and the difference is the verb rather than the layout. `RelatedList` enqueues
 * on double-click and says so — the right rule for a discovery surface being
 * read *while* something plays. These rows are not discoveries. They are songs
 * the operator has already declared for, arriving in the same deck as the song
 * list's own rows, so they take the song list's gesture: `useTrackActivation`,
 * one preference, read in one place, so no two surfaces can disagree about what
 * a double-click means.
 *
 * `playNow` is the deck's own, as `trackActivation.ts` says it must be. It is
 * `replay` — the track cuts in and playback resumes where it was — because that
 * is what the deck's other track list already does and because rebuilding the
 * play order around a fifty-row pane would discard the queue the operator has
 * been building all evening.
 */

const songs = useArtistFavoritesStore()
const playback = usePlaybackStore()

const ROW_PX = 36

const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

const activation = useTrackActivation((track) => void playback.replay(track))

const tracks = computed(() => songs.tracks)

const state = computed(() =>
  favoriteSongsState({
    seedId: songs.seedId,
    loading: songs.loading,
    failed: songs.failed,
    answered: songs.result !== null,
    artistId: songs.artistId,
    count: tracks.value.length
  })
)

const visible = computed(() =>
  visibleRange({
    total: tracks.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => tracks.value.slice(visible.value.first, visible.value.last + 1))

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

function markFor(track: Track): ReturnType<typeof nowPlayingMark> {
  return nowPlayingMark({
    trackId: track.id,
    playingTrackId: playback.nowPlaying?.id ?? null,
    status: playback.status
  })
}

/**
 * The index the activation is told about is the row's index in *this* list.
 *
 * Which is honest and, for the `play` verb, unused: `replay` takes a track and
 * not a position, because this pane is not a play order and never becomes one.
 * It is passed because the shared contract has it, and the surfaces where it
 * does mean something are the ones whose list *is* the order.
 */
function activate(track: Track, index: number): void {
  void activation.activate(track, visible.value.first + index)
}

function rowTitle(track: Track): string {
  return track.album === null ? track.title : `${track.title} — ${track.album}`
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!--
      Virtualized from the first commit, per the standing invariant. Every row is
      `ROW_PX` tall, which is what keeps `visibleRange` arithmetic rather than a
      measurement pass. The list is capped at `ARTIST_FAVORITES_LIMIT`, so this
      is the two spacers and nothing else — the invariant is not waived for a
      short list, because the day the cap moves is not the day anyone remembers
      this pane was the exception.
    -->
    <div
      v-if="state === 'rows'"
      :ref="measure"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
    >
      <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />
      <ul class="m-0 list-none p-0">
        <li
          v-for="(track, index) in drawn"
          :key="track.id"
          class="group relative flex cursor-default items-center gap-1.5 rounded-sm px-1 outline-none transition-colors hover:bg-elevated/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :style="{ height: `${ROW_PX}px` }"
          tabindex="0"
          :title="rowTitle(track)"
          @dblclick="activate(track, index)"
          @keydown.enter="activate(track, index)"
        >
          <!--
            The playing mark reads the same here as in the song list and the
            playlist pane, which is `nowPlayingMark`'s standing rule rather than
            this pane's choice. It replaces the hover affordance rather than
            sitting beside it: the row is already the one playing, so what a
            double-click would do to it is not the question being asked.
          -->
          <UIcon
            v-if="markFor(track) !== null"
            :name="nowPlayingIcon(markFor(track))"
            class="size-3.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <UIcon
            v-else
            name="i-tabler-heart-filled"
            class="size-3.5 shrink-0 text-dimmed opacity-0 group-hover:opacity-100"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-sm text-default">
            {{ track.title }}
            <span v-if="track.album !== null" class="text-muted">· {{ track.album }}</span>
          </span>
          <span v-if="markFor(track) !== null" class="sr-only">
            {{ nowPlayingLabel(markFor(track)) }}
          </span>
        </li>
      </ul>
      <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
    </div>

    <!--
      Five states, and they are deliberately five. Nothing playing, the query
      rejected, the query is still running, the track names no artist, and the
      artist genuinely has no favorites are five different facts about why there
      are no rows, and only the second of them is a fault. `favoriteSongs.ts`
      holds the order they are tested in; these are the sentences.

      When one of these shows it is the whole of the pane's content, so it is the
      answer rather than a caption on one — which is why none of them moved to
      the group header's tooltip the way the hints did.
    -->
    <p v-else-if="state === 'standby'" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This follows the current artist.
    </p>

    <div v-else-if="state === 'failed'" class="flex flex-col items-center gap-2 px-1 py-4">
      <p class="text-center text-xs text-muted">Could not read the library.</p>
      <UButton
        label="Try again"
        size="xs"
        color="neutral"
        variant="subtle"
        @click="songs.refresh()"
      />
    </div>

    <p v-else-if="state === 'loading'" class="px-1 py-4 text-center text-xs text-dimmed">
      Looking…
    </p>

    <p v-else-if="state === 'nameless'" class="px-1 py-4 text-center text-xs text-muted">
      This track names no artist, so there is nobody to collect favorites for.
    </p>

    <!--
      An invitation and not a failure. Over a large library this is the ordinary
      answer for most artists, and it is the one sentence in the deck that is
      addressed to something the operator can do next.
    -->
    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      No favorites from this artist yet. Heart a song anywhere and it lands here.
    </p>
  </div>
</template>
