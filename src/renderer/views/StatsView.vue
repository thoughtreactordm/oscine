<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { formatListeningTime } from '@renderer/panels/displayFormat'
import ListeningChart from '@renderer/panels/listening/ListeningChart.vue'
import { LISTENING_RANGES, rangeLabel } from '@renderer/panels/listening/listeningRange'
import { RANKED_LISTS } from '@renderer/panels/listening/listeningRows'
import RankedList from '@renderer/panels/listening/RankedList.vue'
import { useBrowseStore } from '@renderer/stores/browse'
import { useListeningStore } from '@renderer/stores/listening'
import { STATS_SORTS, type StatsSort } from '@shared/stats'

/**
 * The Stats dashboard — **D17**, and a dashboard rather than a retrospective.
 *
 * It answers "what have I been listening to" at whatever moment it is opened,
 * which is a different artifact from one that performs a year back at you in
 * December. The retrospective is W10-14 and is deliberately not folded in here:
 * its unsolved problems are narrative and presentation, and a surface trying to
 * be both would be neither.
 *
 * ## It is a tab, which the card called a Sources destination
 *
 * The card asked for "a new top-level destination in `Sources.vue`, alongside
 * Library and Podcasts". `Sources.vue` holds no such list — it is the Library
 * tab's own sidebar, and the top-level destinations have been the shell's tab
 * row since the router landed. So this is a tab in `routes.ts`, which is where
 * Library and Podcasts actually are; the intent is unchanged and the file the
 * card names is simply not the file that grew that responsibility.
 *
 * It takes no sidebar, like Now Playing. The range selector scopes everything
 * below it and belongs in one row above the content, not in a rail beside it,
 * and four ranked lists and a chart want the width.
 *
 * ## The filter row scopes the whole view
 *
 * One range and one sort, above everything, and every panel below re-reads
 * against the same slice — so the headline totals, the rankings and the chart
 * can never disagree about what window they are describing. A per-panel range
 * would let them.
 *
 * A reload holds the previous frame at reduced opacity rather than blanking or
 * flashing a skeleton. The selector already shows what was asked for, so a
 * dimmed frame reads as "catching up" while an empty one reads as broken —
 * which matters most on all-time over a large log, where the wait is long
 * enough to see.
 */

const router = useRouter()
const browse = useBrowseStore()
const listening = useListeningStore()

/** Mounting is the question. Coming back to the tab should show what is true now. */
onMounted(() => void listening.load())

const SORT_LABELS: Readonly<Record<StatsSort, string>> = {
  listens: 'By plays',
  time: 'By time'
}

/**
 * The headline numbers, in one place so the tiles cannot drift from the summary.
 *
 * Five rather than the card's four: `albums` is already on `StatsSummary` and
 * costs nothing to show, and "how many records did I put on" is a sentence
 * worth having beside how many songs.
 */
const tiles = computed(() => {
  const summary = listening.summary
  if (summary === null) return []
  return [
    { key: 'listens', label: 'Plays', value: summary.listens.toLocaleString() },
    { key: 'time', label: 'Time listened', value: formatListeningTime(summary.msListened) },
    { key: 'tracks', label: 'Tracks', value: summary.tracks.toLocaleString() },
    { key: 'artists', label: 'Artists', value: summary.artists.toLocaleString() },
    { key: 'albums', label: 'Albums', value: summary.albums.toLocaleString() }
  ]
})

/**
 * Whether the range came back with nothing in it.
 *
 * A real answer, not a failure — which is why it is read off `summary` rather
 * than off an error flag, and why the panel it produces invites rather than
 * apologises.
 */
const empty = computed(() => listening.summary !== null && listening.summary.listens === 0)

/**
 * Where a clicked row goes: the library, narrowed to the row's own words.
 *
 * The approximation and its reasons are `revealTextFor`'s; what belongs here is
 * only that the two halves happen together — narrowing the library on a tab the
 * operator is not looking at would be a click that appeared to do nothing.
 */
