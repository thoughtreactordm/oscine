<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { normalizeLabel } from '@shared/genre'
import { MAX_TRACK_ID_PAGE } from '@shared/library'
import type { TrackFacets } from '@shared/library'
import type { TagSuggestion, TrackTagAssignment } from '@shared/tags'
import { collectPagedIds } from '@renderer/panels/pagedIds'
import { library } from '@renderer/ipc'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useTagsStore } from '@renderer/stores/tags'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * The operator's own record of a track — **W15-3**.
 *
 * Two vocabularies kept apart, the same way the store keeps them. The file's
 * genres are shown for reference and are read-only: v1 never writes a tag back
 * to disk (**D7**), so what is in the file stays the file's. The user tags are
 * the editable half — the reason this pane exists — and everything in it works
 * with the network unplugged, because a label the operator typed is not a claim
 * about the world that a lookup could settle.
 *
 * ## Add is scoped, remove is not
 *
 * `Add to` names one of three sets — this track, its album, everyone by its
 * artist — because a tag worth applying is often worth applying to more than the
 * one track that happens to be playing (**this is why `tags.add` takes an id
 * batch**). The sets are resolved from `library.listTrackIds`, paged to the end
 * with `collectPagedIds`: a batch that silently stopped at one page would be the
 * quiet-wrong-selection this whole id layer is written to avoid. Removing a chip
 * only ever touches this track. A remove that reached across an album would be a
 * destructive gesture wearing an ✕ meant for one row, and the chip the operator
 * clicked is this track's.
 *
 * ## Why the ids come from a facet lookup
 *
 * The album and artist sets need the numeric facet ids, and the playing `Track`
 * carries neither — only the strings. `library.trackFacets` resolves both in the
 * browse dimension's own space, so `listTrackIds({ artistIds })` picks exactly
 * the set the Artist facet would, the playing track included. It is one indexed
 * local probe, fetched on the same `showing`-gated trigger the deck loads
 * everything else on; a machine with the cable pulled still gets its answer.
 */

const playback = usePlaybackStore()
const tags = useTagsStore()
const tunedeck = useTunedeckStore()
const identity = useArtistIdentityStore()

type Scope = 'track' | 'album' | 'artist'

const scope = ref<Scope>('track')
const facets = ref<TrackFacets | null>(null)
const busy = ref(false)

/**
 * The D14 suggestions for the current subject — **W15-4**.
 *
 * Pane-owned and transient: fetched when the subject changes, and reset first so
 * a slow lookup can never paint the last track's genres over this one's. Empty is
 * the ordinary state — consent off, an unresolved artist, an offline machine —
 * and reads as no "Suggested" section at all rather than an error.
 */
const suggestions = ref<TagSuggestion[]>([])

/** Loaded once, lazily, the first time the deck shows this — the vocabulary is library-wide. */
let vocabularyRequested = false

const view = computed(() => {
  const id = playback.nowPlaying?.id
  return id === undefined ? undefined : tags.forTrack(id)
})

const state = computed<'standby' | 'loading' | 'ready'>(() => {
  if (!playback.nowPlaying) return 'standby'
  return view.value === undefined ? 'loading' : 'ready'
})

const fileGenres = computed<readonly string[]>(() => view.value?.file ?? [])
const userTags = computed<readonly TrackTagAssignment[]>(() => view.value?.user ?? [])

/**
 * The casefold keys the track already carries, from either vocabulary.
 *
 * The same fold main deduped against (`normalizeLabel`), recomputed here so that
 * accepting a suggestion collapses its chip the instant the store's optimistic
 * add lands — no second lookup, and no chip offering a tag the operator just
 * adopted. Removing a user tag that matched a suggestion re-surfaces it the same
 * way.
 */
const existingKeys = computed(() => {
  const keys = new Set<string>()
  for (const genre of fileGenres.value) {
    const norm = normalizeLabel(genre)
    if (norm) keys.add(norm.key)
  }
  for (const tag of userTags.value) {
    const norm = normalizeLabel(tag.label)
    if (norm) keys.add(norm.key)
  }
  return keys
})

/** Suggestions minus anything the track now carries — weight order kept from main. */
const suggestedTags = computed(() =>
  suggestions.value.filter((tag) => !existingKeys.value.has(normalizeLabel(tag.label)?.key ?? ''))
)

