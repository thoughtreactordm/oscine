<script setup lang="ts">
/**
 * Curate's sidebar.
 *
 * It scaffolded a playlist rail, which D5 has since made the wrong shape: the
 * backbone is the tab strip in `CurateView`, and a rail beside it would be a
 * second way to choose a playlist, disagreeing with the first the moment either
 * one gained a feature. What belongs here instead is what the *viewed* playlist
 * is — its crossfade, its counts, the smart-rule editor — and none of that has a
 * card yet, so it stays empty rather than guessing.
 */
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="Curate">
    <div class="flex items-center gap-2 border-b border-default bg-elevated/40 p-2">
      <UIcon name="i-tabler-playlist" class="size-5 text-primary" />
      <h1 class="font-semibold text-highlighted">Curate</h1>
    </div>

    <UEmpty
      variant="naked"
      size="sm"
      icon="i-tabler-adjustments"
      title="Nothing to adjust yet"
      description="Playlists live in the tab strip. Their settings land here later."
      class="min-h-0 flex-1"
    />
  </section>
</template>
