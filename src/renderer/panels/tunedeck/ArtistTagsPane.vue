<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { MAX_TRACK_ID_PAGE } from '@shared/library'
import type { TrackFacets } from '@shared/library'
import { MAX_TAG_TRACK_IDS } from '@shared/tags'
import type { ArtistTagsView, TagCoverage } from '@shared/tags'
import { collectPagedIds } from '@renderer/panels/pagedIds'
import { library } from '@renderer/ipc'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useTagsStore } from '@renderer/stores/tags'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * The operator's tags at the artist's altitude — **W15-7**.
 *
 * The Track pane answers "what have I said about this track"; this answers it
 * about a whole catalogue. A user tag is stored per track, so there is no
 * artist-tag row to read — an "artist's tag" is one that sits on enough of the
 * artist's tracks, and the honest way to show that is coverage: every tag any of
 * the artist's tracks carries, each over how many of them do. A tag at full
 * coverage is, in effect, the artist's own.
 *
 * ## Local, like its neighbours
 *
 * A sibling of Favorite songs and Listening, and of the same kind: seeded by the
 * playing track, answered from SQLite, drawn in a frame on a machine with the
 * cable pulled. Nothing here waits on an identity resolving — the browse-dimension
 * artist is a `trackFacets` probe, the same one the Track pane resolves its
 * album/artist batch from, so this readout and the "everything by this artist"
 * apply name one set. D14's third rule; see `useTagsStore.forArtist`.
 *
 * ## Writes reach the whole artist, and are chunked to the batch cap
 *
 * Apply and remove here act on the artist's entire track set, resolved to the end
 * with `collectPagedIds` — a single page would silently stop at ten thousand and
 * call a prolific artist done, the quiet-wrong-selection this id layer exists to
 * refuse. That set can exceed `MAX_TAG_TRACK_IDS`, so a write is split into
 * cap-sized batches: the first coins or reuses the vocabulary row, the rest ride
 * it. Every edit re-reads coverage off the store's `changed` pulse, so a chip's
 * count moves the instant its write lands.
 */

const playback = usePlaybackStore()
const tags = useTagsStore()
const tunedeck = useTunedeckStore()

const facets = ref<TrackFacets | null>(null)
const coverage = ref<ArtistTagsView | null>(null)
const busy = ref(false)

/** Loaded once, lazily — the vocabulary the add input autocompletes against is library-wide. */
let vocabularyRequested = false

const artistName = computed(() => {
  const track = playback.nowPlaying
  return track ? (track.albumArtist ?? track.artist) : null
})

/** The browse-dimension artist the coverage is over, or null for a track with none. */
const artistId = computed(() => facets.value?.artistId ?? null)

const state = computed<'standby' | 'loading' | 'ready'>(() => {
  if (!playback.nowPlaying) return 'standby'
  return facets.value === null || coverage.value === null ? 'loading' : 'ready'
})

/** The coverage rows, most-covered first as the store ordered them. */
const rows = computed<readonly TagCoverage[]>(() => coverage.value?.tags ?? [])

/** The denominator every chip reads against — the artist's own track count. */
const total = computed(() => coverage.value?.total ?? 0)

const vocabularyItems = computed(() => tags.vocabulary.map((tag) => tag.label))

watch(
  [() => tunedeck.showing, () => playback.nowPlaying?.id ?? null],
  ([showing, trackId]) => {
    // A new subject starts blank so a slow lookup can never paint the last
    // artist's coverage over this one's.
    facets.value = null
    coverage.value = null
    if (!showing || trackId === null) return
    if (!vocabularyRequested) {
      vocabularyRequested = true
      void tags.loadVocabulary()
    }
    void loadSubject(trackId)
  },
  { immediate: true }
)

// Coverage moves whenever a tag is applied or removed anywhere — here or in the
// Track pane over one of this artist's tracks — so re-read it off the store's
// `changed` pulse rather than only on a subject change. Facets are untouched, so
// this reloads the count without a second `trackFacets` probe.
watch(
  () => tags.changed?.seq ?? 0,
  () => {
    if (tunedeck.showing) void reloadCoverage()
  }
)

async function loadSubject(trackId: number): Promise<void> {
  const resolved = await library.trackFacets(trackId)
  // The subject can change across the await; only the current track's answer belongs.
  if ((playback.nowPlaying?.id ?? null) !== trackId) return
  facets.value = resolved
  if (resolved.artistId === null) {
    coverage.value = { total: 0, tags: [] }
    return
  }
  const view = await tags.forArtist(resolved.artistId)
  if ((playback.nowPlaying?.id ?? null) === trackId) coverage.value = view
}

async function reloadCoverage(): Promise<void> {
  const id = artistId.value
  const trackId = playback.nowPlaying?.id ?? null
  if (id === null || trackId === null) return
  const view = await tags.forArtist(id)
  // Only land it if neither the track nor its artist moved across the await.
  if ((playback.nowPlaying?.id ?? null) === trackId && artistId.value === id) coverage.value = view
}