/** The vocabulary as the input's suggestion list — labels only. */
const vocabularyItems = computed(() => tags.vocabulary.map((tag) => tag.label))

const artistName = computed(() => {
  const track = playback.nowPlaying
  return track ? (track.albumArtist ?? track.artist) : null
})

const scopeItems = computed(() => [
  { label: 'This track', value: 'track' as const },
  {
    label: 'This album',
    value: 'album' as const,
    disabled: facets.value?.albumId == null
  },
  {
    label: artistName.value ? `Everything by ${artistName.value}` : 'Everything by this artist',
    value: 'artist' as const,
    disabled: facets.value?.artistId == null
  }
])

watch(
  [() => tunedeck.showing, () => playback.nowPlaying?.id ?? null],
  ([showing, trackId]) => {
    // A new subject starts on its own track, never on the last one's album — a
    // stale `Add to` is the one way this pane could tag a set nobody chose.
    scope.value = 'track'
    facets.value = null
    if (!showing || trackId === null) return
    // Defensive: `useDeckData` ensures this for the badge, but the pane must draw
    // even if it did not. Idempotent in the store.
    void tags.ensureTrack(trackId)
    if (!vocabularyRequested) {
      vocabularyRequested = true
      void tags.loadVocabulary()
    }
    void loadFacets(trackId)
  },
  { immediate: true }
)

/**
 * Suggestions follow the resolved *artist*, not the raw track — the second
 * watcher `useDeckData` runs, and for its reason. The deck resolves the identity
 * asynchronously (`identity.load`), so at the instant the track changes there is
 * no MBID on the `artists` row yet; loading on the track trigger would race the
 * resolution and read an empty answer that nothing re-asks. Watching the store's
 * resolved MBID instead means the "Suggested" section fills when the identity
 * arrives, refreshes when the operator corrects it in the picker, and clears for
 * an artist resolved to "none of these" rather than stranding the last one's.
 *
 * The MBID here is only the readiness signal; `loadSuggestions` passes the
 * current track id, and main reads that track's own artist row — so a suggestion
 * is always the playing track's artist's, whatever the store happens to show for
 * a frame across a skip.
 */
watch(
  [
    () => tunedeck.showing,
    () => playback.nowPlaying?.id ?? null,
    () => identity.resolution?.mbid ?? null
  ],
  ([showing, trackId, mbid]) => {
    suggestions.value = []
    if (!showing || trackId === null || mbid === null) return
    void loadSuggestions(trackId)
  },
  { immediate: true }
)

async function loadSuggestions(trackId: number): Promise<void> {
  const resolved = await tags.suggest(trackId)
  // The subject can change across the await; only the current track's
  // suggestions belong on screen.
  if ((playback.nowPlaying?.id ?? null) === trackId) suggestions.value = resolved
}

async function loadFacets(trackId: number): Promise<void> {
  const resolved = await library.trackFacets(trackId)
  // The track can change across the await; only the current subject's facets
  // belong on screen.
  if ((playback.nowPlaying?.id ?? null) === trackId) facets.value = resolved
}

async function resolveScopeTrackIds(trackId: number): Promise<number[]> {
  const current = facets.value
  const albumId = current?.albumId
  if (scope.value === 'album' && albumId != null) {
    return collectPagedIds(MAX_TRACK_ID_PAGE, (offset, limit) =>
      library.listTrackIds({
        albumIds: [albumId],
        sort: 'trackNo',
        direction: 'asc',
        offset,
        limit
      })
    )
  }
  const artistId = current?.artistId
  if (scope.value === 'artist' && artistId != null) {
    return collectPagedIds(MAX_TRACK_ID_PAGE, (offset, limit) =>
      library.listTrackIds({
        artistIds: [artistId],
        sort: 'artist',
        direction: 'asc',
        offset,
        limit
      })
    )
  }
  return [trackId]
}

/**
 * A commit can arrive twice from one gesture — `UInputMenu` fires `create` and
 * then selects the new value, which fires `update:modelValue` too. The set
 * absorbs the pair within the tick and clears on the next, so one keystroke is
 * one add whichever events the component chose to send.
 */
const committing = new Set<string>()

function commit(raw: string): void {
  const label = raw.trim()
  const key = label.toLowerCase()
  if (key === '' || committing.has(key)) return
  committing.add(key)
  void nextTick(() => committing.delete(key))
  void addToScope(label)
}

