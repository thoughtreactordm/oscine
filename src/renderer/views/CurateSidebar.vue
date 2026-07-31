<script setup lang="ts">
/**
 * Curate's sidebar: the playlist rail.
 *
 * Scaffold for W5. It draws the shape the real thing will have — a header with
 * a create action, then one virtualized list of playlists — and nothing else.
 * No store, no IPC: there is no playlist table yet, and inventing a fake one
 * here would only have to be deleted.
 *
 * When it does land, the list is virtualized from its first commit like every
 * other list in the app; `FacetList` is the pattern to copy, not `v-for`.
 */
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="Playlists">
    <div class="flex items-center gap-2 border-b border-default bg-elevated/40 p-2">
      <UIcon name="i-tabler-playlist" class="size-5 text-primary" />
      <h1 class="font-semibold text-highlighted">Curate</h1>
      <UButton
        class="ml-auto"
        icon="i-tabler-plus"
        size="xs"
        color="neutral"
        variant="ghost"
        disabled
        aria-label="New playlist"
      />
    </div>

    <UEmpty
      variant="naked"
      size="sm"
      icon="i-tabler-playlist-add"
      title="No playlists yet"
      description="Playlists arrive with W5."
      class="min-h-0 flex-1"
    />
  </section>
</template>
