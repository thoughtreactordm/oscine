<script setup lang="ts">
import PlaylistContents from '@renderer/panels/PlaylistContents.vue'
import PlaylistTabBar from '@renderer/panels/PlaylistTabBar.vue'

/**
 * Curate's body: the tab strip of open playlists, and the entries of whichever
 * one is viewed. The rail of *all* playlists is the sidebar, next door.
 *
 * The artwork shelves that stood here were a scaffold for a shape W5 has since
 * settled, and D5 settled it differently — the backbone is a named tab bar, not
 * a wall of cards. They are gone rather than kept alongside because the shelves
 * were the one with no data behind them.
 *
 * Two siblings, no parent-child wiring between them: the strip wrote
 * `viewedPlaylistId` before this pane existed and does not know it now has a
 * reader. That is what makes either one dockable elsewhere later (D4).
 *
 * The pane scrolls itself — it is a virtualized list and owns its own scroll
 * container — so nothing here may add a second one around it.
 */
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-default" aria-label="Curate">
    <PlaylistTabBar />

    <div class="min-h-0 flex-1">
      <PlaylistContents />
    </div>
  </section>
</template>