/** Every track by the browse-dimension artist, paged to the end. */
async function resolveArtistTrackIds(id: number): Promise<number[]> {
  return collectPagedIds(MAX_TRACK_ID_PAGE, (offset, limit) =>
    library.listTrackIds({
      artistIds: [id],
      sort: 'artist',
      direction: 'asc',
      offset,
      limit
    })
  )
}

/** Split an id set into cap-sized batches so no single write exceeds `MAX_TAG_TRACK_IDS`. */
function inBatches(ids: readonly number[]): number[][] {
  const batches: number[][] = []
  for (let i = 0; i < ids.length; i += MAX_TAG_TRACK_IDS) {
    batches.push(ids.slice(i, i + MAX_TAG_TRACK_IDS))
  }
  return batches
}

async function applyToAll(label: string): Promise<void> {
  const id = artistId.value
  if (id === null || busy.value) return
  busy.value = true
  try {
    const ids = await resolveArtistTrackIds(id)
    for (const batch of inBatches(ids)) {
      if (batch.length > 0) await tags.add(batch, label)
    }
  } finally {
    busy.value = false
  }
}

async function removeFromAll(tagId: number): Promise<void> {
  const id = artistId.value
  if (id === null || busy.value) return
  busy.value = true
  try {
    const ids = await resolveArtistTrackIds(id)
    for (const batch of inBatches(ids)) {
      if (batch.length > 0) await tags.remove(batch, tagId)
    }
  } finally {
    busy.value = false
  }
}

/**
 * A commit can arrive twice from one gesture — `UInputMenu` fires `create` and
 * then selects the new value. The set absorbs the pair within the tick, matching
 * the Track pane: one keystroke is one apply whichever events fire.
 */
const committing = new Set<string>()

function commit(raw: string): void {
  const label = raw.trim()
  const key = label.toLowerCase()
  if (key === '' || committing.has(key)) return
  committing.add(key)
  void nextTick(() => committing.delete(key))
  void applyToAll(label)
}

function onSelectExisting(value: string | undefined): void {
  if (value != null) commit(value)
}

function chipItems(tag: TagCoverage): DropdownMenuItem[][] {
  return [
    [
      {
        label: `Apply to all ${total.value.toLocaleString()} tracks`,
        icon: 'i-tabler-arrows-maximize',
        // Nothing to do when it is already on every track — the row is full.
        disabled: busy.value || tag.carried >= total.value,
        onSelect: () => void applyToAll(tag.label)
      },
      {
        label: 'Remove from everything by this artist',
        icon: 'i-tabler-x',
        disabled: busy.value,
        onSelect: () => void removeFromAll(tag.id)
      }
    ]
  ]
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain">
    <template v-if="state === 'ready'">
      <section class="flex flex-col gap-1.5">
        <ul v-if="rows.length > 0" class="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li v-for="tag in rows" :key="tag.id">
            <UDropdownMenu :items="chipItems(tag)" :content="{ align: 'start', sideOffset: 4 }">
              <button
                type="button"
                class="group inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pr-1.5 pl-2 text-xs text-default outline-none transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70 disabled:opacity-50"
                :disabled="busy"
                :title="`On ${tag.carried.toLocaleString()} of ${total.toLocaleString()} tracks by this artist. Apply to all, or remove.`"
              >
                {{ tag.label }}
                <span
                  class="rounded-full bg-elevated/60 px-1 text-[0.65rem] leading-4 text-muted tabular-nums"
                  :class="{ 'text-primary': tag.carried >= total }"
                >
                  {{ tag.carried.toLocaleString() }}/{{ total.toLocaleString() }}
                </span>
              </button>
            </UDropdownMenu>
          </li>
        </ul>
        <p v-else class="text-xs text-muted">
          <template v-if="artistId === null">This track has no artist to gather tags by.</template>
          <template v-else>No tags of your own across this artist’s catalog yet.</template>
        </p>
      </section>

      <!--
        Add reaches the whole artist: this pane's one write scope is the catalogue,
        so unlike the Track pane there is no scope select — the input is the add,
        and it lands on every track by this artist.
      -->
      <div v-if="artistId !== null" class="mt-auto pt-1">
        <UInputMenu
          :model-value="undefined"
          :items="vocabularyItems"
          :create-item="true"
          :disabled="busy"
          size="xs"
          icon="i-tabler-tag"
          :placeholder="
            artistName ? `Tag everything by ${artistName}…` : 'Tag everything by this artist…'
          "
          class="w-full min-w-0"
          aria-label="Tag everything by this artist"
          @update:model-value="onSelectExisting"
          @create="commit"
        />
      </div>
    </template>

    <p v-else-if="state === 'standby'" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This follows the current track.
    </p>

    <p v-else class="px-1 py-4 text-center text-xs text-dimmed">Looking…</p>
  </div>
</template>
