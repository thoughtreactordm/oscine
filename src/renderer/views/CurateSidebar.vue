<script setup lang="ts">
import PlaylistRail from '@renderer/panels/PlaylistRail.vue'

/**
 * Curate's sidebar: the rail of every playlist.
 *
 * This scaffolded a rail, then lost it — the reasoning being that D5 makes the
 * tab strip the backbone, so a second list of playlists beside it would be two
 * ways to choose one. That was wrong, and the tab strip's close button was the
 * proof: with every playlist rendered as a tab, closing one had nowhere to put
 * it, so `×` called `remove`. A rail is not a competing way to choose a
 * playlist; it is the only place a *closed* playlist can be seen. The strip is
 * still the backbone, and now it is a backbone with a closed state.
 *
 * The playlist's own settings — crossfade, the smart-rule editor — were the
 * other thing pencilled in for this sidebar. They belong to the *viewed*
 * playlist rather than to the library of them, so they will land under the
 * contents pane's header when they get a card, not here.
 */
</script>

<template>
  <PlaylistRail />
</template>
