<script setup lang="ts">
import { computed } from 'vue'
import { hasArtwork } from '@shared/ipc'
import { describeIdentity } from '@renderer/panels/tunedeck/artistIdentity'
import { describeCredit } from '@renderer/panels/tunedeck/imageCredit'
import ArtistPicker from '@renderer/panels/tunedeck/ArtistPicker.vue'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'
import { useArtistImageStore } from '@renderer/stores/artistImage'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * Who the deck thinks is playing, over a picture of them — **R5**'s "not this
 * artist?" affordance, and **D14**'s images.
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
 * ## Why the text floats rather than sitting beside a thumbnail
 *
 * A 40px portrait next to a name is a contact row; it says "here is a small
 * picture of a person" and reads as chrome. Bleeding the photograph across the
 * top of the deck and standing the identity on it says "this is who you are
 * listening to", which is the question the whole tab exists to answer. It also
 * costs no height that a thumbnail would not have cost, because the strip is
 * laid over the picture instead of beside it.
 *
 * ## Why there is always a backdrop
 *
 * Most artists have no Wikidata photograph, and a header that is a picture for
 * some artists and a flat strip for others is a header that appears to be
 * broken. The fallback is the current track's cover art under the same blur the
 * transport bar bleeds behind itself — which is not a stand-in for the portrait
 * so much as the same idea at a different scale, and is why it is blurred while
 * the portrait is not. One is a subject and the other is a surface.
 *
 * ## Attribution
 *
 * Commons licences require the author and the licence to be named wherever the
 * work is shown, and `describeCredit` composes that from whatever fields the
 * file actually carried. It is a popover rather than a permanent line because
 * the credit for one file is routinely longer than this deck is wide — the
 * alternative is a truncated attribution, which is a worse answer than a
 * complete one behind a control that is always there while the picture is. The
 * summary is also the button's `aria-label`, so it is never *only* visual.
 */

const identity = useArtistIdentityStore()
const images = useArtistImageStore()
const playback = usePlaybackStore()

const wording = computed(() =>
  describeIdentity(identity.resolution, {
    loading: identity.loading,
    failed: identity.failed
  })
)

const headlineClass = computed(() =>
  wording.value.tone === 'resolved' ? 'text-highlighted' : 'text-muted'
)

const photo = computed(() => images.image)

/** `large` rather than `small`: it is scaled well past its own size, and the blur hides it. */
const cover = computed(() => {
  const url = playback.nowPlaying?.artwork.large
  return url && hasArtwork(url) ? url : null
})

const backdrop = computed(() => photo.value?.large ?? cover.value)

const credit = computed(() => (photo.value ? describeCredit(photo.value.credit) : null))
</script>

<template>
  <header class="relative isolate shrink-0 overflow-hidden border-b border-default">
    <!--
      Keyed on the URL, so changing artist is a dissolve rather than a cut. No
      `mode`: the outgoing and incoming layers are both absolutely positioned
      and overlap for the duration, which is what makes it a dissolve rather
      than a fade to nothing and back.
    -->
    <Transition name="deck-backdrop">
      <div
        v-if="backdrop"
        :key="backdrop"
        class="deck-backdrop"
        :class="photo ? 'deck-backdrop-photo' : 'deck-backdrop-cover'"
        :style="{ backgroundImage: `url('${backdrop}')` }"
        aria-hidden="true"
      />
    </Transition>

    <!--
      The wash the text stands on. `--fermata-scrim` is fixed across themes on
      purpose — it sits over an arbitrary photograph, so its contrast has to be
      won against an unknown picture rather than against a surface.
    -->
    <div v-if="backdrop" class="deck-scrim" aria-hidden="true" />

    <div
      class="relative flex min-h-24 items-end gap-2 px-3 pb-2 pt-3"
      :class="backdrop ? 'on-backdrop' : ''"
    >
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <!--
            On the name's line rather than beside the block, which is where it
            was before the strip grew a picture. Bottom-aligning the content
            over the backdrop left it level with the detail text, where it read
            as an icon for the sentence about MusicBrainz rather than a verdict
            on the artist.
          -->
          <UIcon
            :name="identity.resolved ? 'i-tabler-user-check' : 'i-tabler-user-question'"
            class="size-4 shrink-0"
            :class="wording.tone === 'problem' ? 'text-warning' : 'text-dimmed'"
            aria-hidden="true"
          />

          <p class="truncate text-sm font-medium" :class="headlineClass">
            {{ wording.headline }}
          </p>

          <!--
            Inline with the name rather than in the corner: the credit belongs to
            the picture the name is standing on, and a licence control parked
            with the identity controls reads as a third thing to do to the
            artist.
          -->
          <UPopover v-if="credit" :ui="{ content: 'w-64 p-3' }">
            <UButton
              variant="ghost"
              size="xs"
              icon="i-tabler-info-circle"
              square
              class="shrink-0 text-dimmed"
              :aria-label="credit.summary"
            />

            <template #content>
              <p class="text-xs font-medium text-highlighted">Photograph</p>
              <p v-if="credit.name" class="mt-1 text-xs leading-relaxed text-muted">
                {{ credit.name }}
              </p>
              <p class="mt-2 text-xs leading-relaxed text-dimmed">
                <!--
                  `target="_blank"` rather than an IPC call, for the reason the
                  biography's licence line gives: main's `setWindowOpenHandler`
                  already routes https to the system browser and denies the
                  window.
                -->
                <template v-if="credit.licence">
                  <a
                    v-if="credit.licenceUrl"
                    :href="credit.licenceUrl"
                    target="_blank"
                    rel="noreferrer"
                    class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
                  >
                    {{ credit.licence }}
                  </a>
                  <span v-else>{{ credit.licence }}</span>
                  ·
                </template>
                <a
                  :href="credit.descriptionUrl"
                  target="_blank"
                  rel="noreferrer"
                  class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
                >
                  Wikimedia Commons
                </a>
              </p>
            </template>
          </UPopover>
        </div>

        <!-- Indented past the icon, so the two lines share a left edge. -->
        <p v-if="wording.detail" class="truncate ps-6 text-xs text-dimmed">
          {{ identity.loading ? 'Looking…' : wording.detail }}
        </p>
      </div>

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
        Worded as a question rather than as "Change": the operator is being
        invited to disagree, and a neutral verb reads as a settings control they
        have no reason to touch.
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
  </header>
