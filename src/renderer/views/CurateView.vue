<script setup lang="ts">
import DiscoverPane from '@renderer/panels/DiscoverPane.vue'
import PlaylistContents from '@renderer/panels/PlaylistContents.vue'
import PlaylistTabBar from '@renderer/panels/PlaylistTabBar.vue'
import { DISCOVER_TAB } from '@renderer/panels/playlistTabs'
import { usePlaylistsStore } from '@renderer/stores/playlists'

/**
 * Curate's body: the tab strip, and whichever tab is viewed. The rail of *all*
 * playlists is the sidebar, next door.
 *
 * The strip always has at least one tab, because Discover is a fixture at its
 * left end. That is what removed the empty state this pane used to need: there
 * is no "nothing viewed" any more, only a viewed thing that is not a playlist.
 *
 * The switch compares against `DISCOVER_TAB` rather than against a bare `null`
 * so that the rule — a null stop *is* Discover — is named at both of the two
 * places that depend on it, here and in the strip.
 *
 * It reads `viewedStop` and not `viewedPlaylistId`, which is the whole of what
 * My Favorites needed here. The narrow one reports `null` on both fixtures, so
 * switching on it would send D18's pinned entry to Discover; the contents pane
 * renders either collection (see its own note), so there is still exactly one
 * `v-else`.
 *
 * Two siblings, no parent-child wiring between them: the strip wrote the viewed
 * stop before this pane existed and does not know it now has a reader. That is
 * what makes either one dockable elsewhere later (D4).
 *
 * Both panes scroll themselves — one is a virtualized list, the other owns its
 * own overflow — so nothing here may add a second scroll container around them.
 */
const playlists = usePlaylistsStore()
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-default" aria-label="Curate">
    <PlaylistTabBar />

    <div class="min-h-0 flex-1">
      <DiscoverPane v-if="playlists.viewedStop === DISCOVER_TAB" />
      <PlaylistContents v-else />
    </div>
  </section>
</template>
