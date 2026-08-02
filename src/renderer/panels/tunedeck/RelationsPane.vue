<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ARTIST_RELATION_LIMIT } from '@shared/artistRelations'
import { visibleRange } from '@renderer/panels/listViewport'
import { useDeferredFlag } from '@renderer/panels/tunedeck/loadingDelay'
import { buildRelationRows, type RelationRow } from '@renderer/panels/tunedeck/relationRows'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'
import { useArtistRelationsStore } from '@renderer/stores/artistRelations'
import { useBrowseStore } from '@renderer/stores/browse'

/**
 * Who this artist plays with, and which of them you already own — **D14**'s
 * third source, and the reason the deck is not a sidebar with a picture in it.
 *
 * The pane the card calls "the reason deferring last.fm is survivable". A
 * taste-similarity list is a black box that needs an API key; this is a curated
 * fact about the world joined to the folders on your disk, and "the drummer's
 * other band, which you own three albums by" is a better place to go next than
 * any ranking.
 *
 * ## Whose relations these are
 *
 * Every branch reads `current` rather than the store's `result`, which is
 * `BiographyPane`'s rule and matters more here. The identity is keyed on the
 * *track* and moves on every skip; this graph is keyed on the resolved *artist*
 * and arrives later. Drawing whatever the store happens to hold would put one
 * band's line-up under another band's name for the length of a MusicBrainz round
 * trip — a detailed, confident and entirely wrong account of somebody else,
 * which is **R5** exactly.
 *
 * Main will not answer for an unresolved artist at all, so that is two
 * independent guards on the same failure rather than one. The card asks for it
 * by name.
 *
 * ## Ownership is drawn twice, on purpose
 *
 * Once as the track count, which is the proposition, and once as the arrow that
 * says the row goes somewhere. A name-matched row is marked separately again:
 * the join behind it is a comparison of two strings, "Nirvana" resolves eleven
 * ways, and a pane that presented a guess and an identity match identically
 * would be hiding the only part of this an operator could catch us being wrong
 * about.
 */

const router = useRouter()
const identity = useArtistIdentityStore()
const relations = useArtistRelationsStore()
const browse = useBrowseStore()

const ROW_PX = 36

const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

/** Nothing is playing at all, as opposed to playing something unidentified. */
const idle = computed(() => identity.seedId === null)

/** The artist a relation graph would be *of*, or `null` when there is not one yet. */
const artistId = computed(() => {
  const resolution = identity.resolution
  if (!resolution || resolution.mbid === null) return null
  return resolution.artistId
})

const unresolved = computed(() => identity.resolution !== null && identity.resolution.mbid === null)

/** What the store holds, but only if it holds it about whoever is playing now. */
const current = computed(() =>
  artistId.value !== null && relations.artistId === artistId.value ? relations.result : null
)

const rows = computed(() => buildRelationRows(current.value))

const failure = computed(() => current.value?.failure ?? null)

/** Nothing valid to draw, and something that would change that is in flight. */
const blank = computed(() => !idle.value && !unresolved.value && current.value === null)

/**
 * A lookup slow enough to be worth admitting to.
 *
 * Deferred, so skipping between two tracks by the same artist — where the
 * identity re-resolves from SQLite in a millisecond and the graph does not move
 * at all — does not strobe a placeholder over a list that never changed.
 */
const slow = useDeferredFlag(() => identity.loading || relations.loading)

const waiting = computed(() => !idle.value && !unresolved.value && (blank.value || slow.value))

