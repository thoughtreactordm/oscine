<script setup lang="ts">
import { computed } from 'vue'
import { WIKIPEDIA_LICENCE_NAME, WIKIPEDIA_LICENCE_URL } from '@shared/biography'
import { biographyParagraphs, previewBiography } from '@renderer/panels/tunedeck/biographyText'
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
 * ## Six states
 *
 * Nothing playing, no identity yet, looking, unreachable, no article, and the
 * biography itself. The two middle empty states are the ones the card is about:
 * an artist Wikipedia has never heard of is a normal outcome and gets a sentence
 * rather than a warning, while a Wikipedia we could not reach is a failure and
 * gets a retry. Telling an operator "no biography" when the truth is "no
 * network" would send them to correct an identity that was never wrong.
 */

const identity = useArtistIdentityStore()
const biographies = useArtistBiographyStore()

/**
 * Whether there is a resolved artist to have a biography *of*.
 *
 * Read from the identity store rather than inferred from an empty result,
 * because "we have not identified this artist" and "this artist has no article"
 * are different sentences and only one of them is Wikipedia's fault. The picker
 * that fixes the first is already on the tab header above this.
 */
const unresolved = computed(() => identity.resolution !== null && identity.resolution.mbid === null)

const preview = computed(() => {
  const extract = biographies.biography?.extract
  return extract === undefined ? null : previewBiography(extract)
})

const shown = computed(() => {
  const bio = biographies.biography
  if (!bio || !preview.value) return []
  return biographyParagraphs(biographies.expanded ? bio.extract : preview.value.text)
})

/** The control only exists when there is something behind it. */
const expandable = computed(() => preview.value?.truncated === true)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <template v-if="biographies.biography">
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
            :href="biographies.biography.url"
            target="_blank"
            rel="noreferrer"
            class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
          >
            {{ biographies.biography.title }}
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
    </template>

    <p v-else-if="identity.resolution === null" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This follows the current track.
    </p>

    <p v-else-if="unresolved" class="px-1 py-4 text-center text-xs text-muted">
      This artist has not been identified, so there is nothing to look up.
    </p>

    <p
      v-else-if="biographies.loading || identity.loading"
      class="px-1 py-4 text-center text-xs text-dimmed"
    >
      Looking…
    </p>

    <div
      v-else-if="biographies.failure || biographies.failed"
      class="flex flex-col items-center gap-2 px-1 py-4"
    >
      <p class="text-center text-xs text-muted">
        {{ biographies.failure?.message ?? 'Could not reach Wikipedia.' }}
      </p>
      <UButton
        label="Try again"
        size="xs"
        color="neutral"
        variant="subtle"
        @click="biographies.refresh()"
      />
    </div>

    <p v-else class="px-1 py-4 text-center text-xs text-muted">
      Wikipedia has no article for this artist.
    </p>
  </div>
</template>