</template>

<style scoped>
/*
 * Negative z-index against the header's own `isolate`, so the picture paints
 * above the header's surface and below everything in flow without any sibling
 * needing a z-index of its own. The mask is what makes it a bleed rather than a
 * banner: the image has no bottom edge, it stops being there, so the accordion
 * below inherits no line to disagree with.
 */
.deck-backdrop,
.deck-scrim {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}

.deck-backdrop {
  background-position: center 25%;
  background-repeat: no-repeat;
  background-size: cover;
  /*
   * Keywords rather than a token: a mask reads the alpha channel and discards
   * the hue, so these two are "opaque" and "clear" rather than colours. There is
   * no theme value that could be correct here.
   *
   * Clear by 90% rather than by 100%, so the last tenth of the strip carries no
   * picture at all. Fading exactly to the edge leaves a few percent of opacity
   * where `overflow-hidden` cuts, and a bright subject shows a hairline of
   * itself along the accordion — a bleed with an edge on it, which is the one
   * thing a bleed is for not having.
   */
  mask-image: linear-gradient(to bottom, black 30%, transparent 90%);
}

/*
 * The portrait is the subject: full strength, unblurred, framed a quarter of
 * the way down because that is where a face is in a photograph that was cropped
 * by somebody else.
 */
.deck-backdrop-photo {
  opacity: 0.85;
}

/*
 * The cover is a surface. Same treatment the transport bar gives it — the
 * theme's own blur and bleed, overscaled so the blur has edges to eat rather
 * than fading into the header's corners.
 */
.deck-backdrop-cover {
  filter: blur(var(--fermata-cover-blur)) saturate(3.6);
  transform: scale(1.4);
  opacity: calc(var(--fermata-cover-bleed) * 2.5);
}

/*
 * Top-down rather than flat: the identity sits at the bottom of the strip, so
 * that is where the contrast is needed, and a uniform wash would dull the half
 * of the picture nothing is written on.
 *
 * Full strength by 55% and held there, rather than ramping all the way to the
 * bottom edge. The name's baseline is around 60% of the strip, and a gradient
 * that is still climbing at that point delivers about half the scrim's alpha —
 * which is legible over a dark photograph and not over a pale one. Measured
 * against a light portrait in the running app, not reasoned about: the first
 * version of this line put near-white text on sunlit skin.
 */
.deck-scrim {
  background: linear-gradient(
    to bottom,
    transparent 0%,
    var(--fermata-scrim) 55%,
    var(--fermata-scrim) 100%
  );
}

/*
 * The scrim wins the contrast fight against a dark photograph; it cannot win it
 * against a pale one, because a wash dark enough to do that would hide the
 * picture. A shadow on the glyphs themselves is the part that scales with how
 * light the image under them happens to be, and it costs nothing when there is
 * nothing behind — which is why it is conditional on there being a backdrop
 * rather than always on.
 *
 * The scrim token again, because it is the one value in the theme layer that is
 * fixed across themes for exactly this reason — it is what the design says text
 * over arbitrary cover art gets to stand on.
 */
.on-backdrop {
  text-shadow: 0 1px 3px var(--fermata-scrim);
}

.deck-backdrop-enter-active,
.deck-backdrop-leave-active {
  transition: opacity 400ms ease;
}

.deck-backdrop-enter-from,
.deck-backdrop-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .deck-backdrop-enter-active,
  .deck-backdrop-leave-active {
    transition-duration: 120ms;
  }
}
</style>
