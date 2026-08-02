<script setup lang="ts">
import { computed } from 'vue'
import { WIKIPEDIA_LICENCE_NAME, WIKIPEDIA_LICENCE_URL } from '@shared/biography'
import BiographySkeleton from '@renderer/panels/tunedeck/BiographySkeleton.vue'
import { biographyParagraphs, previewBiography } from '@renderer/panels/tunedeck/biographyText'
import { useDeferredFlag } from '@renderer/panels/tunedeck/loadingDelay'
import { useArtistBiographyStore } from '@renderer/stores/artistBiography'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'

/**
 * Who this artist is, according to Wikipedia — **D14**'s second source.
 *
 * First group in the Artist tab, above the catalog. The order is the order of
 * the question: "who made this" is answered by prose before it is answered by a
 * track listing, and the catalog is the one that still works offline, so putting
 * it second costs nothing when the network is declined and reads correctly when
 * it is not.
 *
 * ## No remote markup, by construction
 *
 * Every string below is interpolated. There is no `v-html` here and none
 * anywhere in `src/renderer` — `tests/renderer/panels/noRemoteHtml.test.ts`
 * asserts that over the whole tree rather than trusting this comment. The
 * extract arrives as plain text from the `explaintext` endpoint and is stripped
 * again in main; Vue escaping it is the third and strongest of those three
 * defences. See `wikipedia/extract.ts` for why all three exist.
 *
 * ## The attribution is not optional chrome
 *
 * CC BY-SA obliges us to credit the article and name the licence, both as links.
 * It therefore renders whenever an extract does — it is not behind the expand,
 * not conditional on width, and not something a future empty state can be
 * refactored past, because it sits inside the same `v-if` as the text it
 * attributes.
 *
 * ## Whose biography this is
 *
 * Every branch below reads `current` rather than the store's `result` directly,
 * and that indirection is the load-bearing part of this component. The two
 * stores move at different speeds: the identity is keyed on the *track* and
 * changes on every skip, while the biography is keyed on the resolved *artist*
 * and arrives later. Rendering whatever the biography store happens to hold
 * means rendering the previous artist's history under the new one's name for the
 * length of a MusicBrainz round trip. Comparing the ids is what makes "we have
 * an answer" and "we have an answer *about this artist*" different questions,
 * which is the difference between a stale pane and an honest one.
 *
 * ## Six states and a placeholder
 *
 * Nothing playing, no identity yet, loading, unreachable, no article, and the
 * biography. The two middle empty states are the ones the card is about: an
 * artist Wikipedia has never heard of is a normal outcome and gets a sentence
 * rather than a warning, while a Wikipedia we could not reach is a failure and
 * gets a retry. Telling an operator "no biography" when the truth is "no
 * network" would send them to correct an identity that was never wrong.
 */

const identity = useArtistIdentityStore()
const biographies = useArtistBiographyStore()

/** Nothing is playing at all, as opposed to playing something unidentified. */
const idle = computed(() => identity.seedId === null)

/**
 * The artist a biography would be *of*, or `null` when there is not one yet.
 *
 * A resolved identity with `mbid: null` is not a missing biography — it is a
 * missing artist, which is R5's first-class unresolved state and has its own
 * sentence. The picker that fixes it is already on the tab header above this.
 */
const artistId = computed(() => {
  const resolution = identity.resolution
  if (!resolution || resolution.mbid === null) return null
  return resolution.artistId
})

const unresolved = computed(() => identity.resolution !== null && identity.resolution.mbid === null)

/** What the store holds, but only if it holds it about whoever is playing now. */
const current = computed(() =>
  artistId.value !== null && biographies.artistId === artistId.value ? biographies.result : null
)

const biography = computed(() =>
  current.value?.status === 'ready' ? current.value.biography : null
)

/**
 * Nothing valid to draw, and something that would change that is in flight.
 *
 * True the moment the resolved artist moves out from under the answer we hold,
 * which is why the skeleton needs no delay in that case: there is genuinely
 * nothing else to put there.
 */
const blank = computed(() => !idle.value && !unresolved.value && current.value === null)

/**
 * A lookup slow enough to be worth admitting to.
 *
 * Deferred, so that skipping between two tracks by the same artist — where the
 * identity re-resolves from SQLite in a millisecond and the biography does not
 * move at all — does not strobe a placeholder over text that never changed.
 */
const slow = useDeferredFlag(() => identity.loading || biographies.loading)

const skeleton = computed(() => !idle.value && !unresolved.value && (blank.value || slow.value))

