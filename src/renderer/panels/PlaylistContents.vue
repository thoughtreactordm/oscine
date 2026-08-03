<script setup lang="ts">
import { computed } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import GroupChooser from '@renderer/panels/GroupChooser.vue'
import { createPlaylistContents } from '@renderer/panels/playlistContents'
import { panelSettingsSurface } from '@renderer/panels/settings/panelSettings'
import PanelSettingsPopover from '@renderer/panels/settings/PanelSettingsPopover.vue'
import TrackList from '@renderer/panels/TrackList.vue'
import { activeRowDrag, beginRowDrag, endRowDrag, lazily } from '@renderer/panels/trackDrag'
import { useTrackActivation } from '@renderer/panels/useTrackActivation'
import { FAVORITES_TAB } from '@renderer/panels/playlistTabs'
import type {
  TrackListDrag,
  TrackListGroupMenu,
  TrackListMenu,
  TrackListSource
} from '@renderer/panels/trackListSource'
import {
  queueCommandLabel,
  queueIds,
  queueRows,
  type QueueTarget
} from '@renderer/playback/queueCommands'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { useFavoritesListStore } from '@renderer/stores/favoritesList'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { usePlaylistEntriesStore } from '@renderer/stores/playlistEntries'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { PLAYLIST_PATH_STYLES } from '@shared/playlists'
import type { Track } from '@shared/library'
import { CONFIRM_ENTRY_REMOVAL_KEY, type CascadeScopeRef } from '@shared/settings'
import { useSettings } from '@renderer/settings'

/**
 * The pane under the tab strip: the viewed collection's rows.
 *
 * It is `TrackList` — the same virtualized island the library uses, handed a
 * different source — rather than a second list implementation. That was the
 * point of the card: the lists differ in what they are *ordered by* and in what
 * a row's identity is, and neither difference is a reason to virtualize 100k
 * rows twice.
 *
 * ## Two collections, one pane — **D18**
 *
 * A playlist's entries, or My Favorites. The second is a *view over
 * `track_favorites`*, not a `playlists` row, so almost everything below reads
 * `favoritesViewed` and branches — and the branches are the honest ones rather
 * than a shim:
 *
 * - **Identity.** `TrackListSource.rowIdentity` says which. A playlist speaks
 *   `playlist_entries.id` because D12 makes the same track legal twice; the
 *   favorites speak `tracks.id` because a favorite is one row or none. Nothing
 *   here mints a synthetic entry id to hide the difference.
 * - **Reorder is off, and it is not a bug.** There is no authored position to
 *   drag against, which is D18's accepted cost. The header says so, the same way
 *   it says so under album grouping.
 * - **Removing a row un-favorites the track.** The same fact as un-hearting,
 *   said from the other end, and unconfirmed for that reason — see
 *   `favoritesList.remove`.
 * - **No export and no crossfade override.** Both are properties of a
 *   `playlists` row, and there is not one. The affordances are absent rather
 *   than present-and-disabled.
 *
 * D4 island rules, upwards as well as downwards. The strip above is a sibling
 * and this pane holds no reference to it beyond `viewedStop`, so either one can
 * be docked elsewhere without the other noticing.
 */

const playlists = usePlaylistsStore()
const entries = usePlaylistEntriesStore()
const favorites = useFavoritesListStore()
const playback = usePlaybackStore()
const queue = useQueueCommandsStore()
const addToPlaylist = useAddToPlaylistStore()
const settings = useSettings()

/** Which of the two collections is on screen. Everything below branches on it. */
const favoritesViewed = computed(() => playlists.viewedStop === FAVORITES_TAB)

/**
 * The rows, whichever collection they are.
 *
 * Both stores satisfy `TrackListSource` and neither knows about the other; this
 * is the one place the choice is made, which is what let the pane grow a second
 * collection without growing a second implementation.
 */
const source = computed<TrackListSource>(() => (favoritesViewed.value ? favorites : entries))

/**
 * The gear on this header edits *this playlist's* crossfade.
 *
 * The one place W8-8 exercises the cascade outside the settings view: the same
 * `audio.crossfadeMs` descriptor, the same control, resolved against a playlist
 * scope instead of the global row — so the inheriting/overridden affordance
 * W8-5 built has to work where an operator would actually meet it. Held as a
 * scope ref rather than an id so the popover never learns what a playlist is.
 */
