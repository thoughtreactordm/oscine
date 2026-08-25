<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { albumPlayParams, artistPlayParams } from '@renderer/panels/discoverShelves'
import {
  activateAlbum,
  activateArtist,
  activatePlaylist,
  loadQuickMenu,
  type QuickMenuActivationDeps,
  type QuickMenuLists
} from '@renderer/panels/quickMenu'
import { favorites, library } from '@renderer/ipc'
import { QUICK_MENU_FAVORITES_LIMIT } from '@shared/favorites'
import { artworkUrl } from '@shared/ipc'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'

/**
 * The Quick Menu drawer — **D26**, product rules 8 and 9.
 *
 * A left-edge `UDrawer` off Now Playing, left so it stays clear of a
 * possibly-open Tunedeck on the right. Three short lists recomputed on every
 * open; the load and the per-kind verbs live in `quickMenu.ts`, so this file is
 * only the drawer, the rows, and the wiring from those verbs to the stores.
 *
 * An island (product rule 9): it imports no sibling pane — not Discover, not the
 * dashboard, not the deck, not the Library facets — only stores and IPC. The
 * verbs it runs are the ones Library, Discover and the palette already use, so a
 * row here plays or navigates exactly as the same thing does anywhere else.
 */
const playback = usePlaybackStore()
const shell = useShellStore()

const open = ref(false)
const loading = ref(false)
const lists = ref<QuickMenuLists>({ playlists: [], albums: [], artists: [] })

/**
 * The play each verb runs — a playlist in its entry order, an album and an
 * artist through the shared library order narrowed to them (product rule 5).
 * `close` flips the drawer's own `open`, so a selection always leaves the menu.
 */
const deps: QuickMenuActivationDeps = {
  playPlaylist: (playlistId) => void playback.playFromPlaylist({ playlistId }),
  playAlbum: (albumId) => void playback.playFromList(albumPlayParams(albumId)),
  playArtist: (artistId) => void playback.playFromList(artistPlayParams(artistId)),
  close: () => {
    open.value = false
  }
}

/**
 * Sets the drawer state, reloading the lists whenever it opens.
 *
 * The single seam for both the handle's click and the drawer's own dismissals
 * (overlay, Esc, drag), so the handle can close as well as open. Guarded against
 * a no-op echo — the controlled drawer re-emits the value it was just given —
 * so `load` runs once per real open, not twice.
 */
function setOpen(next: boolean): void {
  if (next === open.value) return
  open.value = next
  if (next) void load()
}

/**
 * Honours a request from the View menu to open the drawer — see
 * `shell.requestQuickMenu`.
 *
 * Two entry points because the menu can be used from either state. When Now
 * Playing is already showing this component is mounted and the watcher catches
 * the flag flipping; when the menu navigates here first, this component mounts
 * with the flag already set and reads it in `onMounted`. Either way the request
 * is consumed the instant it is seen, so it fires once and does not reopen a
 * drawer the operator then closes.
 */
function honourOpenRequest(): void {
  if (shell.consumeQuickMenuRequest()) setOpen(true)
}

watch(() => shell.quickMenuRequested, honourOpenRequest)
onMounted(honourOpenRequest)

/**
 * Reloads the three lists — that is "recomputed on open" (product rule 8), and
 * it is what makes a favorite toggled or an album imported since the last open
 * show up now with no subscription. A failed read empties the lists rather than
 * throwing into the drawer.
 */
async function load(): Promise<void> {
  loading.value = true
  try {
    lists.value = await loadQuickMenu(
      {
        playlists: async (limit) => (await favorites.listPlaylists({ limit })).playlists,
        albums: (limit) => library.recentlyAddedAlbums(limit),
        artists: async (limit) => (await favorites.listArtists({ limit })).artists
      },
      QUICK_MENU_FAVORITES_LIMIT
    )
  } catch {
    lists.value = { playlists: [], albums: [], artists: [] }
  } finally {
    loading.value = false
  }
}

/** The cover route for a hash, or the placeholder image for the many that have none. */
function coverSrc(hash: string | null): string {
  return artworkUrl(hash, 'small')
}
</script>

