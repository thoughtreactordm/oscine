<script setup lang="ts">
import type { RelatedStrand } from '@shared/related'
import RelatedList from '@renderer/panels/tunedeck/RelatedList.vue'

/**
 * What else this artist made, as far as the library knows.
 *
 * The Artist tab's local half, and for now its whole content. These two strands
 * were part of the Related pane until the deck grew tabs; they moved because
 * they answer "who is this" rather than "what is this like", and a list that
 * ran "more by this artist" straight into "same year" was asking the operator
 * to keep two questions apart in their head that the pane had merged.
 *
 * There is deliberately no "biography arrives in M7" placeholder under this.
 * The network panes land as further groups in this tab when they land; a line
 * of grey text promising them is the exact sort of standing helper text the
 * deck was just cleared of.
 */

const STRANDS: readonly RelatedStrand[] = ['artist-albums', 'compilations']
</script>

<template>
  <RelatedList :strands="STRANDS" empty="Nothing else by this artist is in the library." />
</template>