const preview = computed(() => {
  const extract = biography.value?.extract
  return extract === undefined ? null : previewBiography(extract)
})

const shown = computed(() => {
  if (!biography.value || !preview.value) return []
  return biographyParagraphs(biographies.expanded ? biography.value.extract : preview.value.text)
})

/** The control only exists when there is something behind it. */
const expandable = computed(() => preview.value?.truncated === true)

const failure = computed(() => current.value?.failure ?? null)
</script>

<template>
  <!--
    `out-in`, so the outgoing state is gone before the incoming one is measured.
    A default (simultaneous) transition overlaps two absolutely-unpositioned
    blocks of different heights, and the accordion below the deck's open group
    resizes twice on every track change — which is the jump this exists to
    remove rather than to decorate.
  -->
  <Transition name="bio" mode="out-in">
    <!--
      Keyed by state rather than by content. Keying on the artist would restart
      the fade when the *same* biography is re-fetched, and keying on nothing at
      all would let Vue patch prose into prose without a transition, which is the
      one case where a crossfade actually reads as a change of subject.
    -->
    <BiographySkeleton v-if="skeleton" key="loading" />

    <div v-else-if="biography" key="ready" class="flex h-full min-h-0 flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
        <p
          v-for="(paragraph, index) in shown"
          :key="index"
          class="mb-2 text-sm leading-relaxed text-default last:mb-0"
        >
          {{ paragraph }}
        </p>

        <UButton
          v-if="expandable"
          :label="biographies.expanded ? 'Show less' : 'Show more'"
          :trailing-icon="biographies.expanded ? 'i-tabler-chevron-up' : 'i-tabler-chevron-down'"
          size="xs"
          color="neutral"
          variant="ghost"
          class="-ml-1 mt-1"
          @click="biographies.toggleExpanded()"
        />

        <!--
          The licence line. `target="_blank"` rather than an IPC call: main's
          `setWindowOpenHandler` already routes https to the system browser and
          denies the window, which is the mechanism that exists for exactly this
          and the reason the renderer needs no new surface to link out.

          Separated by a middot rather than punctuated as a sentence. Every tag
          here has to break across lines for its attributes, and the newline
          between `</a>` and a following comma renders as a space — so the
          sentence form came out as "article Nirvana (band) , available under CC
          BY-SA 4.0 ." in the built app. Observed, not theorised. A separator
          needs no punctuation adjacent to a link and reads the same at any
          width, which the deck being resizable makes worth having.
        -->
        <p class="mt-3 border-t border-default pt-2 text-xs leading-relaxed text-dimmed">
          From the Wikipedia article
          <a
            :href="biography.url"
            target="_blank"
            rel="noreferrer"
            class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
          >
            {{ biography.title }}
          </a>
          · text available under
          <a
            :href="WIKIPEDIA_LICENCE_URL"
            target="_blank"
            rel="noreferrer"
            class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
          >
            {{ WIKIPEDIA_LICENCE_NAME }}
          </a>
        </p>
      </div>
    </div>

    <p v-else-if="idle" key="idle" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This follows the current track.
    </p>

    <p v-else-if="unresolved" key="unresolved" class="px-1 py-4 text-center text-xs text-muted">
      This artist has not been identified, so there is nothing to look up.
    </p>

    <div
      v-else-if="failure || biographies.failed"
      key="failed"
      class="flex flex-col items-center gap-2 px-1 py-4"
    >
      <p class="text-center text-xs text-muted">
        {{ failure?.message ?? 'Could not reach Wikipedia.' }}
      </p>
      <UButton
        label="Try again"
        size="xs"
        color="neutral"
        variant="subtle"
        @click="biographies.refresh()"
      />
    </div>

    <p v-else key="empty" class="px-1 py-4 text-center text-xs text-muted">
      Wikipedia has no article for this artist.
    </p>
  </Transition>
</template>

<style scoped>
/*
 * A fade and nothing else — no slide, no scale.
 *
 * The pane sits inside an accordion whose height is already changing underneath
 * it, and a transform on top of that reads as two animations disagreeing. 180ms
 * matches the shorter end of `CoverArt`'s range: this is a companion pane that
 * changes on every track, so it has to be quick enough not to be noticed twice.
 */
.bio-enter-active,
.bio-leave-active {
  transition: opacity 180ms ease;
}

.bio-enter-from,
.bio-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .bio-enter-active,
  .bio-leave-active {
    transition-duration: 60ms;
  }
}
</style>
