<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import { useDisplayFormatStore } from '@renderer/stores/displayFormat'
import { usePodcastsStore } from '@renderer/stores/podcasts'
import { hasArtwork } from '@shared/ipc'
import type { Episode } from '@shared/podcasts'

/**
 * Per-show body: artwork, metadata, virtualized episode list.
 *
 * Playback through the shared AudioEngine / Now Playing transport is the next
 * cut — this slice downloads to disk and serves `oscine://episode/<id>`, which
 * is the seam that transport will use.
 */

const podcasts = usePodcastsStore()
const formats = useDisplayFormatStore()
const ROW = 56
const scrollTop = ref(0)
const viewportPx = ref(0)
const listEl = ref<HTMLElement | null>(null)
const rowEls = new Map<number, HTMLElement>()

const podcast = computed(() => podcasts.viewed)
const episodes = computed(
  () =>
    (podcast.value ? podcasts.episodesByPodcast.get(podcast.value.id) : null) ?? ([] as Episode[])
)

const window = computed(() =>
  visibleRange({
    total: episodes.value.length,
    rowPx: ROW,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => episodes.value.slice(window.value.first, window.value.last + 1))

function onScroll(): void {
  const el = listEl.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewportPx.value = el.clientHeight
}

function measure(el: unknown): void {
  listEl.value = el instanceof HTMLElement ? el : null
  if (listEl.value) viewportPx.value = listEl.value.clientHeight
}

function registerRow(episodeId: number, el: unknown): void {
  if (el instanceof HTMLElement) rowEls.set(episodeId, el)
  else rowEls.delete(episodeId)
}

watch(
  () => podcasts.focusEpisodeId,
  async (episodeId) => {
    if (episodeId === null) return
    await nextTick()
    const index = episodes.value.findIndex((episode) => episode.id === episodeId)
    if (index < 0 || !listEl.value) {
      podcasts.clearFocusEpisode()
      return
    }
    listEl.value.scrollTop = Math.max(0, index * ROW - viewportPx.value / 3)
    scrollTop.value = listEl.value.scrollTop
    await nextTick()
    rowEls.get(episodeId)?.focus()
    podcasts.clearFocusEpisode()
  },
  { immediate: true }
)

onMounted(() => {
  if (podcast.value) void podcasts.loadEpisodes(podcast.value.id)
})

onUnmounted(() => {
  rowEls.clear()
})

/**
 * Downloading is true when either the row's own status or the last progress
 * event says so — the event lands before the row is re-fetched, so the button
 * flips to Cancel the instant the download starts.
 */
function isDownloading(episode: Episode): boolean {
  const progress = podcasts.downloadProgress.get(episode.id)
  return episode.downloadStatus === 'downloading' || progress?.status === 'downloading'
}

/** Whole-percent download progress, or null when the host omitted a length. */
function downloadPercent(episode: Episode): number | null {
  const progress = podcasts.downloadProgress.get(episode.id)
  return progress?.fraction != null ? Math.round(progress.fraction * 100) : null
}

function statusLabel(episode: Episode): string {
  if (isDownloading(episode)) {
    const percent = downloadPercent(episode)
    return percent != null ? `${percent}%` : 'Downloading…'
  }
  if (episode.downloadStatus === 'ready') return 'Downloaded'
  if (episode.downloadStatus === 'failed') return 'Failed'
  return 'Remote'
}
</script>

<template>
  <div v-if="podcast" class="flex h-full min-h-0 flex-col">
    <header class="flex shrink-0 gap-5 border-b border-default px-6 py-5">
      <UAvatar
        :src="hasArtwork(podcast.artwork.large) ? podcast.artwork.large : undefined"
        icon="i-tabler-microphone"
        alt=""
        class="size-28 shrink-0 rounded-xl shadow-sm"
        :ui="{
          root: 'size-28 rounded-xl',
          image: 'rounded-xl object-cover',
          icon: 'size-12 text-dimmed'
        }"
      />
      <div class="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="truncate text-2xl font-bold tracking-tight text-highlighted">
              {{ podcast.title }}
            </h2>
            <p v-if="podcast.author" class="truncate text-sm text-muted">{{ podcast.author }}</p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            <UButton
              size="sm"
              color="neutral"
              variant="soft"
              icon="i-tabler-refresh"
              :loading="podcasts.refreshing"
              @click="podcasts.refreshPodcast(podcast.id)"
            >
              Refresh
            </UButton>
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-tabler-trash"
              :disabled="podcast.episodeCount - podcast.undownloadedCount === 0"
              @click="podcasts.clearDownloads(podcast.id)"
            >
              Remove downloads
            </UButton>
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-tabler-unlink"
              @click="podcasts.unsubscribe(podcast.id)"
            >
              Unsubscribe
            </UButton>
          </div>
        </div>
        <p
          v-if="podcast.description"
          class="line-clamp-3 max-w-3xl text-sm leading-relaxed text-muted"
        >
          {{ podcast.description }}
        </p>
        <p v-if="podcast.lastError" class="text-xs text-error">{{ podcast.lastError }}</p>
        <p class="text-xs text-dimmed">
          {{ podcast.episodeCount }} episodes
          <span v-if="podcast.unplayedCount"> · {{ podcast.unplayedCount }} unplayed</span>
        </p>
      </div>
    </header>

    <div
      :ref="measure"
      class="min-h-0 flex-1 overflow-y-auto"
      role="list"
      aria-label="Episodes"
      @scroll="onScroll"
    >
      <div v-if="episodes.length === 0" class="px-6 py-10 text-center text-sm text-dimmed">
        No episodes yet — try Refresh.
      </div>
      <div v-else :style="{ height: `${episodes.length * ROW}px`, position: 'relative' }">
        <div
          v-for="(episode, i) in drawn"
          :key="episode.id"
          :ref="(el) => registerRow(episode.id, el)"
          role="listitem"
          tabindex="0"
          class="absolute inset-x-0 flex items-center gap-3 border-b border-default/60 px-6 outline-none focus-visible:bg-elevated/70"
          :style="{ top: `${(window.first + i) * ROW}px`, height: `${ROW}px` }"
          :class="podcasts.focusEpisodeId === episode.id ? 'bg-elevated/70' : ''"
          @dblclick="podcasts.playEpisode(episode.id)"
        >
          <div class="min-w-0 flex-1">
            <p
              class="truncate text-sm font-medium"
              :class="episode.played ? 'text-muted' : 'text-highlighted'"
            >
              {{ episode.title }}
            </p>
            <p class="truncate text-xs text-dimmed">
              <span v-if="episode.pubDate">{{ formats.date(episode.pubDate) }}</span>
              <span v-if="episode.durationMs">
                <span v-if="episode.pubDate"> · </span>{{ formats.durationMs(episode.durationMs) }}
              </span>
              <span> · {{ statusLabel(episode) }}</span>
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="episode.played ? 'i-tabler-circle' : 'i-tabler-circle-check'"
              :aria-label="episode.played ? 'Mark unplayed' : 'Mark played'"
              @click="podcasts.setPlayed(episode.id, !episode.played)"
            />
            <UButton
              v-if="episode.downloadStatus === 'ready'"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-tabler-trash"
              :aria-label="`Remove download of ${episode.title}`"
              @click="podcasts.deleteDownload(episode.id)"
            />
            <!--
              One action button that cycles by download state (P1):
              Download (idle / failed) → Cancel with progress (downloading) → Play (ready).
              Removal stays its own trash affordance above; it is not a state here.
            -->
            <UButton
              v-if="episode.downloadStatus === 'ready'"
              size="xs"
              color="primary"
              variant="soft"
              icon="i-tabler-player-play-filled"
              :aria-label="`Play ${episode.title}`"
              @click="podcasts.playEpisode(episode.id)"
            />
            <UButton
              v-else-if="isDownloading(episode)"
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-tabler-x"
              :aria-label="`Cancel download of ${episode.title}`"
              @click="podcasts.cancelDownload(episode.id)"
            >
              <span v-if="downloadPercent(episode) !== null" class="text-xs tabular-nums">
                {{ downloadPercent(episode) }}%
              </span>
            </UButton>
            <UButton
              v-else
              size="xs"
              color="primary"
              variant="soft"
              icon="i-tabler-download"
              :aria-label="`Download ${episode.title}`"
              @click="podcasts.downloadEpisode(episode.id)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
