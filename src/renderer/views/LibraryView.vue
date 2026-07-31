<script setup lang="ts">
import { computed } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import ColumnChooser from '@renderer/panels/ColumnChooser.vue'
import GroupChooser from '@renderer/panels/GroupChooser.vue'
import TrackList from '@renderer/panels/TrackList.vue'
import { beginRowDrag, endRowDrag, lazily } from '@renderer/panels/trackDrag'
import type { TrackListDrag, TrackListMenu } from '@renderer/panels/trackListSource'
import {
  queueCommandLabel,
  queueIds,
  queueRows,
  type QueueTarget
} from '@renderer/playback/queueCommands'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { useTrackColumnsStore } from '@renderer/stores/columns'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { useTrackListStore } from '@renderer/stores/trackList'
import type { Track } from '@shared/library'

/**
 * The Library tab's body: the song list and the chrome that describes it.
 *
 * The predicate it renders is written to the track list store by `Sources`,
 * which the frame mounts as this tab's sidebar. The two are siblings under a
 * routed layout now rather than parent and child, so the store carries what the
 * `filters-change` emit used to.
 */
const trackList = useTrackListStore()
const columns = useTrackColumnsStore()
const playback = usePlaybackStore()
const playlists = usePlaylistsStore()
const queue = useQueueCommandsStore()

/**
 * The ordering, shown only when its column is not.
 *
 * A hidden sort column still orders the list, and with no header to carry the
 * arrow the state would otherwise be invisible — the user would see a list
 * sorted by something with no way to tell what. The chooser is where it is
 * changed; this is where it is read.
 */
const hiddenSort = computed(() =>
  columns.isVisible(trackList.sort) ? null : columns.specOf(trackList.sort)
)

function playTrack(track: Track, index: number): void {
  void playback.playFromList({
    sort: trackList.sort,
    direction: trackList.direction,
    filters: trackList.filters,
    index,
    track
  })
}

/**
 * The rows a gesture is about: the selection when the row is in it, that row
 * alone when it is not.
 *
 * `resolveSelection` is the only honest way to read a selection as an ordered
 * list — it goes through main, so it is right after a re-sort and does not
 * depend on which rows happen to be mounted. That is also why it is a promise
 * and why `dragstart` cannot wait for it; see `trackDrag.ts`.
 */
function trackIdsFor(index: number): () => Promise<readonly number[]> {
  if (trackList.isSelectedAt(index)) return lazily(() => trackList.resolveSelection())
  const track = trackList.rowAt(index)
  return () => Promise.resolve(track ? [track.id] : [])
}

function rowCount(index: number): number {
  return trackList.isSelectedAt(index) ? Math.max(1, trackList.selectionCount) : 1
}

/**
 * The library is a drag *source* and never a target — dropping tracks onto the
 * library would have to mean copying files, which v1 does not do (D7's
 * neighbour: nothing here writes to disk).
 */
const drag: TrackListDrag = {
  enabled: true,
  indicatorAt: () => null,
  start(index) {
    beginRowDrag({
      count: rowCount(index),
      playlistId: null,
      trackIds: trackIdsFor(index),
      // Library rows are not playlist entries, so there is nothing to reorder.
      entryIds: null
    })
    return true
  },
  over: () => false,
  drop: () => {},
  end: endRowDrag
}

/**
 * The row menu: the queue verbs, then "add to playlist".
 *
 * Both queue verbs come from `queueCommands`, wording included, so that this
 * menu and the playlist pane's cannot drift — and so W7-2's deck pane inherits
 * them rather than restating them.
 *
 * A single loaded row is handed over as a *row*, a multi-select as ids. The
 * queue holds display snapshots, and the list resolves a selection through main
 * precisely so it never has to keep the rows for one.
 */
const menu: TrackListMenu = (index): ContextMenuItem[] => {
  const count = rowCount(index)
  const label = count === 1 ? 'Add to playlist' : `Add ${count.toLocaleString()} tracks to playlist`
  return [
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
    {
      label,
      icon: 'i-tabler-playlist-add',
      children:
        playlists.list.length === 0
          ? [{ label: 'No playlists yet', disabled: true }]
          : playlists.list.map((playlist) => ({
              label: playlist.name,
              onSelect: () => void addToPlaylist(playlist.id, index)
            }))
    }
  ]
}

/**
 * What a queue verb is aimed at, resolved the same way the drag resolves.
 *
 * Ids rather than the `Set` behind the selection, because a set has no order
 * and the visible one is the whole point — `resolveSelection` is where that
 * order lives, which is why this is a promise.
 */
async function targetFor(index: number): Promise<QueueTarget> {
  if (trackList.isSelectedAt(index)) return queueIds(await trackList.resolveSelection())
  const track = trackList.rowAt(index)
  return queueRows(track ? [track] : [])
}

async function addToPlaylist(playlistId: number, index: number): Promise<void> {
  await playlists.addTracks(playlistId, await trackIdsFor(index)())
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col" aria-label="Songs">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2">
      <UIcon name="i-tabler-playlist" class="size-4 text-primary" />
      <h2 class="font-semibold text-highlighted">Songs</h2>

      <UBadge
        v-if="hiddenSort"
        color="neutral"
        variant="subtle"
        size="sm"
        :icon="trackList.direction === 'asc' ? 'i-tabler-chevron-up' : 'i-tabler-chevron-down'"
      >
        {{ hiddenSort.title ?? hiddenSort.label }}
      </UBadge>

      <span
        v-if="trackList.selectionCount > 0"
        class="ml-auto text-xs tabular-nums text-primary"
        aria-live="polite"
      >
        {{ trackList.selectionCount.toLocaleString() }} selected
      </span>
      <span
        class="text-xs tabular-nums text-muted"
        :class="{ 'ml-auto': trackList.selectionCount === 0 }"
      >
        {{ trackList.total.toLocaleString() }}
      </span>

      <GroupChooser />
      <ColumnChooser />
    </div>
    <div class="min-h-0 flex-1">
      <TrackList :source="trackList" :drag="drag" :menu="menu" @activate="playTrack" />
    </div>
  </section>
</template>
