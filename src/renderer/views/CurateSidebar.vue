<script setup lang="ts">
import PlaylistRail from '@renderer/panels/PlaylistRail.vue'

/**
 * Curate's sidebar: Discover, My Favorites, and the rail of every playlist.
 *
 * This is the chooser. Clicking an entry views it in the pane next door; there
 * is no tab strip to open something into. A playlist you are not looking at is
 * still in this list, which is the whole of why the rail exists.
 *
 * The playlist's own settings — crossfade, the smart-rule editor — belong to
 * the *viewed* playlist rather than to the library of them, so they land under
 * the contents pane's header when they get a card, not here.
 *
 * `layout` is the frame's narrow-window signal (§2), forwarded whole to the rail:
 * a single list does not become columns the way the Library sources do, so the
 * band splits the rail into its pinned nav and its playlist list side by side.
 */
withDefaults(defineProps<{ layout?: 'rail' | 'band' }>(), { layout: 'rail' })
</script>

<template>
  <PlaylistRail :layout="layout" />
</template>
