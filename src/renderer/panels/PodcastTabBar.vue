<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { PODCAST_DISCOVER_TAB, usePodcastsStore } from '@renderer/stores/podcasts'
import { hasArtwork } from '@shared/ipc'

/**
 * Open show tabs + the Discover fixture.
 *
 * Visual and keyboard setup: segmented strip, inset primary underline on the
 * viewed tab, close on hover / middle-click. Rename and drag-reorder stay out
 * for this slice — shows are not renamed from the strip, and open-tab order is
 * open order.
 */

type TabStop = number | typeof PODCAST_DISCOVER_TAB

const podcasts = usePodcastsStore()
const tabEls = new Map<TabStop, HTMLElement>()

const discoverViewed = computed(() => podcasts.viewedPodcastId === PODCAST_DISCOVER_TAB)

function registerTab(stop: TabStop, el: unknown): void {
  if (el instanceof HTMLElement) tabEls.set(stop, el)
  else tabEls.delete(stop)
}

function isViewed(podcastId: number): boolean {
  return podcasts.viewedPodcastId === podcastId
}

function select(stop: TabStop): void {
  podcasts.view(stop)
}

async function focusViewed(): Promise<void> {
  await nextTick()
  const el = tabEls.get(podcasts.viewedPodcastId)
  el?.focus()
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function stops(): TabStop[] {
  return [PODCAST_DISCOVER_TAB, ...podcasts.openTabs.map((podcast) => podcast.id)]
}

function onKeydown(event: KeyboardEvent): void {
  const order = stops()
  const current = order.indexOf(podcasts.viewedPodcastId)
  if (current < 0) return

  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = order[(current + delta + order.length) % order.length]
    if (next === undefined) return
    select(next)
    void focusViewed()
    return
  }

  if (
    (event.key === 'Delete' || event.key === 'Backspace') &&
    podcasts.viewedPodcastId !== PODCAST_DISCOVER_TAB
  ) {
    event.preventDefault()
    podcasts.close(podcasts.viewedPodcastId)
    void focusViewed()
  }
}
</script>

<template>
  <div class="flex shrink-0 flex-col">
    <div class="flex h-9 items-stretch border-b border-default bg-elevated/40">
      <div
        class="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        role="tablist"
        aria-label="Open podcasts"
        aria-orientation="horizontal"
        @keydown="onKeydown"
      >
        <div
          :ref="(el) => registerTab(PODCAST_DISCOVER_TAB, el)"
          role="tab"
          :aria-selected="discoverViewed"
          :tabindex="discoverViewed ? 0 : -1"
          class="relative flex shrink-0 cursor-default items-center gap-1.5 border-r border-default px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :class="
            discoverViewed
              ? 'bg-default text-highlighted shadow-[inset_0_-2px_0_0_var(--ui-primary)]'
              : 'text-muted hover:bg-elevated/70 hover:text-default'
          "
          @click="select(PODCAST_DISCOVER_TAB)"
        >
          <UIcon
            name="i-tabler-compass"
            class="size-3.5 shrink-0"
            :class="discoverViewed ? 'text-primary' : ''"
            aria-hidden="true"
          />
          <span>Discover</span>
        </div>

        <div
          v-for="podcast in podcasts.openTabs"
          :key="podcast.id"
          :ref="(el) => registerTab(podcast.id, el)"
          role="tab"
          :aria-selected="isViewed(podcast.id)"
          :tabindex="isViewed(podcast.id) ? 0 : -1"
          class="group relative flex max-w-56 shrink-0 cursor-default items-center gap-1.5 border-r border-default px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :class="
            isViewed(podcast.id)
              ? 'bg-default text-highlighted shadow-[inset_0_-2px_0_0_var(--ui-primary)]'
              : 'text-muted hover:bg-elevated/70 hover:text-default'
          "
          @click="select(podcast.id)"
          @auxclick.middle.prevent="podcasts.close(podcast.id)"
        >
          <UAvatar
            :src="hasArtwork(podcast.artwork.small) ? podcast.artwork.small : undefined"
            icon="i-tabler-microphone"
            alt=""
            size="3xs"
            class="shrink-0 rounded-sm"
            :ui="{ image: 'rounded-sm object-cover', icon: 'size-3 text-dimmed' }"
            aria-hidden="true"
          />
          <span class="truncate" :title="podcast.title">{{ podcast.title }}</span>
          <span v-if="podcast.unplayedCount > 0" class="shrink-0 text-xs tabular-nums text-dimmed">
            {{ podcast.unplayedCount }}
          </span>

          <UButton
            icon="i-tabler-x"
            size="xs"
            color="neutral"
            variant="ghost"
            class="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            :class="isViewed(podcast.id) ? 'opacity-100' : ''"
            :aria-label="`Close ${podcast.title}`"
            tabindex="-1"
            @click.stop="podcasts.close(podcast.id)"
          />
        </div>
      </div>

      <p v-if="podcasts.openTabs.length === 0" class="self-center px-2.5 text-xs text-muted">
        No shows open. Pick one from Subscriptions.
      </p>
    </div>

    <UAlert
      v-if="podcasts.notice"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :description="podcasts.notice"
      class="rounded-none"
    />
  </div>
</template>
