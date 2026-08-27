<script setup lang="ts">
import { computed, ref } from 'vue'
import { ARTIST_LINK_LIMIT } from '@shared/artistLinks'
import { appInfo } from '@renderer/ipc'
import { visibleRange } from '@renderer/panels/listViewport'
import { buildLinkRows, type LinkRow } from '@renderer/panels/tunedeck/artistLinks'
import { useDeferredFlag } from '@renderer/panels/tunedeck/loadingDelay'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'
import { useArtistLinksStore } from '@renderer/stores/artistLinks'

/**
 * Where this artist is on the web — homepage, Bandcamp, purchase and socials,
 * from MusicBrainz's `url-rels`. **D14**'s fourth source, and the one gesture in
 * the deck that leaves the app.
 *
 * ## Every link opens outside
 *
 * A click is `shell.openExternal`, never a `BrowserWindow` and never a view of
 * this pane's own. That is the card's third acceptance criterion and the same
 * rule the last.fm auth flow states: this app has no in-app browser, so a
 * third-party page opens in the operator's, where their sign-ins and their
 * blocker already are. The URL still crosses `app.openExternal`, which fixes the
 * scheme to http/https regardless of what this pane hands it — the renderer is
 * not the layer that gets to decide a link is safe to launch.
 *
 * ## Whose links these are
 *
 * Every branch reads `current` rather than the store's `result`, which is
 * `RelationsPane`'s rule and matters as much here. The identity is keyed on the
 * *track* and moves on every skip; these links are keyed on the resolved *artist*
 * and arrive later. Offering whatever the store happens to hold would put one
 * artist's homepage under another's name for the length of a MusicBrainz round
 * trip — and here that is not a wrong sentence but a link to the wrong front
 * door. Main will not answer for an unresolved artist at all, so that is two
 * guards on the same failure.
 */

const identity = useArtistIdentityStore()
const store = useArtistLinksStore()

const ROW_PX = 36

const scrollTop = ref(0)
const viewportPx = ref(0)
const list = ref<HTMLElement | null>(null)

/** Nothing is playing at all, as opposed to playing something unidentified. */
const idle = computed(() => identity.seedId === null)

/** The artist these links would be *of*, or `null` when there is not one yet. */
const artistId = computed(() => {
  const resolution = identity.resolution
  if (!resolution || resolution.mbid === null) return null
  return resolution.artistId
})

const unresolved = computed(() => identity.resolution !== null && identity.resolution.mbid === null)

/** What the store holds, but only if it holds it about whoever is playing now. */
const current = computed(() =>
  artistId.value !== null && store.artistId === artistId.value ? store.result : null
)

const rows = computed(() => buildLinkRows(current.value))

const failure = computed(() => current.value?.failure ?? null)

/** Nothing valid to draw, and something that would change that is in flight. */
const blank = computed(() => !idle.value && !unresolved.value && current.value === null)

/**
 * A lookup slow enough to be worth admitting to.
 *
 * Deferred, so skipping between two tracks by the same artist — where the
 * identity re-resolves from SQLite in a millisecond and the links do not move at
 * all — does not strobe a placeholder over a list that never changed.
 */
const slow = useDeferredFlag(() => identity.loading || store.loading)

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

/**
 * Opens a link in the system browser.
 *
 * `void`, not awaited: main answers once the browser has been asked, and there
 * is nothing here to do with the answer — a failure to launch is the OS's to
 * report, not this pane's. The single click is deliberate and unlike the
 * relations pane's double-click: those rows navigate *inside* the app, where a
 * stray click costs nothing, and these launch a browser, where the affordance a
 * user expects of a link is one click. The external-glyph and the hover
 * underline say which kind of row this is.
 */
function open(row: LinkRow): void {
  if (row.kind !== 'link') return
  void appInfo.openExternal(row.link.url)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!--
      Virtualized from the first commit, per the standing invariant. No artist
      has hundreds of links, but the pane is one of a family and shares their
      viewport arithmetic rather than inventing a shorter path for the small
      case. Every row kind is `ROW_PX` tall, which keeps `visibleRange` honest.
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
              row.kind === 'link'
                ? 'group relative cursor-default transition-colors hover:bg-elevated/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70'
                : ''
            "
            :style="{ height: `${ROW_PX}px` }"
            :tabindex="row.kind === 'link' ? 0 : -1"
            :title="row.kind === 'link' ? row.link.url : ''"
            @click="open(row)"
            @keydown.enter="open(row)"
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
                The external-link glyph is the affordance, and every link row
                carries one because every link row goes out. Dimmed at rest and
                lit on hover, which is where the row also gains its underline:
                the two together say "this opens somewhere else" without a label
                spending the row's width on the word.
              -->
              <UIcon
                name="i-tabler-external-link"
                class="size-3.5 shrink-0 text-primary opacity-40 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
              <span
                class="min-w-0 flex-1 truncate text-sm text-default underline-offset-2 group-hover:underline"
              >
                {{ row.label }}
              </span>
            </template>
          </li>
        </ul>
        <div :style="{ height: `${visible.bottomPx}px` }" aria-hidden="true" />
      </div>

      <!--
        Said once, at the bottom, rather than as a row in the list. A truncated
        list is a fact about the whole pane and not about any row in it, and main
        has already sorted so the homepage is never among the dropped.
      -->
      <p
        v-if="current?.truncated"
        class="shrink-0 border-t border-default px-1 pt-1.5 text-xs text-dimmed"
      >
        Showing the first {{ ARTIST_LINK_LIMIT.toLocaleString() }} links.
      </p>
    </template>

    <!--
      The same six states as the members pane, and deliberately so: the two sit
      in one tab under one identity, and an artist we could not identify shows a
      sentence here rather than somebody else's socials.
    -->
    <p v-else-if="idle" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This follows the current track.
    </p>

    <p v-else-if="unresolved" class="px-1 py-4 text-center text-xs text-muted">
      This artist has not been identified, so there is nowhere to link to.
    </p>

    <p v-else-if="waiting" class="px-1 py-4 text-center text-xs text-dimmed">Looking…</p>

    <div v-else-if="failure || store.failed" class="flex flex-col items-center gap-2 px-1 py-4">
      <p class="text-center text-xs text-muted">
        {{ failure?.message ?? 'Could not reach MusicBrainz.' }}
      </p>
      <UButton
        label="Try again"
        size="xs"
        color="neutral"
        variant="subtle"
        @click="store.refresh()"
      />
    </div>

    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      MusicBrainz lists no homepage, store or socials for this artist.
    </p>
  </div>
</template>
