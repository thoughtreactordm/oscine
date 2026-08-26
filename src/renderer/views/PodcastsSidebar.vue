<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { visibleRange } from '@renderer/panels/listViewport'
import { useDisplayFormatStore } from '@renderer/stores/displayFormat'
import { PODCAST_DISCOVER_TAB, usePodcastsStore } from '@renderer/stores/podcasts'
import { hasArtwork } from '@shared/ipc'
import type { Episode, Podcast } from '@shared/podcasts'

/**
 * Podcasts sidebar: Subscriptions above, Recent episodes below.
 *
 * The rail is the chooser now the tab strip is gone. Two independently
 * scrolled, virtualized panels — the Curate rail split in half — with Discover
 * pinned at the top of Subscriptions so the default page stays one click away.
 *
 * Discover sits *outside* the shows scroll container: it is the null stop, not
 * a subscription, so it cannot be scrolled past, virtualized, or counted in the
 * shows list. Clicking it views Discover; clicking a show views that show.
 */

const podcasts = usePodcastsStore()

/** Whether Discover — the null stop — is the thing on screen. */
const discoverViewed = computed(() => podcasts.viewedPodcastId === PODCAST_DISCOVER_TAB)
const formats = useDisplayFormatStore()
const RECENT_ROW = 52
const SHOW_ROW = 40

const recentScroll = ref(0)
const recentViewport = ref(0)
const recentEl = ref<HTMLElement | null>(null)

const showsScroll = ref(0)
const showsViewport = ref(0)
const showsEl = ref<HTMLElement | null>(null)

let stopProgress: (() => void) | null = null

onMounted(() => {
  void podcasts.refresh()
  stopProgress = podcasts.listenDownloadProgress()
})

onUnmounted(() => {
  stopProgress?.()
})

const recentWindow = computed(() =>
  visibleRange({
    total: podcasts.recent.length,
    rowPx: RECENT_ROW,
    viewportPx: recentViewport.value,
    scrollTop: recentScroll.value
  })
)

const recentDrawn = computed(() =>
  podcasts.recent.slice(recentWindow.value.first, recentWindow.value.last + 1)
)

const showsWindow = computed(() =>
  visibleRange({
    total: podcasts.list.length,
    rowPx: SHOW_ROW,
    viewportPx: showsViewport.value,
    scrollTop: showsScroll.value
  })
)

const showsDrawn = computed(() =>
  podcasts.list.slice(showsWindow.value.first, showsWindow.value.last + 1)
)

function onRecentScroll(): void {
  const el = recentEl.value
  if (!el) return
  recentScroll.value = el.scrollTop
  recentViewport.value = el.clientHeight
}

function onShowsScroll(): void {
  const el = showsEl.value
  if (!el) return
  showsScroll.value = el.scrollTop
  showsViewport.value = el.clientHeight
}

function measureRecent(el: unknown): void {
  recentEl.value = el instanceof HTMLElement ? el : null
  if (recentEl.value) recentViewport.value = recentEl.value.clientHeight
}

function measureShows(el: unknown): void {
  showsEl.value = el instanceof HTMLElement ? el : null
  if (showsEl.value) showsViewport.value = showsEl.value.clientHeight
}

function openEpisode(episode: Episode): void {
  podcasts.openTab(episode.podcastId, episode.id)
}