<template>
  <!--
    A pull-tab fixed to the window's left edge and centred in its height, not a
    button in the transport cluster — the drawer comes from the left, so its
    handle lives on the left. Fixed to the viewport (no transformed ancestor on
    the path up to the shell grid), so it holds its place through tab changes and
    a resizing sidebar.

    It is not the drawer's trigger but a controlled toggle, so the same tab both
    opens and closes. On open it rides out on the drawer's right edge: the
    content's right edge travels `0 → width`, and this matches it with a
    `translateX` on the same `.5s cubic-bezier(.32,.72,0,1)` Vaul animates the
    panel with.

    The drawer runs without its overlay (`:overlay="false"`). The shade teleports
    to `<body>`, outside the `#app` isolate that holds this handle, so no z-index
    here can climb over it — and lifting the handle to body level would put it
    over the command palette too, since both overlays stack at `auto`. Dropping
    the shade is what keeps the tab visible while it rides the panel out.
  -->
  <UTooltip text="Quick Menu" :content="{ side: 'right' }">
    <UButton
      variant="solid"
      color="primary"
      :icon="open ? 'i-tabler-chevron-left' : 'i-tabler-chevron-right'"
      aria-label="Quick Menu"
      :aria-expanded="open"
      class="quick-menu-handle fixed top-1/2 left-0 z-30 h-16 w-7 justify-center rounded-l-none rounded-r-lg p-0 shadow-lg"
      :class="{ 'quick-menu-handle--open': open }"
      :ui="{ leadingIcon: 'size-5' }"
      @click="setOpen(!open)"
    />
  </UTooltip>

  <UDrawer
    :open="open"
    direction="left"
    :handle="false"
    :overlay="false"
    title="Quick Menu"
    description="Favorite playlists, recent additions and favorite artists"
    :ui="{ content: 'w-80 max-w-[80vw] rounded-none' }"
    @update:open="setOpen"
  >
    <template #body>
      <div class="flex h-full min-h-0 flex-col gap-6 overflow-y-auto">
        <!-- Favorite Playlists — starred playlists, newest first (D24/D26). -->
        <section class="flex flex-col gap-1">
          <p class="quick-menu-heading">Favorite Playlists</p>
          <p v-if="!lists.playlists.length && !loading" class="quick-menu-empty">
            No favorite playlists yet.
          </p>
          <UButton
            v-for="playlist in lists.playlists"
            :key="playlist.id"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            icon="i-tabler-playlist"
            @click="activatePlaylist(playlist.id, deps)"
          >
            <span class="min-w-0 flex-1 truncate text-start text-sm text-highlighted">
              {{ playlist.name }}
            </span>
            <span class="shrink-0 tabular-nums text-xs text-muted">
              {{ playlist.trackCount.toLocaleString() }}
            </span>
          </UButton>
        </section>

        <!-- Recent Additions — albums by arrival, newest first (D25/D26). -->
        <section class="flex flex-col gap-1">
          <p class="quick-menu-heading">Recent Additions</p>
          <p v-if="!lists.albums.length && !loading" class="quick-menu-empty">
            Nothing added recently.
          </p>
          <UButton
            v-for="album in lists.albums"
            :key="album.albumId"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            :avatar="{ src: coverSrc(album.artworkHash), icon: 'i-tabler-disc' }"
            @click="activateAlbum(album.albumId, deps)"
          >
            <span class="flex min-w-0 flex-1 flex-col text-start">
              <span class="truncate text-sm text-highlighted">{{ album.title }}</span>
              <span v-if="album.artist" class="truncate text-xs text-muted">
                {{ album.artist }}
              </span>
            </span>
          </UButton>
        </section>

        <!-- Favorite Artists — the real starred artists, newest first (D24/D26). -->
        <section class="flex flex-col gap-1">
          <p class="quick-menu-heading">Favorite Artists</p>
          <p v-if="!lists.artists.length && !loading" class="quick-menu-empty">
            No favorite artists yet.
          </p>
          <UButton
            v-for="artist in lists.artists"
            :key="artist.id"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            :avatar="{
              src: coverSrc(artist.artworkHash),
              icon: 'i-tabler-user',
              ui: { root: 'rounded-full' }
            }"
            @click="activateArtist(artist.id, deps)"
          >
            <span class="min-w-0 flex-1 truncate text-start text-sm text-highlighted">
              {{ artist.name }}
            </span>
          </UButton>
        </section>
      </div>
    </template>
  </UDrawer>
</template>

<style scoped>
/*
 * The handle rides the drawer's right edge. Vertical centring is a `translateY`
 * so the horizontal ride can share the same `transform`, and the open state adds
 * the `translateX` that carries it out with the panel. Duration and easing are
 * Vaul's own (`.5s cubic-bezier(.32,.72,0,1)`), so the two move as one; the
 * distance is the content width, capped the same way its `max-w` is.
 */
.quick-menu-handle {
  transform: translateY(-50%);
  transition: transform 0.5s cubic-bezier(0.32, 0.72, 0, 1);
}

.quick-menu-handle--open {
  transform: translateY(-50%) translateX(min(20rem, 80vw));
}

@media (prefers-reduced-motion: reduce) {
  .quick-menu-handle {
    transition-duration: 0ms;
  }
}

.quick-menu-heading {
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ui-text-dimmed);
  padding-inline: 0.25rem;
}

.quick-menu-empty {
  padding-inline: 0.25rem;
  font-size: var(--text-sm);
  color: var(--ui-text-muted);
}
</style>