const visible = computed(() =>
  visibleRange({
    total: rows.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => rows.value.slice(visible.value.first, visible.value.last + 1))

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

/** Only a row the library actually holds stands for somewhere to go. */
function isNavigable(row: RelationRow): boolean {
  return row.kind === 'relation' && row.relation.match !== null
}

/**
 * Opens the artist in the library.
 *
 * Two halves that have to happen together: the browse predicate becomes this one
 * artist, and the frame moves to the tab that renders it. Filtering without
 * navigating leaves the operator on the deck wondering what their click did, and
 * navigating without filtering drops them into an unchanged library.
 *
 * The deck is left open. It is a companion surface — the whole gesture is
 * "follow this thread while the music keeps playing" — and shutting it would
 * throw away the graph they were reading half of.
 */
async function activate(row: RelationRow): Promise<void> {
  if (row.kind !== 'relation') return
  const match = row.relation.match
  if (match === null) return

  browse.revealArtist(match.artistId)
  await router.push({ name: 'library' })
}

function rowTitle(row: RelationRow): string {
  if (row.kind !== 'relation') return ''

  const parts = [row.relation.name]
  if (row.detail !== null) parts.push(row.detail)

  const match = row.relation.match
  if (match !== null) {
    parts.push(
      row.uncertain
        ? `Matched to “${match.name}” in your library by name, which may be a different artist`
        : `In your library as “${match.name}”`
    )
  }
  return parts.join(' — ')
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!--
      Virtualized from the first commit, per the standing invariant, and this is
      the pane that needs it least theoretically and most in practice: an
      orchestra's MusicBrainz page carries several hundred membership relations,
      and `ARTIST_RELATION_LIMIT` caps that at 250 rows rather than at none.
      Every row kind is `ROW_PX` tall, which keeps `visibleRange` arithmetic.
    -->
    <template v-if="rows.length > 0 && !waiting">
      <div
        :ref="measure"
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        @scroll.passive="onScroll"
      >
        <div :style="{ height: `${visible.topPx}px` }" aria-hidden="true" />
        <ul class="m-0 list-none p-0">
          <li
            v-for="row in drawn"
            :key="row.key"
            class="flex items-center gap-1.5 rounded-sm px-1 outline-none"
            :class="
              isNavigable(row)
                ? 'group relative cursor-default transition-colors hover:bg-elevated/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70'
                : ''
            "
            :style="{ height: `${ROW_PX}px` }"
            :tabindex="isNavigable(row) ? 0 : -1"
            :title="rowTitle(row)"
            @dblclick="activate(row)"
            @keydown.enter="activate(row)"
          >
            <template v-if="row.kind === 'header'">
              <UIcon :name="row.icon" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
              <span
                class="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-muted"
              >
                {{ row.label }}
              </span>
              <span class="shrink-0 text-xs tabular-nums text-dimmed">{{ row.count }}</span>
            </template>

            <template v-else>
              <!--
                The arrow is the affordance and it only exists on rows that go
                somewhere. An unowned artist is still worth reading — it is the
                other half of the graph — but it is not a link, and drawing one
                on it would promise a page this app does not have.

                Dimmed at rest rather than hidden until hover, which is where
                this started and where it read backwards: with the arrow revealed
                on hover only, the *unowned* rows were the ones carrying a visible
                marker and the owned ones sat behind blank space. The rows that
                do something have to look like it without being pointed at.
              -->
              <UIcon
                :name="isNavigable(row) ? 'i-tabler-arrow-narrow-right' : 'i-tabler-point'"
                class="size-3.5 shrink-0 opacity-40 transition-opacity"
                :class="isNavigable(row) ? 'text-primary group-hover:opacity-100' : 'text-dimmed'"
                aria-hidden="true"
              />

              <span class="flex min-w-0 flex-1 flex-col justify-center leading-tight">
                <span class="truncate text-sm text-default">{{ row.relation.name }}</span>
                <span v-if="row.detail !== null" class="truncate text-xs text-dimmed">
                  {{ row.detail }}
                </span>
              </span>

              <!--
                The ownership badge, and the reason the pane exists. The dotted
                underline on a name match is the whole of the card's "its
                imprecision is acknowledged rather than hidden" — same wording,
                visibly less certain, and the tooltip says which library row it
                landed on so the operator can judge it themselves.
              -->
              <span
                v-if="row.owned !== null"
                class="shrink-0 rounded-sm px-1 py-0.5 text-xs tabular-nums"
                :class="
                  row.uncertain
                    ? 'text-muted underline decoration-dotted underline-offset-2'
                    : 'bg-primary/10 text-primary'
                "
              >
                {{ row.owned }}
              </span>
            </template>
          </li>
        </ul>
        <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
      </div>

      <!--
        Said once, at the bottom, rather than as a row in the list. A truncated
        graph is a fact about the whole pane and not about any row in it, and
        main has already sorted so that nothing owned was among the dropped.
      -->
      <p
        v-if="current?.truncated"
        class="shrink-0 border-t border-default px-1 pt-1.5 text-xs text-dimmed"
      >
        Showing the first {{ ARTIST_RELATION_LIMIT.toLocaleString() }} connections.
      </p>
    </template>

    <!--
      Six states, and they are deliberately six. "Nothing is playing", "we do not
      know who this is", "the lookup is running", "the lookup failed" and
      "MusicBrainz records no connections" are different facts with different
      next moves, and the second of them is the one the card names: an artist we
      could not identify shows a sentence rather than somebody else's band.
    -->
    <p v-else-if="idle" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This follows the current track.
    </p>

    <p v-else-if="unresolved" class="px-1 py-4 text-center text-xs text-muted">
      This artist has not been identified, so there is nothing to connect them to.
    </p>

    <p v-else-if="waiting" class="px-1 py-4 text-center text-xs text-dimmed">Looking…</p>

    <div v-else-if="failure || relations.failed" class="flex flex-col items-center gap-2 px-1 py-4">
      <p class="text-center text-xs text-muted">
        {{ failure?.message ?? 'Could not reach MusicBrainz.' }}
      </p>
      <UButton
        label="Try again"
        size="xs"
        color="neutral"
        variant="subtle"
        @click="relations.refresh()"
      />
    </div>

    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      MusicBrainz records no other artists connected to this one.
    </p>
  </div>
</template>