async function addToScope(label: string): Promise<void> {
  const track = playback.nowPlaying
  if (!track || busy.value) return
  busy.value = true
  try {
    const ids = await resolveScopeTrackIds(track.id)
    if (ids.length > 0) await tags.add(ids, label)
  } finally {
    busy.value = false
  }
}

function onSelectExisting(value: string | undefined): void {
  if (value != null) commit(value)
}

async function removeTag(tag: TrackTagAssignment): Promise<void> {
  const track = playback.nowPlaying
  if (!track || busy.value) return
  busy.value = true
  try {
    await tags.remove([track.id], tag.id)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain">
    <template v-if="state === 'ready'">
      <!--
        The file's own genres, and it says so. Muted, no ✕: they are read-only
        because v1 never writes a tag back to disk (D7), and a chip that looked
        removable would be promising an edit the app has decided not to make.
      -->
      <section v-if="fileGenres.length > 0" class="flex flex-col gap-1.5">
        <h3 class="text-xs font-medium text-muted">From the file</h3>
        <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li
            v-for="genre in fileGenres"
            :key="genre"
            class="inline-flex items-center gap-1 rounded-full bg-elevated/50 px-2 py-0.5 text-xs text-muted"
            :title="`“${genre}” — from the file’s tag. Read-only.`"
          >
            <UIcon
              name="i-tabler-file-music"
              class="size-3 shrink-0 text-dimmed"
              aria-hidden="true"
            />
            {{ genre }}
          </li>
        </ul>
      </section>

      <!-- The editable half: the operator's own labels on this track. -->
      <section class="flex flex-col gap-1.5">
        <h3 class="text-xs font-medium text-muted">Your tags</h3>
        <ul v-if="userTags.length > 0" class="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li
            v-for="tag in userTags"
            :key="tag.id"
            class="group inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2 text-xs text-default"
          >
            {{ tag.label }}
            <button
              type="button"
              class="flex size-4 items-center justify-center rounded-full text-dimmed outline-none transition-colors hover:bg-primary/20 hover:text-default focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70 disabled:opacity-50"
              :disabled="busy"
              :aria-label="`Remove ${tag.label} from this track`"
              :title="`Remove “${tag.label}” from this track`"
              @click="removeTag(tag)"
            >
              <UIcon name="i-tabler-x" class="size-3" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-else class="text-xs text-muted">No tags of your own on this track yet.</p>
      </section>

      <!--
        Suggested — W15-4. Genres and tags MusicBrainz records for this track's
        artist, vote-ordered and already deduped against both vocabularies above.
        Nothing auto-applies: each chip is a button, and tapping it is an ordinary
        add through the `Add to` scope below, so acceptance makes the claim the
        operator's own record (R5) at whatever reach they chose. A dashed outline
        and a + say "not yours yet"; the moment one is adopted it collapses out.
      -->
      <section v-if="suggestedTags.length > 0" class="flex flex-col gap-1.5">
        <h3 class="text-xs font-medium text-muted">Suggested</h3>
        <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li v-for="tag in suggestedTags" :key="tag.label">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full border border-dashed border-primary/40 py-0.5 pr-2 pl-1.5 text-xs text-muted outline-none transition-colors hover:border-primary/60 hover:bg-primary/10 hover:text-default focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70 disabled:opacity-50"
              :disabled="busy"
              :aria-label="`Add ${tag.label} to this track`"
              :title="`Suggested by MusicBrainz (${tag.count} votes). Click to add.`"
              @click="addToScope(tag.label)"
            >
              <UIcon name="i-tabler-plus" class="size-3 shrink-0 text-dimmed" aria-hidden="true" />
              {{ tag.label }}
            </button>
          </li>
        </ul>
      </section>

      <!--
        Add is the one action with a reach. `Add to` names the set; removing a
        chip above never touches anything but this track, which is why the scope
        sits with the add and not over the whole pane.
      -->
      <div class="mt-auto flex items-center gap-1.5 pt-1">
        <USelect
          :model-value="scope"
          value-key="value"
          :items="scopeItems"
          size="xs"
          class="shrink-0"
          aria-label="Add to"
          @update:model-value="scope = $event"
        />
        <UInputMenu
          :model-value="undefined"
          :items="vocabularyItems"
          :create-item="true"
          :disabled="busy"
          size="xs"
          icon="i-tabler-tag"
          placeholder="Add a tag…"
          class="min-w-0 flex-1"
          aria-label="Add a tag"
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