function openShow(podcast: Podcast): void {
  podcasts.openTab(podcast.id)
}
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col bg-default" aria-label="Podcasts">
    <section class="flex min-h-0 flex-1 flex-col border-b border-default">
      <header class="flex items-center justify-between gap-2 px-3 py-2">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted">Subscriptions</h2>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-tabler-refresh"
          :loading="podcasts.refreshing"
          aria-label="Refresh all feeds"
          @click="podcasts.refreshAll()"
        />
      </header>

      <!--
        Discover, pinned above the shows and outside their scroll container, so
        it stays put however far the list is scrolled. A plain button, not a
        `role="listitem"` in the list below: it is the null stop, not a
        subscription, so it must not be counted, virtualized, or scrolled past.
      -->
      <button
        type="button"
        class="flex shrink-0 cursor-default items-center gap-2 border-b border-default px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
        :class="
          discoverViewed
            ? 'bg-elevated text-highlighted shadow-[inset_2px_0_0_0_var(--ui-primary)]'
            : 'text-muted hover:bg-elevated/80 hover:text-default'
        "
        :aria-current="discoverViewed ? 'true' : undefined"
        @click="podcasts.view(PODCAST_DISCOVER_TAB)"
      >
        <UIcon
          name="i-tabler-compass"
          class="size-4 shrink-0"
          :class="discoverViewed ? 'text-primary' : ''"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 truncate text-xs font-medium">Discover</span>
      </button>

      <div
        :ref="measureShows"
        class="min-h-0 flex-1 overflow-y-auto"
        role="list"
        aria-label="Subscribed podcasts"
        @scroll="onShowsScroll"
      >
        <div v-if="podcasts.list.length === 0" class="px-3 py-6 text-center text-xs text-dimmed">
          Subscribe from Discover, or import an OPML file.
        </div>
        <div
          v-else
          :style="{ height: `${podcasts.list.length * SHOW_ROW}px`, position: 'relative' }"
        >
          <button
            v-for="(podcast, i) in showsDrawn"
            :key="podcast.id"
            type="button"
            role="listitem"
            class="absolute inset-x-0 flex w-full items-center gap-2 px-2 text-left transition-colors"
            :class="
              podcasts.viewedPodcastId === podcast.id
                ? 'bg-elevated text-highlighted'
                : 'hover:bg-elevated/80'
            "
            :style="{
              top: `${(showsWindow.first + i) * SHOW_ROW}px`,
              height: `${SHOW_ROW}px`
            }"
            @click="openShow(podcast)"
          >
            <UAvatar
              :src="hasArtwork(podcast.artwork.small) ? podcast.artwork.small : undefined"
              icon="i-tabler-microphone"
              alt=""
              size="sm"
              class="shrink-0 rounded-md"
              :ui="{ image: 'rounded-md object-cover', icon: 'size-3.5 text-dimmed' }"
            />
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ podcast.title }}</span>
            <span
              v-if="podcast.unplayedCount > 0"
              class="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary"
            >
              {{ podcast.unplayedCount }}
            </span>
          </button>
        </div>
      </div>
    </section>

    <section class="flex min-h-0 flex-1 flex-col">
      <header class="flex items-center justify-between gap-2 px-3 py-2">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-muted">Recent</h2>
        <span class="text-[11px] text-dimmed">{{ podcasts.recentTotal }}</span>
      </header>
      <div
        :ref="measureRecent"
        class="min-h-0 flex-1 overflow-y-auto"
        role="list"
        aria-label="Recent episodes"
        @scroll="onRecentScroll"
      >
        <div v-if="podcasts.recent.length === 0" class="px-3 py-6 text-center text-xs text-dimmed">
          New episodes from your subscriptions land here.
        </div>
        <div
          v-else
          :style="{ height: `${podcasts.recent.length * RECENT_ROW}px`, position: 'relative' }"
        >
          <button
            v-for="(episode, i) in recentDrawn"
            :key="episode.id"
            type="button"
            role="listitem"
            class="absolute inset-x-0 flex w-full items-center gap-2 px-2 text-left transition-colors hover:bg-elevated/80"
            :style="{
              top: `${(recentWindow.first + i) * RECENT_ROW}px`,
              height: `${RECENT_ROW}px`
            }"
            @click="openEpisode(episode)"
            @dblclick="podcasts.playEpisode(episode.id)"
          >
            <UAvatar
              :src="
                hasArtwork(episode.podcastArtwork.small) ? episode.podcastArtwork.small : undefined
              "
              icon="i-tabler-microphone"
              alt=""
              size="md"
              class="shrink-0 rounded-md"
              :ui="{ image: 'rounded-md object-cover', icon: 'size-4 text-dimmed' }"
            />
            <span class="min-w-0 flex-1">
              <span
                class="block truncate text-xs font-medium"
                :class="episode.played ? 'text-muted' : 'text-highlighted'"
              >
                {{ episode.title }}
              </span>
              <span class="block truncate text-[11px] text-dimmed">
                {{ episode.podcastTitle }}
                <span v-if="episode.pubDate"> · {{ formats.date(episode.pubDate) }}</span>
              </span>
            </span>
          </button>
        </div>
      </div>
    </section>
  </aside>
</template>
