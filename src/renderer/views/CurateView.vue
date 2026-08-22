<script setup lang="ts">
import DiscoverPane from '@renderer/panels/DiscoverPane.vue'
import PlaylistContents from '@renderer/panels/PlaylistContents.vue'
import { DISCOVER_TAB } from '@renderer/panels/playlistTabs'
import { usePlaylistsStore } from '@renderer/stores/playlists'

/**
 * Curate's body: Discover, My Favorites, or a playlist. The rail next door is
 * what picks which — there is no second chooser in this pane.
 *
 * The switch compares against `DISCOVER_TAB` rather than against a bare `null`
 * so that the rule — a null stop *is* Discover — is named at both of the two
 * places that depend on it, here and in the rail.
 *
 * It reads `viewedStop` and not `viewedPlaylistId`, which is the whole of what
 * My Favorites needed here. The narrow one reports `null` on both fixtures, so
 * switching on it would send D18's pinned entry to Discover; the contents pane
 * renders either collection (see its own note), so there is still exactly one
 * `v-else`.
 *
 * Two siblings, no parent-child wiring between them: the rail wrote the viewed
 * stop before this pane existed and does not know it now has a reader. That is
 * what makes either one dockable elsewhere later (D4).
 *
 * Both panes scroll themselves — one is a virtualized list, the other owns its
 * own overflow — so nothing here may add a second scroll container around them.
 *
 * Notices used to sit on the tab strip. They belong here now that the strip is
 * gone, so a failed export or a failed create still has somewhere to land.
 */
const playlists = usePlaylistsStore()
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-default" aria-label="Curate">
    <UAlert
      v-if="playlists.notice"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :description="playlists.notice"
      class="rounded-none"
    />

    <div class="min-h-0 flex-1">
      <DiscoverPane v-if="playlists.viewedStop === DISCOVER_TAB" />
      <PlaylistContents v-else />
    </div>
  </section>
</template>
