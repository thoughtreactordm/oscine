<script setup lang="ts">
import type { RelatedStrand } from '@shared/related'
import RelatedList from '@renderer/panels/tunedeck/RelatedList.vue'

/**
 * The rest of the record this track came off.
 *
 * The one strand in the Related tab derived from identity rather than from
 * coincidence, which is why it is its own group above the looser three and not
 * mixed in with them. Its header row still carries the album title, so the
 * group heading saying "On this album" and the row saying which album is not a
 * repetition — one names the relation, the other names the record.
 */

const STRANDS: readonly RelatedStrand[] = ['album-tracks']
</script>

<template>
  <RelatedList :strands="STRANDS" empty="No other tracks from this album are in the library." />
</template>
