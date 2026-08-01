<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PodcastCatalogCard from '@renderer/panels/PodcastCatalogCard.vue'
import { usePodcastsStore } from '@renderer/stores/podcasts'
import {
  PODCAST_BROWSE_CATEGORIES,
  podcastCategoryName,
  type PodcastCatalogHit
} from '@shared/podcasts'

/**
 * Discover pods.
 *
 * Three mutually exclusive bodies under one persistent header: search results,
 * one browsed category, or the recommendation shelves. They are exclusive on
 * purpose — the previous version stacked search, shelves, a URL field and an
 * OPML picker down one column, so the answer to "what am I looking at" depended
 * on how far you had scrolled.
 *
 * Shelf count and shelf kinds come from main. Adding a fourth recommendation
 * source is a shelf with a new `kind`, not a change here.
 */

const podcasts = usePodcastsStore()
const searchTerm = ref('')
const feedUrl = ref('')
const showManualAdd = ref(false)
const opmlInput = ref<HTMLInputElement | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const searching = computed(() => searchTerm.value.trim().length >= 2)
const activeCategory = computed(() =>
  PODCAST_BROWSE_CATEGORIES.find((c) => c.genreId === podcasts.activeCategoryId)
)

/** Which of the three bodies is on screen. */
const mode = computed<'search' | 'category' | 'shelves'>(() => {
  if (searching.value) return 'search'
  if (podcasts.activeCategoryId !== null) return 'category'
  return 'shelves'
})

const shelvesEmpty = computed(
  () => !podcasts.recommending && podcasts.recommendShelves.length === 0
)

onMounted(() => {
  void podcasts.loadRecommendations()
})

watch(searchTerm, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  const q = value.trim()
  if (q.length < 2) {
    podcasts.clearCatalogSearch()
    return
  }
  // Browsing a category and then typing should land you in results, not leave
  // a category selected behind the search body.
  if (podcasts.activeCategoryId !== null) void podcasts.browseCategory(null)
  searchTimer = setTimeout(() => void podcasts.searchCatalog(q), 320)
})

function clearSearch(): void {
  searchTerm.value = ''
  podcasts.clearCatalogSearch()
}

async function subscribeHit(hit: PodcastCatalogHit): Promise<void> {
  if (podcasts.isSubscribedFeed(hit.feedUrl)) return
  const podcast = await podcasts.subscribe(hit.feedUrl)
  if (podcast) void podcasts.loadRecommendations()
}

async function subscribeByUrl(): Promise<void> {
  const url = feedUrl.value.trim()
  if (!url) return
  const podcast = await podcasts.subscribe(url)
  if (podcast) {
    feedUrl.value = ''
    void podcasts.loadRecommendations()
  }
}

async function onOpmlPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await podcasts.importOpml(await file.text())
  void podcasts.loadRecommendations()
}

/** Whether a shelf's genre is one the browse handler will accept. */
function isBrowsable(genreId: string): boolean {
  return podcastCategoryName(genreId) !== null
}

