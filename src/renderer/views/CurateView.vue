<script setup lang="ts">
import PlaylistTabBar from '@renderer/panels/PlaylistTabBar.vue'
import { usePlaylistsStore } from '@renderer/stores/playlists'

/**
 * Curate's body: the tab strip, and whatever the viewed tab holds.
 *
 * The artwork shelves that stood here were a scaffold for a shape W5 has since
 * settled, and D5 settled it differently — the backbone is a named tab bar, not
 * a wall of cards. They are gone rather than kept alongside because two ways of
 * choosing a playlist on one screen is one too many, and the shelves were the
 * one with no data behind it.
 *
 * The body below the strip is still a placeholder. It becomes the virtualized
 * contents pane in W5-6; the strip does not know that, and will not have to
 * change when it happens.
 */
const playlists = usePlaylistsStore()
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-default" aria-label="Curate">
    <PlaylistTabBar />

    <div class="min-h-0 flex-1 overflow-y-auto">
      <UEmpty
        v-if="playlists.viewed === null"
        variant="naked"
        icon="i-tabler-playlist-add"
        title="No playlist selected"
        description="Make one with the plus button, or pick a tab."
        class="h-full"
      />
      <UEmpty
        v-else
        variant="naked"
        icon="i-tabler-playlist"
        :title="playlists.viewed.name"
        description="The contents pane arrives with W5-6."
        class="h-full"
      />
    </div>
  </section>
</template>
