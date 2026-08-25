<script setup lang="ts">
import { computed } from 'vue'
import { catalogArtworkUrl } from '@shared/ipc'
import type { PodcastCatalogHit } from '@shared/podcasts'

/**
 * One catalogue result, in the grid and in every Discover shelf.
 *
 * Subscribing is a button, not a click on the card. The previous shelf made the
 * whole tile a subscribe target, which meant a stray click on a cover silently
 * added a show and started fetching a feed — a destructive-feeling action with
 * no deliberate gesture behind it. The card surface is now inert; only the
 * button subscribes.
 */

const props = defineProps<{
  hit: PodcastCatalogHit
  subscribed: boolean
  busy: boolean
}>()

const emit = defineEmits<{ subscribe: [hit: PodcastCatalogHit] }>()

const subtitle = computed(() => props.hit.author ?? 'Unknown author')

// Apple's CDN address is never handed to the browser directly — main fetches it
// and serves the bytes back over `fermata:`. Off-allowlist hits resolve to null
// and fall through to the placeholder icon.
const artworkSrc = computed(() => catalogArtworkUrl(props.hit.artworkUrl))
</script>

<template>
  <article class="group/card flex min-w-0 flex-col gap-2.5">
    <div
      class="relative aspect-square overflow-hidden rounded-xl border border-default bg-elevated/60 shadow-sm transition-shadow duration-200 group-hover/card:shadow-md"
    >
      <img
        v-if="artworkSrc"
        :src="artworkSrc"
        :alt="''"
        class="size-full object-cover transition-transform duration-300 group-hover/card:scale-[1.03]"
        loading="lazy"
        decoding="async"
      />
      <div v-else class="flex size-full items-center justify-center">
        <UIcon name="i-tabler-microphone-2" class="size-9 text-dimmed/40" aria-hidden="true" />
      </div>

      <!-- Subscribed shows stay visible in results but read as already-had. -->
      <div
        v-if="subscribed"
        class="absolute right-2 top-2 flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium backdrop-blur-sm"
        :style="{ background: 'var(--oscine-scrim)', color: 'var(--oscine-on-scrim)' }"
      >
        <UIcon name="i-tabler-check" class="size-3" aria-hidden="true" />
        Following
      </div>

      <div
        v-else
        class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2 opacity-0 transition-opacity duration-200 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100"
      >
        <UButton
          size="xs"
          block
          icon="i-tabler-plus"
          :loading="busy"
          :aria-label="`Subscribe to ${hit.title}`"
          @click="emit('subscribe', hit)"
        >
          Subscribe
        </UButton>
      </div>
    </div>

    <div class="min-w-0">
      <p class="line-clamp-2 text-sm font-medium leading-snug text-highlighted" :title="hit.title">
        {{ hit.title }}
      </p>
      <p class="mt-0.5 truncate text-xs text-muted" :title="subtitle">{{ subtitle }}</p>
    </div>
  </article>
</template>
