<script setup lang="ts">
import { NEIGHBOURHOOD_STRANDS, type RelatedStrand } from '@shared/related'
import RelatedList from '@renderer/panels/tunedeck/RelatedList.vue'

/**
 * The weaker half: same genre, same year, same folder.
 *
 * Every one of the three is a coincidence rather than a credit — a shared genre
 * string can be an accident of how the files were tagged, a shared folder an
 * accident of how they were downloaded. That caveat used to be a divider row
 * inside the one Related list. It is now the tooltip on this group's header,
 * which is both quieter and better placed: the operator reads it when they ask
 * what the group is, rather than every time they scroll past it.
 */

const STRANDS: readonly RelatedStrand[] = NEIGHBOURHOOD_STRANDS
</script>

<template>
  <RelatedList
    :strands="STRANDS"
    empty="Nothing in the library shares this track's genre, year or folder."
  />
</template>
