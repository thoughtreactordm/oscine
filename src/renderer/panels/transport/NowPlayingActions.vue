<script setup lang="ts">
import { computed } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { trackMenuItems } from '@renderer/panels/trackMenu'
import { useTrackActions } from '@renderer/panels/useTrackActions'
import { queueRows } from '@renderer/playback/queueCommands'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { useFavoritesStore } from '@renderer/stores/favorites'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'

/**
 * The favourite toggle and the 3-dot song menu for the track on the transport —
 * G3 and D18 — lifted out of `NowPlaying` so the bar and the Zen stage act on the
 * playing track through one shared control.
 *
 * Stays within the island rule: the favourites store is asked about the `Track`
 * the transport already handed over, not about a list or a library.
 */
const playback = usePlaybackStore()
const favorites = useFavoritesStore()
const addToPlaylist = useAddToPlaylistStore()
const queue = useQueueCommandsStore()
const trackActions = useTrackActions()

/** `null` with nothing playing, which is the state where there is no heart to draw. */
const nowPlayingFavorite = computed(() => {
  const track = playback.nowPlaying
  return track ? favorites.isFavorite(track) : null
})

const favoriteLabel = computed(() => {
  const track = playback.nowPlaying
  if (!track) return 'Favorite'
  return nowPlayingFavorite.value ? `Unfavorite ${track.title}` : `Favorite ${track.title}`
})

function toggleFavorite(): void {
  const track = playback.nowPlaying
  if (track) void favorites.toggle(track.id)
}

/**
 * The bar's 3-dot menu (G3), the shared single-track set (G8): the same
 * `trackMenuItems` the library row, the playlist row and a Curate card build, so
 * the five cannot drift. `play` is `null` — this is the track already playing,
 * and a Play that restarted it would be a verb for a state the operator is
 * already in.
 */
const songMenu = computed<DropdownMenuItem[]>(() => {
  const track = playback.nowPlaying
  if (!track) return []
  return trackMenuItems({
    play: null,
    playNext: () => void queue.playNext(queueRows([track])),
    addToQueue: () => void queue.addToQueue(queueRows([track])),
    addToPlaylist: addToPlaylist.menuItem({
      trackIds: () => Promise.resolve([track.id]),
      count: 1
    }),
    viewArtist: trackActions.viewArtist(trackActions.artistOf(track)),
    viewAlbum: trackActions.viewAlbum(track.album),
    trackInfo: trackActions.showInfo(track),
    editMetadata: trackActions.editTrack(track)
  }) as DropdownMenuItem[]
})
</script>

<template>
  <div class="flex items-center">
    <!--
      A two-state toggle, so it announces its state rather than only an action —
      the same treatment shuffle gets. Disabled with nothing playing: there is no
      track for the click to be about, and a heart that filled against silence
      would be a lie the next track inherits.
    -->
    <UTooltip :text="nowPlayingFavorite ? 'Remove from favorites' : 'Add to favorites'">
      <UButton
        variant="ghost"
        square
        :icon="nowPlayingFavorite ? 'i-tabler-heart-filled' : 'i-tabler-heart'"
        :color="nowPlayingFavorite ? 'primary' : 'neutral'"
        :disabled="nowPlayingFavorite === null"
        :aria-pressed="nowPlayingFavorite === true"
        :aria-label="favoriteLabel"
        @click="toggleFavorite()"
      />
    </UTooltip>
    <UDropdownMenu :items="songMenu" :content="{ align: 'end' }">
      <UTooltip text="Song options">
        <UButton
          variant="ghost"
          icon="i-tabler-dots-vertical-filled"
          square
          aria-label="Song options"
        />
      </UTooltip>
    </UDropdownMenu>
  </div>
</template>