const playlistScope = computed<CascadeScopeRef | null>(() => {
  const viewed = playlists.viewed
  return viewed === null ? null : { kind: 'playlist', id: viewed.id }
})

const playlistSettings = panelSettingsSurface('playlist-playback')

const model = createPlaylistContents({
  playlistId: () => entries.playlistId,
  entryIdAt: (index) => entries.entryIdAt(index),
  isSelectedAt: (index) => entries.isSelectedAt(index),
  selectionCount: () => entries.selectionCount,
  resolveSelection: () => entries.resolveSelection(),
  activeDrag: activeRowDrag,
  beginDrag: beginRowDrag,
  endDrag: endRowDrag,
  confirmRemoval: () => settings.get<boolean>(CONFIRM_ENTRY_REMOVAL_KEY),
  commands: {
    addTracks: (trackIds, insertion) => entries.addTracks(trackIds, insertion),
    moveEntries: (entryIds, insertion) => entries.moveEntries(entryIds, insertion),
    removeEntries: (entryIds) => entries.removeEntries(entryIds)
  }
})

/**
 * Whether the pane is showing the playlist or a view of it.
 *
 * Album grouping re-sorts the entries, so while it is on the rows on screen are
 * not the sequence the positions describe. Everything that reads a row is fine
 * with that; everything that *writes* one is not.
 */
const albumMajor = computed(() => entries.order === 'album')

/**
 * The list's drag adapter.
 *
 * "Past the last row" is drawn as a marker under the final row rather than as a
 * separate target, because in a virtualized list there is no reliable space
 * after the rows to aim at — and the bottom edge of the last row already means
 * the same thing.
 *
 * Off entirely under album grouping, and this is the honest half of that trade.
 * A drop is expressed against the entry it lands beside (`PlaylistInsertion`),
 * and beside-in-the-album-view is a different row from beside-in-the-playlist —
 * so a drag that looked right would write a position the operator did not
 * choose. Refusing the gesture is better than performing a different one, and
 * the header says why rather than leaving a dead drag to be discovered.
 *
 * Off entirely in My Favorites too, and for a reason that will not go away:
 * there is no authored position to drag *against*. `favorited_at` is when the
 * heart was clicked, and a reorder would have to invent a second ordering to
 * write into. That is D18's accepted cost, and the header names it here for the
 * same reason it names the grouping one.
 */
const drag = computed<TrackListDrag>(() =>
  albumMajor.value || favoritesViewed.value
    ? {
        enabled: false,
        indicatorAt: () => null,
        start: () => false,
        over: () => false,
        drop: () => {},
        end: () => {}
      }
    : {
        enabled: true,
        indicatorAt: (index) =>
          model.dropIndicator(index) ??
          (model.droppingAtEnd.value && index === entries.total - 1 ? 'after' : null),
        start: (index) => model.beginDrag(index),
        over: (index, side) => model.dragOver(index, side),
        drop: () => void model.drop(),
        end: () => model.endDrag()
      }
)

const selectionSize = computed(() => Math.max(1, source.value.selectionCount))

/**
 * What the pane is called and what it is drawn with.
 *
 * "My Favorites" is a literal here and nowhere else. It is not a `playlists` row
 * and there is nothing to read the name from, which is the trade D18 made: the
 * pinned entry is a special case with a hardcoded name until a second
 * system-owned collection appears, and that second one is D18's own revisit
 * trigger.
 */
const title = computed(() =>
  favoritesViewed.value ? 'My Favorites' : (playlists.viewed?.name ?? '')
)
const icon = computed(() => (favoritesViewed.value ? 'i-tabler-heart' : 'i-tabler-list-numbers'))

/**
 * The rows a remove gesture is about, as **track** ids.
 *
 * The favorites half of `createPlaylistContents.resolveRemoval`, and it is short
 * because `resolveSelection` already answers in track ids here — the identity
 * `favorites.remove` takes. The playlist half cannot share it: there the same
 * resolution has to stay in entry ids, or removing one copy of a duplicate would
 * take both.
 */
