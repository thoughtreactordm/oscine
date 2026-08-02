<script setup lang="ts">
import { computed } from 'vue'
import { hasArtwork } from '@shared/ipc'
import { useArtistImageStore } from '@renderer/stores/artistImage'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The picture the artist tab stands on — **D14**'s images, as a surface.
 *
 * ## Why it is a panel layer and not part of the header
 *
 * It was a header background first, and the header was the wrong size for it. A
 * photograph confined to a 96px strip with the identity laid over it is a
 * *banner*: it has a top, a bottom and a subject, and the eye reads it as a
 * separate object that the panel happens to contain. Spanning the upper third of
 * the tab and fading out through the first group makes it the panel's own
 * surface instead — the header stops being a thing on a picture and becomes text
 * on the deck, which is what "grounded" means here.
 *
 * ## Why it renders only where the credit does
 *
 * Gated by the shell on the active tab declaring a `header`, which today is the
 * artist tab and tomorrow is whichever tab carries the identity strip. That is
 * not a stylistic choice: Commons licences require the credit to be shown
 * wherever the work is, and the credit lives in that header. A backdrop that
 * outlived its header would be an unattributed photograph.
 *
 * ## Why the fallback is blurred and the photograph is not
 *
 * They are different kinds of thing. The portrait is *of* the artist, so it
 * stays legible as one — dialled back until it reads as tone rather than as a
 * picture, but never smeared. The cover is a stand-in for one, and the transport
 * bar already established what a cover looks like when it is being a surface:
 * the theme's own blur and bleed. Reusing that treatment is what stops the two
 * states reading as two different features.
 */

const images = useArtistImageStore()
const playback = usePlaybackStore()

const photo = computed(() => images.image)

/** `large` rather than `small`: it is scaled well past its own size, and the blur hides it. */
const cover = computed(() => {
  const url = playback.nowPlaying?.artwork.large
  return url && hasArtwork(url) ? url : null
})

const source = computed(() => photo.value?.large ?? cover.value)
</script>

<template>
  <!--
    Keyed on the URL, so changing artist is a dissolve rather than a cut. No
    `mode`: both layers are absolutely positioned and overlap for the duration,
    which is what makes it a dissolve rather than a fade to nothing and back.
  -->
  <Transition name="deck-backdrop">
    <div
      v-if="source"
      :key="source"
      class="deck-backdrop"
      :class="photo ? 'deck-backdrop-photo' : 'deck-backdrop-cover'"
      :style="{ backgroundImage: `url('${source}')` }"
      aria-hidden="true"
    />
  </Transition>
</template>

<style scoped>
/*
 * Negative z-index against the tab panel's `isolate`, so this paints above the
 * card's surface and below everything in flow without any sibling needing a
 * z-index of its own.
 *
 * 38% of the tab rather than a pixel height: the deck is a resizable column, and
 * a fixed 200px band is a third of a short window and a tenth of a tall one. A
 * fraction keeps the same proportion of the panel covered at every height, which
 * is the thing that was actually chosen.
 */
.deck-backdrop {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 38%;
  z-index: -1;
  pointer-events: none;
  /*
   * Top rather than centred. A photograph cropped by somebody else puts its
   * subject in the upper half, and anchoring the bottom edge — which is the edge
   * that moves when the panel is resized — would slide a face out of frame every
   * time the window changed height.
   */
  background-position: center top;
  background-repeat: no-repeat;
  background-size: cover;
  /*
   * Held at full for the first third and then given the remaining two thirds to
   * disappear in. The long ramp is the whole difference between a picture with a
   * soft bottom edge and a picture that stops being there: the fade has to
   * outlast the header and cross the first group's rule, so that nothing in the
   * panel lines up with where the image ended.
   *
   * Keywords rather than tokens — a mask reads the alpha channel and discards
   * the hue, so these are "opaque" and "clear" rather than colours.
   */
  mask-image: linear-gradient(to bottom, black 0%, black 33%, transparent 100%);
}

/*
 * Dialled well back. At full strength this is a portrait the text has to fight,
 * and every fix for that — a scrim, a heavier shadow — makes the panel busier to
 * defend a picture nobody asked to look at closely. Faint enough to read as the
 * deck being tinted by who is playing is both the better surface and the one
 * that needs no defending.
 *
 * ## Why `brightness` as well as `opacity`
 *
 * Over a dark panel a backdrop can only ever *lighten*, so the ceiling on how
 * much it lightens is the whole of the contrast budget. Opacity alone sets that
 * ceiling against the brightest pixel in the file, and P18 claims include studio
 * portraits on white seamless — measured in the running app, one of those at
 * plain 0.3 lifted the panel to mid-grey and took the detail line and the
 * accordion chevrons with it.
 *
 * Multiplying first compresses the top end before the blend sees it: a
 * near-white file lands where a mid-tone one used to, and a dark or saturated
 * one keeps its character because the multiply is proportional. The saturation
 * back up is because that same multiply flattens hue, and hue is the part of a
 * photograph that survives being this faint.
 */
.deck-backdrop-photo {
  opacity: 0.42;
  filter: brightness(0.5) saturate(1.35);
}

/*
 * The transport bar's treatment — the theme's blur, the theme's bleed — pulled
 * back for the area it has to cover here.
 *
 * The bar takes `saturate(3.6)` at the bleed neat because it is eighty pixels of
 * chrome and the exaggeration is what stops a blurred cover reading as grey mud
 * at that size. Over a third of the panel the same numbers are a colour wash:
 * measured against a warm cover, the deck went orange and the accordion beneath
 * it looked tinted rather than lit. Less saturation and the same brightness
 * ceiling as the photograph puts it back to being a surface.
 *
 * Fainter than the photograph on purpose, too. This is a stand-in for a picture
 * of the artist rather than one, and it should not be the more assertive of the
 * two states.
 */
.deck-backdrop-cover {
  filter: blur(var(--fermata-cover-blur)) saturate(2.2) brightness(0.55);
  transform: scale(1.4);
  opacity: calc(var(--fermata-cover-bleed) * 1.1);
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
