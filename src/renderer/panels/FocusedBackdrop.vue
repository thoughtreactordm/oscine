<script setup lang="ts">
import { computed } from 'vue'
import { useFocusedHeaderStore } from '@renderer/stores/focusedHeader'

/**
 * The picture the Songs panel stands on when it is about one artist or album.
 *
 * The treatment is `DeckBackdrop`'s: a photograph stays legible as one, a cover
 * is the transport bar's blur and bleed. The numbers are copied rather than
 * shared because that file's comments are the argument for each of them, and a
 * shared class would become a third place those numbers could drift from the
 * reasoning that picked them.
 *
 * 38% of the *panel*, not of this header. A photograph confined to the identity
 * strip is a banner; spanning the upper third and fading through the first rows
 * is the list's own surface, which is what "grounded" means in the deck too.
 */

const focus = useFocusedHeaderStore()

const photo = computed(() => focus.photo?.large ?? null)
const source = computed(() => photo.value ?? focus.cover)

const variant = computed(() => (photo.value ? 'photo' : 'cover'))
</script>

<template>
  <Transition name="focus-backdrop">
    <div
      v-if="source"
      :key="source"
      class="focus-backdrop"
      :class="variant === 'photo' ? 'focus-backdrop-photo' : 'focus-backdrop-cover'"
      :style="{ backgroundImage: `url('${source}')` }"
      aria-hidden="true"
    />
  </Transition>
</template>

<style scoped>
.focus-backdrop {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 38%;
  z-index: -1;
  pointer-events: none;
  background-position: center top;
  background-repeat: no-repeat;
  background-size: cover;
  mask-image: linear-gradient(to bottom, black 0%, black 33%, transparent 100%);
  transition: opacity 260ms ease;
}

.focus-backdrop-photo {
  opacity: 0.42;
  filter: brightness(0.5) saturate(1.35);
}

.focus-backdrop-cover {
  filter: blur(var(--oscine-cover-blur)) saturate(2.2) brightness(0.55);
  transform: scale(1.4);
  opacity: calc(var(--oscine-cover-bleed) * 1.1);
}

.focus-backdrop-enter-active,
.focus-backdrop-leave-active {
  transition: opacity 400ms ease;
}

.focus-backdrop-enter-from,
.focus-backdrop-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .focus-backdrop-enter-active,
  .focus-backdrop-leave-active {
    transition-duration: 120ms;
  }
}
</style>
