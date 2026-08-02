<script setup lang="ts">
/**
 * The biography's shape, while the biography is on its way.
 *
 * ## Why a placeholder rather than a word
 *
 * "Looking…" is one line of text where five lines of prose are about to be, so
 * the pane collapses to a single row and then springs back — and everything
 * below it in the deck moves twice. Skipping through an album made the whole
 * accordion jump. A placeholder that occupies roughly the height of the answer
 * turns that into a crossfade in place, which is the actual complaint: not that
 * loading was invisible, but that it moved things.
 *
 * Roughly, not exactly. A real lead section is one to four paragraphs and no
 * placeholder can know which — matching the *first* screenful is what removes
 * the jump that matters, and the scroll container absorbs the rest.
 *
 * ## Why the bars are uneven
 *
 * Three full-width bars and a short one, twice. A block of identical bars reads
 * as a table or a list; prose has ragged right edges, and the ragged edge is
 * most of what makes this legible as "text is coming" rather than "something is
 * broken". The short bar at the foot stands for the attribution line, which is
 * always there when there is anything to attribute.
 *
 * `motion-safe:` on the pulse, per the reduced-motion handling in `CoverArt` and
 * `WaveformRibbon`: with motion reduced this is still the right shape and the
 * right height, just still. The one thing it must not become is invisible,
 * because then the jump comes back.
 */

/** Widths that read as sentence endings rather than as a column of blocks. */
const PARAGRAPHS: readonly (readonly string[])[] = [
  ['w-full', 'w-full', 'w-full', 'w-4/5'],
  ['w-full', 'w-full', 'w-3/5']
]
</script>

<template>
  <div class="px-1 py-1" aria-hidden="true">
    <div v-for="(lines, index) in PARAGRAPHS" :key="index" class="mb-3 space-y-2 last:mb-0">
      <div
        v-for="(width, line) in lines"
        :key="line"
        class="h-3 rounded bg-elevated motion-safe:animate-pulse"
        :class="width"
      />
    </div>

    <div class="mt-4 border-t border-default pt-2">
      <div class="h-2.5 w-2/5 rounded bg-elevated motion-safe:animate-pulse" />
    </div>
  </div>
</template>