/** Icon per shelf kind, so a rail's provenance reads at a glance. */
function shelfIcon(kind: string): string {
  if (kind === 'genre') return 'i-tabler-sparkles'
  if (kind === 'popular') return 'i-tabler-flame'
  return 'i-tabler-category-2'
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!--
      Sticky header: search and the category rail stay reachable while the
      shelves scroll, so switching what you are browsing never needs a scroll up.
    -->
    <header
      class="sticky top-0 z-10 shrink-0 border-b border-default bg-default/85 backdrop-blur-md"
    >
      <div class="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 pb-3 pt-6">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div class="min-w-0">
            <h2 class="text-2xl font-semibold tracking-tight text-highlighted">Discover</h2>
            <p class="mt-1 text-sm text-muted">
              Episodes download into Fermata — nothing streams while you listen.
            </p>
          </div>

          <div class="flex items-center gap-2">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-tabler-refresh"
              :loading="podcasts.recommending"
              :disabled="mode !== 'shelves'"
              @click="podcasts.loadRecommendations()"
            >
              Refresh
            </UButton>
            <UButton
              size="sm"
              color="neutral"
              :variant="showManualAdd ? 'soft' : 'ghost'"
              icon="i-tabler-plus"
              @click="showManualAdd = !showManualAdd"
            >
              Add by URL
            </UButton>
          </div>
        </div>

        <UInput
          v-model="searchTerm"
          size="lg"
          icon="i-tabler-search"
          placeholder="Search shows and authors"
          autocomplete="off"
          :loading="podcasts.searchingCatalog"
        >
          <template v-if="searchTerm" #trailing>
            <UButton
              size="xs"
              color="neutral"
              variant="link"
              icon="i-tabler-x"
              aria-label="Clear search"
              @click="clearSearch"
            />
          </template>
        </UInput>

        <!-- Category rail. Renders instantly: the list is a shared constant. -->
        <div
          v-show="!searching"
          class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            v-for="category in PODCAST_BROWSE_CATEGORIES"
            :key="category.genreId"
            type="button"
            class="shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :class="
              podcasts.activeCategoryId === category.genreId
                ? 'border-primary bg-primary text-inverted'
                : 'border-default text-muted hover:border-accented hover:bg-elevated/70 hover:text-highlighted'
            "
            :aria-pressed="podcasts.activeCategoryId === category.genreId"
            @click="podcasts.browseCategory(category.genreId)"
          >
            {{ category.name }}
          </button>
        </div>
      </div>

      <!--
        Manual add is a disclosure, not a section. Pasting a feed URL and
        importing OPML are things you do once, not things you browse.
      -->
      <div v-if="showManualAdd" class="border-t border-default bg-elevated/40">
        <div
          class="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center"
        >
          <form class="flex min-w-0 flex-1 gap-2" @submit.prevent="subscribeByUrl">
            <UInput
              v-model="feedUrl"
              class="min-w-0 flex-1"
              placeholder="https://example.com/podcast/feed.xml"
              autocomplete="off"
              :disabled="podcasts.subscribing"
            />
            <UButton
              type="submit"
              icon="i-tabler-rss"
              :loading="podcasts.subscribing"
              :disabled="!feedUrl.trim()"
            >
              Subscribe
            </UButton>
          </form>
          <div class="flex items-center gap-2 sm:border-l sm:border-default sm:pl-3">
            <input
              ref="opmlInput"
              type="file"
              accept=".opml,.xml,text/x-opml,application/xml,text/xml"
              class="hidden"
              @change="onOpmlPicked"
            />
            <UButton
              color="neutral"
              variant="soft"
              icon="i-tabler-file-import"
              :loading="podcasts.subscribing"
              @click="opmlInput?.click()"
            >
              Import OPML
            </UButton>
            <p class="text-xs text-dimmed">Overcast, gPodder, Apple Podcasts</p>
          </div>
        </div>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-7xl px-6 pb-16 pt-6">
        <!--
          Catalogue results are capped in main (25 search, 24 per category, 12
          per shelf), so these grids are bounded and small. The virtualization
          invariant is about library lists at 100k scale; it does not apply here.
        -->

        <!-- Search -->
        <section v-if="mode === 'search'" class="flex flex-col gap-5">
          <div class="flex items-baseline justify-between gap-3">
            <h3 class="text-sm font-semibold text-highlighted">
              Results for “{{ searchTerm.trim() }}”
            </h3>
            <p v-if="podcasts.catalogHits.length" class="text-xs text-dimmed">
              {{ podcasts.catalogHits.length }} shows
            </p>
          </div>

          <div v-if="podcasts.searchingCatalog && !podcasts.catalogHits.length" class="grid-cards">
            <div v-for="n in 12" :key="n" class="flex flex-col gap-2.5">
              <div class="aspect-square animate-pulse rounded-xl bg-elevated" />
              <div class="h-3 w-3/4 animate-pulse rounded bg-elevated" />
              <div class="h-2.5 w-1/2 animate-pulse rounded bg-elevated" />
            </div>
          </div>

          <div
            v-else-if="!podcasts.catalogHits.length"
            class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-default py-16 text-center"
          >
            <UIcon name="i-tabler-mood-search" class="size-8 text-dimmed" aria-hidden="true" />
            <p class="text-sm text-muted">No catalogue matches for that term.</p>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-tabler-plus"
              @click="showManualAdd = true"
            >
              Subscribe by feed URL instead
            </UButton>
          </div>

          <div v-else class="grid-cards">
            <PodcastCatalogCard
              v-for="hit in podcasts.catalogHits"
              :key="hit.collectionId"
              :hit="hit"
              :subscribed="podcasts.isSubscribedFeed(hit.feedUrl)"
              :busy="podcasts.subscribing"
              @subscribe="subscribeHit"
            />
          </div>
        </section>

        <!-- One browsed category -->
        <section v-else-if="mode === 'category'" class="flex flex-col gap-5">
          <div class="flex items-center gap-3">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-tabler-arrow-left"
              @click="podcasts.browseCategory(null)"
            >
              All shelves
            </UButton>
            <h3 class="text-sm font-semibold text-highlighted">
              Top in {{ activeCategory?.name ?? 'this category' }}
            </h3>
          </div>

          <div v-if="podcasts.browsingCategory" class="grid-cards">
            <div v-for="n in 12" :key="n" class="flex flex-col gap-2.5">
              <div class="aspect-square animate-pulse rounded-xl bg-elevated" />
              <div class="h-3 w-3/4 animate-pulse rounded bg-elevated" />
              <div class="h-2.5 w-1/2 animate-pulse rounded bg-elevated" />
            </div>
          </div>

          <p v-else-if="!podcasts.categoryHits.length" class="py-16 text-center text-sm text-muted">
            Nothing came back for that category. Apple's charts may be unreachable right now.
          </p>

          <div v-else class="grid-cards">
            <PodcastCatalogCard
              v-for="hit in podcasts.categoryHits"
              :key="hit.collectionId"
              :hit="hit"
              :subscribed="podcasts.isSubscribedFeed(hit.feedUrl)"
              :busy="podcasts.subscribing"
              @subscribe="subscribeHit"
            />
          </div>
        </section>

        <!-- Shelves -->
        <section v-else class="flex flex-col gap-10">
          <p
            v-if="podcasts.coldStart && podcasts.recommendShelves.length"
            class="-mb-4 text-xs text-dimmed"
          >
            Charts to start from. Once you follow a few shows these shelves retune to your genres.
          </p>

          <template v-if="podcasts.recommending && !podcasts.recommendShelves.length">
            <div v-for="n in 2" :key="n" class="flex flex-col gap-4">
              <div class="h-4 w-40 animate-pulse rounded bg-elevated" />
              <div class="flex gap-4 overflow-hidden">
                <div v-for="c in 7" :key="c" class="flex w-44 shrink-0 flex-col gap-2.5">
                  <div class="aspect-square animate-pulse rounded-xl bg-elevated" />
                  <div class="h-3 w-3/4 animate-pulse rounded bg-elevated" />
                </div>
              </div>
            </div>
          </template>

          <div
            v-else-if="shelvesEmpty"
            class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-default py-20 text-center"
          >
            <UIcon name="i-tabler-antenna-bars-off" class="size-8 text-dimmed" aria-hidden="true" />
            <p class="max-w-sm text-sm text-muted">
              Recommendations could not load. Search above, pick a category, or subscribe by feed
              URL — none of those need the charts.
            </p>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-tabler-refresh"
              @click="podcasts.loadRecommendations()"
            >
              Try again
            </UButton>
          </div>

          <template v-else>
            <section
              v-for="shelf in podcasts.recommendShelves"
              :key="shelf.id"
              class="flex flex-col gap-4"
            >
              <div class="flex items-baseline gap-2.5">
                <UIcon
                  :name="shelfIcon(shelf.kind)"
                  class="size-4 shrink-0 translate-y-0.5 text-primary"
                  aria-hidden="true"
                />
                <h3 class="text-base font-semibold tracking-tight text-highlighted">
                  {{ shelf.title }}
                </h3>
                <p v-if="shelf.reason" class="truncate text-xs text-dimmed">{{ shelf.reason }}</p>
                <!--
                  Only for shelves whose genre is on the rail: main's browse
                  handler takes an allowlist, and a sub-genre shelf would be
                  rejected. A dead-end link is worse than no link.
                -->
                <button
                  v-if="isBrowsable(shelf.id)"
                  type="button"
                  class="ml-auto shrink-0 text-xs font-medium text-muted transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  @click="podcasts.browseCategory(shelf.id)"
                >
                  See all
                </button>
              </div>

              <div
                class="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]"
              >
                <PodcastCatalogCard
                  v-for="hit in shelf.hits"
                  :key="hit.collectionId"
                  class="w-44 shrink-0 snap-start"
                  :hit="hit"
                  :subscribed="podcasts.isSubscribedFeed(hit.feedUrl)"
                  :busy="podcasts.subscribing"
                  @subscribe="subscribeHit"
                />
              </div>
            </section>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * One grid definition for both full-width bodies. Auto-fill rather than fixed
 * breakpoints because Discover is a dockable panel: its width is the user's
 * choice, not a device class.
 */
.grid-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: 1.5rem 1rem;
}
</style>
