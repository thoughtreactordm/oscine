<script setup lang="ts">
import { computed, watch } from 'vue'
import FavoriteStar from '@renderer/panels/FavoriteStar.vue'
import { describeIdentity } from '@renderer/panels/tunedeck/artistIdentity'
import ArtistPicker from '@renderer/panels/tunedeck/ArtistPicker.vue'
import { useArtistFavorites } from '@renderer/stores/artistStars'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'

/**
 * Who the deck thinks is playing, and the one control that says otherwise —
 * **R5**'s "not this artist?" affordance.
 *
 * Above the accordion rather than inside a group, because the risk it mitigates
 * is a *confident, wrong* identity: the operator has to be able to see that the
 * deck has picked the wrong Nirvana at the moment the biography beneath it is
 * telling them about the wrong band, not after they have gone looking for a
 * control. A chevron in front of it would be the difference.
 *
 * The button is present in every state including `resolved`. A correction
 * affordance that only appears when the deck already knows it is unsure is an
 * affordance that is missing in exactly the case it exists for.
 *
 * ## Why there is no rule under it
 *
 * Every other section boundary in the deck is a hairline, and this one used to
 * be too. It is not a section: `DeckBackdrop` runs behind this strip and on past
 * it into the first group, and a border here would draw a line across a
 * continuous surface and cut the picture in half. The header is the top of one
 * thing, not the first of several.
 *
 * ## Why the name is the biggest text in the deck, with room around it
 *
 * It is the answer to the question the tab asks. Everything below it — the
 * biography, the line-up, the catalogue — is elaboration on this one word, and
 * at the same size and weight as a group heading it read as another label. The
 * space is doing the same work from the other side: a name set against the top
 * of a photograph with a group heading tight beneath it is a caption on the
 * picture, and the whole point of the backdrop is that it is a surface rather
 * than something with captions on it.
 *
 * ## Where the credit went
 *
 * `BackdropCredit`, in the deck's title bar. It was inline with the name here,
 * which was right while the picture was this tab's and wrong once it became the
 * panel's: Commons requires the credit wherever the work is shown, and the work
 * is now behind all four tabs.
 */

const identity = useArtistIdentityStore()

const wording = computed(() =>
  describeIdentity(identity.resolution, {
    loading: identity.loading,
    failed: identity.failed
  })
)

const headlineClass = computed(() =>
  wording.value.tone === 'resolved' ? 'text-highlighted' : 'text-muted'
)

/**
 * The star favorites *this artist* — the local `artists` row the deck resolved,
 * not the tracks by them (D24, product rule 6). Keyed on the same `artistId` the
 * "not this artist?" affordance already acts on, so it is present exactly when
 * that control is: whenever the deck holds an artist to name.
 *
 * Hydrated as the resolved artist changes. `artistId` is the local row and is
 * known the moment resolution lands, so the star does not wait on the mbid
 * lookup the biography and image do.
 */
const stars = useArtistFavorites()
const artistId = computed(() => identity.resolution?.artistId ?? null)
const artistName = computed(() => identity.resolution?.name ?? 'this artist')
watch(
  artistId,
  (id) => {
    if (id !== null) void stars.hydrate([id])
  },
  { immediate: true }
)
</script>

<template>
  <div class="flex shrink-0 items-center gap-2 px-4 pb-6 pt-7">
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-3">
        <UIcon
          :name="identity.resolved ? 'i-tabler-user-check' : 'i-tabler-user-question'"
          class="size-5 shrink-0"
          :class="wording.tone === 'problem' ? 'text-warning' : 'text-dimmed'"
          aria-hidden="true"
        />

        <h3 class="truncate text-xl font-bold leading-tight tracking-tight" :class="headlineClass">
          {{ wording.headline }}
        </h3>
      </div>

      <!--
        Indented past the icon, so the two lines share a left edge. Absent
        entirely for a plain automatic match: `describeIdentity` returns no
        detail when the headline and the tick have already said everything, and
        a standing line of grey text that never varies is the thing the deck's
        `hint` tooltips exist to have got rid of.

        `text-muted` rather than `text-dimmed`, which is what it was when this
        line sat on a flat surface. The dimmest step in the ramp is chosen for
        contrast against the panel, and this line no longer sits on the panel —
        it sits on a photograph, which spends part of that margin before the
        text is drawn.
      -->
      <p v-if="wording.detail || identity.loading" class="mt-1.5 truncate ps-8 text-sm text-muted">
        {{ identity.loading ? 'Looking…' : wording.detail }}
      </p>
    </div>

    <!--
      The artist star, alongside the correction controls rather than in the name
      block: favoriting an artist and disputing which artist this is are two
      verbs on the same subject, and they read as a set. Present whenever the
      deck holds an `artistId`, which is the moment there is an artist to star.
    -->
    <UTooltip v-if="artistId !== null" text="Favorite this artist">
      <FavoriteStar
        :favorite="stars.isFavorite(artistId)"
        :pending="stars.isPending(artistId)"
        :label="artistName"
        @toggle="stars.toggle(artistId)"
      />
    </UTooltip>

    <UTooltip v-if="wording.retryable" text="Try the lookup again">
      <UButton
        variant="ghost"
        size="xs"
        icon="i-tabler-refresh"
        square
        class="shrink-0 text-dimmed"
        aria-label="Try the lookup again"
        :loading="identity.loading"
        @click="identity.refresh()"
      />
    </UTooltip>

    <!--
      Worded as a question rather than as "Change": the operator is being invited
      to disagree, and a neutral verb reads as a settings control they have no
      reason to touch.
    -->
    <UTooltip v-if="wording.correctable" text="Not this artist?">
      <UButton
        variant="ghost"
        size="xs"
        icon="i-tabler-switch-horizontal"
        square
        class="shrink-0"
        :class="identity.corrected ? 'text-primary' : 'text-dimmed'"
        aria-label="Not this artist?"
        @click="identity.openPicker()"
      />
    </UTooltip>

    <ArtistPicker />
  </div>
</template>