function reveal(text: string): void {
  browse.revealSearch(text)
  void router.push({ name: 'library' })
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="Stats">
    <!--
      One filter row, above everything it scopes. Never inside a card and never
      per-panel: two ranges on one screen is two screens.
    -->
    <header
      class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-default bg-elevated/40 px-3 py-2"
    >
      <div class="flex items-center gap-2" role="group" aria-labelledby="stats-range-label">
        <span id="stats-range-label" class="text-xs font-medium uppercase tracking-wide text-muted">
          Range
        </span>
        <div class="flex items-center gap-1">
          <UButton
            v-for="preset in LISTENING_RANGES"
            :key="preset.id"
            :label="preset.label"
            size="xs"
            :color="listening.rangeId === preset.id ? 'primary' : 'neutral'"
            :variant="listening.rangeId === preset.id ? 'soft' : 'ghost'"
            :aria-pressed="listening.rangeId === preset.id"
            @click="listening.rangeId = preset.id"
          />
        </div>
      </div>

      <div class="ml-auto flex items-center gap-1" role="group" aria-label="Rank by">
        <UButton
          v-for="option in STATS_SORTS"
          :key="option"
          :label="SORT_LABELS[option]"
          size="xs"
          :color="listening.sort === option ? 'primary' : 'neutral'"
          :variant="listening.sort === option ? 'soft' : 'ghost'"
          :aria-pressed="listening.sort === option"
          @click="listening.sort = option"
        />
        <UButton
          icon="i-tabler-refresh"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="listening.loading"
          aria-label="Refresh"
          @click="listening.load()"
        />
      </div>
    </header>

    <UAlert
      v-if="listening.failed"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      title="Could not read your listening history"
      description="The library did not answer. Nothing has been lost. The log is on disk."
      class="rounded-none"
      :actions="[{ label: 'Retry', color: 'neutral', onClick: () => listening.load() }]"
    />

    <p
      v-else-if="!listening.answered"
      class="px-3 py-8 text-center text-sm text-muted"
      role="status"
    >
      Reading your listening…
    </p>

    <!--
      Two empties, and which one this is comes from `logEmpty` rather than from
      the range. A log with nothing in it anywhere is a new library and gets an
      invitation; an empty window over a log that has something in it is a quiet
      month, and the useful next move is a wider one. Deciding this from the
      range alone is what sent a first-run dashboard to an All time that was
      just as blank.
    -->
    <UEmpty
      v-else-if="empty"
      variant="naked"
      icon="i-tabler-headphones"
      :title="
        listening.logEmpty
          ? 'Nothing here yet'
          : `Nothing played in the last ${rangeLabel(listening.rangeId).toLowerCase()}`
      "
      :description="
        listening.logEmpty
          ? 'Play something and it will show up here: what you played, how long for, and what it all added up to.'
          : 'Everything you play is still being recorded. Try a wider window.'
      "
      class="min-h-0 flex-1"
      :actions="
        listening.logEmpty || listening.rangeId === 'all'
          ? []
          : [{ label: 'All time', color: 'neutral', onClick: () => (listening.rangeId = 'all') }]
      "
    />

    <div
      v-else
      class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 transition-opacity"
      :class="listening.loading ? 'opacity-60' : 'opacity-100'"
    >
      <!-- A KPI row, not a grouped bar chart: these are five headline numbers. -->
      <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div
          v-for="tile in tiles"
          :key="tile.key"
          class="rounded-md border border-default bg-default px-3 py-2"
        >
          <dt class="text-xs text-muted">{{ tile.label }}</dt>
          <dd class="text-xl font-semibold text-highlighted">{{ tile.value }}</dd>
        </div>
      </dl>

      <section
        class="rounded-md border border-default bg-default p-3"
        aria-label="Listening over time"
      >
        <ListeningChart
          v-if="listening.series"
          :points="listening.series.points"
          :bucket="listening.series.bucket"
          :sort="listening.sort"
        />
        <p v-else class="py-6 text-center text-xs text-muted">No series for this window yet.</p>
      </section>

      <div class="grid gap-3 lg:grid-cols-2">
        <RankedList
          v-for="spec in RANKED_LISTS"
          :key="spec.dimension"
          :spec="spec"
          :result="listening.ranking(spec.dimension)"
          :sort="listening.sort"
          @reveal="reveal"
        />
      </div>
    </div>
  </section>
</template>