async function favoriteRemovalIds(index: number): Promise<readonly number[]> {
  if (!favorites.isSelectedAt(index)) {
    const track = favorites.rowAt(index)
    return track ? [track.id] : []
  }
  return favorites.resolveSelection()
}

/** Removes rows from whichever collection is on screen. */
async function removeAt(index: number): Promise<void> {
  if (!favoritesViewed.value) return model.remove(index)
  await favorites.remove(await favoriteRemovalIds(index))
}

/**
 * The row menu. The two queue verbs are the same module the library list uses,
 * wording included — "available from the library list, the playlist contents
 * pane, and any multi-select in either" is one import, not two menus that agree.
 *
 * Queueing from here goes by *track*, never by entry id: the queue holds track
 * ids so that deleting the playlist a row came from cannot reach it (§5 rule 4),
 * and an entry id would be the one identity that could.
 */
const menu: TrackListMenu = (index): ContextMenuItem[] => {
  const list = source.value
  const many = list.isSelectedAt(index) && list.selectionCount > 1
  const count = many ? list.selectionCount : 1
  return [
    {
      label: 'Play',
      icon: 'i-tabler-player-play',
      onSelect: () => playAt(index)
    },
    {
      label: queueCommandLabel('playNext', count),
      icon: 'i-tabler-corner-right-down',
      onSelect: () => void targetFor(index).then(queue.playNext)
    },
    {
      label: queueCommandLabel('addToQueue', count),
      icon: 'i-tabler-list-numbers',
      onSelect: () => void targetFor(index).then(queue.addToQueue)
    },
    { type: 'separator' },
    // Copying entries out into another playlist, including a new one. By track
    // id and never by entry id, for the same reason the queue verbs above are:
    // an entry belongs to the playlist it is in, and a copy of it does not.
    addToPlaylist.menuItem({ count, trackIds: () => trackIdsFor(index) }),
    { type: 'separator' },
    // Two verbs, two wordings, because they are two different things. Removing
    // an entry takes a row out of a playlist; removing a favorite un-hearts the
    // track, which is a fact about the track itself and is worth saying.
    favoritesViewed.value
      ? {
          label: many
            ? `Un-favorite ${selectionSize.value.toLocaleString()} tracks`
            : 'Remove from favorites',
          icon: 'i-tabler-heart-off',
          color: 'error',
          onSelect: () => void removeAt(index)
        }
      : {
          label: many
            ? `Remove ${selectionSize.value.toLocaleString()} entries`
            : 'Remove from playlist',
          icon: 'i-tabler-trash',
          color: 'error',
          onSelect: () => void removeAt(index)
        }
  ]
}

/**
 * The album-header menu — the run's verbs, including the one only a playlist
 * has.
 *
 * Two identities in play, and which one each verb takes is the whole of the
 * care here. "Remove" takes **entry ids**, because D12 makes the same track
 * legal twice and removing this album must take the copies inside the run and
 * leave any outside it. Everything else takes **tracks**, because the queue and
 * the playlists hold track ids so that deleting the playlist a row came from
 * cannot reach them (§5 rule 4).
 *
 * Both resolve from the run's offset span rather than from the selection, so a
 * menu click acts on the album under the pointer and leaves whatever the
 * operator had ticked exactly as it was.
 *
 * Playlist-only, and structurally so: `TrackList` calls this for an album
 * header, and My Favorites reports no runs to head. It reads `entries` directly
 * rather than `source` for that reason — a branch here would be a branch on a
 * condition that cannot occur.
 */
const groupMenu: TrackListGroupMenu = (run): ContextMenuItem[] => {
  const count = run.group.trackCount
  const last = run.firstOffset + count - 1
  const album = run.group.title ?? 'Unknown album'
  const tracks = lazily(() => entries.tracksInRange(run.firstOffset, last))
  const trackIds = async (): Promise<readonly number[]> => (await tracks()).map((track) => track.id)

  return [
    {
      label: 'Play',
      icon: 'i-tabler-player-play',
      onSelect: () => playAt(run.firstOffset)
    },
    {
      label: queueCommandLabel('playNext', count),
      icon: 'i-tabler-corner-right-down',
      onSelect: () => void tracks().then((rows) => queue.playNext(queueRows(rows)))
    },
    {
      label: queueCommandLabel('addToQueue', count),
      icon: 'i-tabler-list-numbers',
      onSelect: () => void tracks().then((rows) => queue.addToQueue(queueRows(rows)))
    },
    { type: 'separator' },
    addToPlaylist.menuItem({ count, trackIds, suggestedName: album }),
    { type: 'separator' },
    {
      label: count === 1 ? 'Remove from playlist' : `Remove ${count.toLocaleString()} entries`,
      icon: 'i-tabler-trash',
      color: 'error',
      // Through the model, not through the store: this is a removal like any
      // other and `interface.confirmEntryRemoval` has to reach it.
      onSelect: () =>
        void entries.idsInRange(run.firstOffset, last).then((ids) => model.removeEntries(ids))
    }
  ]
}

