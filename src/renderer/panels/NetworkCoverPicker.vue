<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CoverArtCandidate } from '@shared/artwork'
import { catalogArtworkUrl } from '@shared/ipc'
import { useTrackEditStore } from '@renderer/stores/trackEdit'

/**
 * The edit-time network cover picker — **W7-17**.
 *
 * A modal over the metadata editor: search MusicBrainz + iTunes for an album
 * cover and stage the pick as a durable override. Candidates are references, so
 * every thumbnail is drawn through the `oscine://catalog-artwork` proxy — the
 * same one Podcast Discover uses — and the renderer never opens a socket. Only
 * the picked cover is fetched, in main, and it lands exactly as a file pick
 * would. With online lookups off the search simply returns nothing and the file
 * picker beside this is untouched.
 */

const store = useTrackEditStore()

const artist = ref('')
const album = ref('')

// Seed the fields from the editor each time the picker opens. The store has run
// a first search with these same values already; the inputs let the operator
// correct a bad guess (a compilation, a mis-tagged album) and search again.
watch(
  () => store.networkPickerOpen,
  (open) => {
    if (open) {
      artist.value = store.values.artist
      album.value = store.values.album
    }
  }
)

const caaCandidates = computed(() =>
  store.coverCandidates.filter((candidate) => candidate.source === 'coverartarchive')
)
const itunesCandidates = computed(() =>
  store.coverCandidates.filter((candidate) => candidate.source === 'itunes')
)

const showEmpty = computed(
  () =>
    store.coverSearched &&
    !store.coverSearching &&
    store.coverCandidates.length === 0 &&
    store.coverSearchError === null
)

function candidateKey(candidate: CoverArtCandidate): string {
  return `${candidate.source}:${candidate.fullUrl}`
}

/** The proxied preview URL, or null when a candidate's host is off the allowlist. */
function preview(candidate: CoverArtCandidate): string | null {
  return catalogArtworkUrl(candidate.thumbUrl)
}

function search(): void {
  void store.searchCovers(artist.value, album.value)
}

function pick(candidate: CoverArtCandidate): void {
  void store.applyRemoteCover(candidate.fullUrl)
}
</script>

<template>
  <UModal
    :open="store.networkPickerOpen"
    title="Get artwork from the internet"
    description="Search MusicBrainz and Apple for an album cover"
    :ui="{ content: 'max-w-2xl' }"
    @update:open="(value: boolean) => !value && store.closeNetworkPicker()"
  >
    <template #content>
      <div class="flex max-h-[80vh] flex-col">
        <header class="flex flex-col gap-2 border-b border-default p-4">
          <div class="flex items-center justify-between">
            <h2 class="text-base font-semibold text-highlighted">Get artwork from the internet</h2>
            <UButton
              type="button"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-tabler-x"
              aria-label="Close"
              @click="store.closeNetworkPicker()"
            />
          </div>
          <form class="flex items-end gap-2" @submit.prevent="search">
            <UFormField label="Artist" class="flex-1">
              <UInput v-model="artist" size="sm" placeholder="Artist" class="w-full" />
            </UFormField>
            <UFormField label="Album" class="flex-1">
              <UInput v-model="album" size="sm" placeholder="Album" class="w-full" />
            </UFormField>
            <UButton
              type="submit"
              size="sm"
              color="primary"
              icon="i-tabler-search"
              label="Search"
              :loading="store.coverSearching"
            />
          </form>
        </header>

        <div class="min-h-40 flex-1 overflow-y-auto p-4">
          <div
            v-if="store.coverSearching"
            class="flex h-40 flex-col items-center justify-center gap-2 text-dimmed"
          >
            <UIcon name="i-tabler-loader-2" class="size-8 animate-spin" />
            <span class="text-xs">Searching…</span>
          </div>

          <p v-else-if="store.coverSearchError" class="p-2 text-sm text-error">
            {{ store.coverSearchError }}
          </p>

          <div
            v-else-if="showEmpty"
            class="flex h-40 flex-col items-center justify-center gap-2 text-center text-dimmed"
          >
            <UIcon name="i-tabler-mood-empty" class="size-8" />
            <span class="text-xs">
              No covers found. Online lookups may be off, or this album isn’t in the catalogues.
            </span>
          </div>

          <div v-else class="flex flex-col gap-5">
            <section v-if="caaCandidates.length > 0">
              <h3 class="mb-2 text-xs font-medium text-muted">MusicBrainz · Cover Art Archive</h3>
              <div class="grid grid-cols-3 gap-3 sm:grid-cols-4">
                <button
                  v-for="candidate in caaCandidates"
                  :key="candidateKey(candidate)"
                  type="button"
                  class="group flex flex-col gap-1 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  :disabled="store.artworkBusy"
                  @click="pick(candidate)"
                >
                  <span
                    class="aspect-square overflow-hidden rounded-md border border-default bg-elevated ring-primary transition-all group-hover:ring-2"
                  >
                    <img
                      v-if="preview(candidate)"
                      :src="preview(candidate) ?? undefined"
                      :alt="candidate.title ?? 'Album cover candidate'"
                      class="size-full object-cover"
                      draggable="false"
                    />
                  </span>
                  <span v-if="candidate.title" class="truncate text-[11px] text-default">
                    {{ candidate.title }}
                  </span>
                  <span v-if="candidate.detail" class="truncate text-[10px] text-dimmed">
                    {{ candidate.detail }}
                  </span>
                </button>
              </div>
            </section>

            <section v-if="itunesCandidates.length > 0">
              <h3 class="mb-2 text-xs font-medium text-muted">Apple Music</h3>
              <div class="grid grid-cols-3 gap-3 sm:grid-cols-4">
                <button
                  v-for="candidate in itunesCandidates"
                  :key="candidateKey(candidate)"
                  type="button"
                  class="group flex flex-col gap-1 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  :disabled="store.artworkBusy"
                  @click="pick(candidate)"
                >
                  <span
                    class="aspect-square overflow-hidden rounded-md border border-default bg-elevated ring-primary transition-all group-hover:ring-2"
                  >
                    <img
                      v-if="preview(candidate)"
                      :src="preview(candidate) ?? undefined"
                      :alt="candidate.title ?? 'Album cover candidate'"
                      class="size-full object-cover"
                      draggable="false"
                    />
                  </span>
                  <span v-if="candidate.title" class="truncate text-[11px] text-default">
                    {{ candidate.title }}
                  </span>
                  <span v-if="candidate.detail" class="truncate text-[10px] text-dimmed">
                    {{ candidate.detail }}
                  </span>
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
