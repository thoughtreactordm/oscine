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
import type {
  TrackListDrag,
  TrackListGroupMenu,
  TrackListMenu
} from '@renderer/panels/trackListSource'
import { queueCommandLabel, queueRows, type QueueTarget } from '@renderer/playback/queueCommands'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { usePlaylistEntriesStore } from '@renderer/stores/playlistEntries'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { PLAYLIST_PATH_STYLES } from '@shared/playlists'
import type { Track } from '@shared/library'
import { CONFIRM_ENTRY_REMOVAL_KEY, type CascadeScopeRef } from '@shared/settings'
import { useSettings } from '@renderer/settings'

/**
 * The pane under the tab strip: one playlist's entries.
 *
 * It is `TrackList` — the same virtualized island the library uses, handed a
 * different source — rather than a second list implementation. That was the
 * point of the card: the two lists differ in what they are *ordered by* and in
 * what a row's identity is, and neither difference is a reason to virtualize
 * 100k rows twice.
 *
 * D4 island rules, upwards as well as downwards. The strip above is a sibling
 * and this pane holds no reference to it beyond `viewedPlaylistId`, so either
 * one can be docked elsewhere without the other noticing.
 */

const playlists = usePlaylistsStore()
const entries = usePlaylistEntriesStore()
const playback = usePlaybackStore()
const queue = useQueueCommandsStore()
const addToPlaylist = useAddToPlaylistStore()
const settings = useSettings()

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
 */
const drag = computed<TrackListDrag>(() =>
  albumMajor.value
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

const selectionSize = computed(() => Math.max(1, entries.selectionCount))

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
  const many = entries.isSelectedAt(index) && entries.selectionCount > 1
  const count = many ? entries.selectionCount : 1
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
    {
      label: many
        ? `Remove ${selectionSize.value.toLocaleString()} entries`
        : 'Remove from playlist',
      icon: 'i-tabler-trash',
      color: 'error',
      onSelect: () => void model.remove(index)
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
 * A selection crosses back from entry identity to *track* identity, because the
 * queue holds track ids so that deleting the playlist a row came from cannot
 * reach it (§5 rule 4). `resolveSelectedTracks` is that crossing, and it keeps
 * the playlist order the user is looking at.
 */
async function targetFor(index: number): Promise<QueueTarget> {
  if (!entries.isSelectedAt(index)) {
    const track = entries.rowAt(index)
    return queueRows(track ? [track] : [])
  }
  return queueRows(await entries.resolveSelectedTracks())
}

/** The same rows, as ids — what a playlist stores. */
async function trackIdsFor(index: number): Promise<readonly number[]> {
  const target = await targetFor(index)
  return target.kind === 'rows' ? target.tracks.map((track) => track.id) : target.trackIds
}

function playAt(index: number): void {
  const track = entries.rowAt(index)
  if (track) play(track, index)
}

/**
 * §5 rule 3: this is what makes a playlist the playing one, and the crossfade
 * travels with it because the playing playlist's own value is what the scheduler
 * reads for a boundary.
 */
function play(track: Track, index: number): void {
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
    v-if="playlists.viewed !== null"
    class="flex h-full min-h-0 min-w-0 flex-col"
    :aria-label="playlists.viewed.name"
  >
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2">
      <UIcon name="i-tabler-list-numbers" class="size-4 text-primary" />
      <h2 class="truncate font-semibold text-highlighted">{{ playlists.viewed.name }}</h2>

      <span
        v-if="entries.selectionCount > 0"
        class="ml-auto text-xs tabular-nums text-primary"
        aria-live="polite"
      >
        {{ entries.selectionCount.toLocaleString() }} selected
      </span>
      <span
        class="text-xs tabular-nums text-muted"
        :class="{ 'ml-auto': entries.selectionCount === 0 }"
      >
        {{ entries.total.toLocaleString() }}
      </span>

      <!--
        Said once, in the header, rather than discovered by dragging a row and
        watching nothing happen. The positions are untouched underneath — this
        is a view — so the wording is about what is on screen, not about the
        playlist having changed.
      -->
      <UBadge
        v-if="albumMajor"
        color="neutral"
        variant="subtle"
        size="sm"
        icon="i-tabler-arrows-sort"
        title="Turn album grouping off to reorder this playlist by hand."
      >
        By album
      </UBadge>

      <!--
        Always groupable: turning it on re-sorts the pane, rather than waiting
        for a column this list does not have. So there is no hint to give.
      -->
      <GroupChooser :groupable="true" />

      <PanelSettingsPopover
        v-if="playlistScope"
        :surface="playlistSettings"
        :scope="playlistScope"
      />

      <UDropdownMenu :items="exportItems">
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
        :source="entries"
        :drag="drag"
        :menu="menu"
        :group-menu="groupMenu"
        :label="`${playlists.viewed.name} entries`"
        @activate="activation.activate"
      >
        <template #empty>
          <UEmpty
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