/**
 * The export affordance W5-4 built the seam for and deliberately left unhung.
 *
 * Per export rather than per setting, because `PlaylistPathStyle` is a real
 * choice between two defensible answers and neither camp can be talked out of
 * theirs — see the note on the constant.
 */
const exportItems = computed<ContextMenuItem[]>(() =>
  PLAYLIST_PATH_STYLES.map((style) => ({
    label: style === 'relative' ? 'Export with relative paths…' : 'Export with absolute paths…',
    icon: 'i-tabler-file-export',
    onSelect: () => {
      const playlist = playlists.viewed
      if (playlist !== null) void playlists.exportM3u8(playlist.id, style)
    }
  }))
)

/**
 * The rows a queue verb is about.
 *
 * In a playlist a selection crosses back from entry identity to *track*
 * identity, because the queue holds track ids so that deleting the playlist a
 * row came from cannot reach it (§5 rule 4). `resolveSelectedTracks` is that
 * crossing, and it keeps the playlist order the user is looking at.
 *
 * In My Favorites there is no crossing to make: `rowIdentity` is already
 * `'track'`, so the selection resolves straight to the ids the queue wants. The
 * two branches are the identity difference showing up where it actually costs
 * something, rather than being smoothed over upstream.
 */
async function targetFor(index: number): Promise<QueueTarget> {
  const list = source.value
  if (!list.isSelectedAt(index)) {
    const track = list.rowAt(index)
    return queueRows(track ? [track] : [])
  }
  if (favoritesViewed.value) return queueIds(await favorites.resolveSelection())
  return queueRows(await entries.resolveSelectedTracks())
}

/** The same rows, as ids — what a playlist stores. */
async function trackIdsFor(index: number): Promise<readonly number[]> {
  const target = await targetFor(index)
  return target.kind === 'rows' ? target.tracks.map((track) => track.id) : target.trackIds
}

function playAt(index: number): void {
  const track = source.value.rowAt(index)
  if (track) play(track, index)
}

/**
 * Starts the row, in whichever collection it belongs to.
 *
 * The playlist branch is §5 rule 3: it makes a playlist the playing one, and
 * the crossfade travels with it because the playing playlist's own value is what
 * the scheduler reads for a boundary.
 *
 * The favorites branch is deliberately *not* rule 3. My Favorites is not a
 * playlist, so `playFromFavorites` clears `playingPlaylistId` and the crossfade
 * reverts to the global setting — the same thing the library order does, and for
 * the same reason: there is no `playlists` row here to carry an override.
 */
function play(track: Track, index: number): void {
  if (favoritesViewed.value) {
    void playback.playFromFavorites({ index, track })
    return
  }
  const playlist = playlists.viewed
  if (playlist === null) return
  void playback.playFromPlaylist({
    playlistId: playlist.id,
    index,
    track
  })
}

/**
 * What a double-click does here, which is not necessarily playing.
 *
 * `playAt` — the menu's Play — still goes straight to `play`. A verb the
 * operator named is not the gesture the setting is about.
 */
const activation = useTrackActivation(play)

const removal = computed(() => model.removalPrompt.value)
const removalOpen = computed({
  get: () => removal.value !== null,
  // Escape, the close button and a click outside all have to mean Keep, the
  // same way the rail's delete prompt reads them.
  set: (open: boolean) => {
    if (!open) model.cancelRemoval()
  }
})
</script>

<template>
  <section
    v-if="favoritesViewed || playlists.viewed !== null"
    class="flex h-full min-h-0 min-w-0 flex-col"
    :aria-label="title"
  >
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2">
      <UIcon :name="icon" class="size-4 text-primary" />
      <h2 class="truncate font-semibold text-highlighted">{{ title }}</h2>

      <span
        v-if="source.selectionCount > 0"
        class="ml-auto text-xs tabular-nums text-primary"
        aria-live="polite"
      >
        {{ source.selectionCount.toLocaleString() }} selected
      </span>
      <span
        class="text-xs tabular-nums text-muted"
        :class="{ 'ml-auto': source.selectionCount === 0 }"
      >
        {{ source.total.toLocaleString() }}
      </span>

      <!--
        Said once, in the header, rather than discovered by dragging a row and
        watching nothing happen. The positions are untouched underneath — this
        is a view — so the wording is about what is on screen, not about the
        playlist having changed.
      -->
      <UBadge
        v-if="albumMajor && !favoritesViewed"
        color="neutral"
        variant="subtle"
        size="sm"
        icon="i-tabler-arrows-sort"
        title="Turn album grouping off to reorder this playlist by hand."
      >
        By album
      </UBadge>

      <!--
        D18's accepted cost, in the one place an operator meets it. Stated rather
        than left to be discovered by dragging a row that will not move: there is
        no authored position here to drag against, and there is no setting that
        would bring one back.
      -->
      <UBadge
        v-if="favoritesViewed"
        color="neutral"
        variant="subtle"
        size="sm"
        icon="i-tabler-clock"
        title="My Favorites is ordered by when you hearted each track, so its rows cannot be dragged into another order."
      >
        Newest first
      </UBadge>

      <!--
        Always groupable in a playlist: turning it on re-sorts the pane, rather
        than waiting for a column this list does not have. Absent in My
        Favorites, which serves one order and has no runs query behind it.
      -->
      <GroupChooser v-if="!favoritesViewed" :groupable="true" />

      <PanelSettingsPopover
        v-if="playlistScope"
        :surface="playlistSettings"
        :scope="playlistScope"
      />

      <!--
        Export is a playlist verb. My Favorites has no `playlists` row to export
        and no path style to choose for it, so the affordance is *absent* rather
        than present and disabled — the same rule the rail's rename and delete
        follow. D18 names this as the cost that will be asked about first.
      -->
      <UDropdownMenu v-if="!favoritesViewed" :items="exportItems">
        <UButton
          icon="i-tabler-dots"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="Playlist actions"
        />
      </UDropdownMenu>
    </div>

    <div class="min-h-0 flex-1">
      <TrackList
        :source="source"
        :drag="drag"
        :menu="menu"
        :group-menu="groupMenu"
        :label="favoritesViewed ? 'My Favorites' : `${title} entries`"
        @activate="activation.activate"
      >
        <template #empty>
          <!--
            Two empty states, and neither is an error. The favorites one is the
            reason the rail entry stays put with nothing in it: a collection you
            have not filled yet is a normal state, and an entry that vanished
            when you un-hearted your last track would be a collection you could
            not find your way back to.
          -->
          <UEmpty
            v-if="favoritesViewed"
            variant="naked"
            icon="i-tabler-heart"
            title="No favorites yet"
            description="Click the heart on a track — in the song list, or in Now Playing — and it lands here."
            class="h-full"
          />
          <UEmpty
            v-else
            variant="naked"
            icon="i-tabler-playlist-add"
            title="Nothing in this playlist yet"
            description="Drag tracks in from the library, or right-click a selection there."
            class="h-full"
          />
        </template>
      </TrackList>
    </div>
  </section>

  <UEmpty
    v-else
    variant="naked"
    icon="i-tabler-playlist-add"
    title="No playlist open"
    description="Click a playlist in the rail to open it, or double-click to play it."
    class="h-full"
  />

  <UModal
    v-model:open="removalOpen"
    :title="removal?.title ?? ''"
    :description="removal?.message ?? ''"
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <UButton color="neutral" variant="ghost" @click="model.cancelRemoval()">Keep</UButton>
      <UButton color="primary" icon="i-tabler-playlist-x" @click="model.confirmRemoval()">
        Remove
      </UButton>
    </template>
  </UModal>
</template>
