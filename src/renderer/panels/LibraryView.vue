<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { FermataError, library } from '@renderer/ipc'
import NowPlaying from '@renderer/panels/NowPlaying.vue'
import TrackList from '@renderer/panels/TrackList.vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'
import { useTrackListStore } from '@renderer/stores/trackList'
import type { LibraryRoot, ScanProgress, Track } from '@shared/library'

// Placeholder shell, still. Two of the panels below are real islands now —
// `TrackList` and `NowPlaying` — and the rest is scaffolding: the version card,
// the roots list and the Add folder button all belong to a Sources panel that
// does not exist yet. The three-pane layout is W4-3's.
//
// W3-1's transport harness lived here and is gone. What survives of it is the
// shape of the coupling: this view names no audio type at all now, because the
// engine sits behind the playback store and the transport is its own island.
const shell = useShellStore()
const versions = window.fermata.versions
const trackList = useTrackListStore()
const playback = usePlaybackStore()

const roots = ref<LibraryRoot[]>([])
const scan = ref<ScanProgress | null>(null)
const adding = ref(false)
const notice = ref<string | null>(null)

const trackCount = computed(() => roots.value.reduce((total, root) => total + root.trackCount, 0))

let stopListening: (() => void) | null = null

async function refreshRoots(): Promise<void> {
  try {
    roots.value = await library.listRoots()
  } catch {
    notice.value = 'Could not read the library.'
  }
}

/**
 * Starts a row, handing the playback store the ordering the list is showing.
 *
 * This is the only place the two panels meet, and it is one call: the list
 * says which row under which sort, and playback captures that as the order it
 * will traverse. Neither panel holds a reference to the other.
 */
function playTrack(track: Track, index: number): void {
  void playback.playFromList({
    sort: trackList.sort,
    direction: trackList.direction,
    index,
    track
  })
}

onMounted(async () => {
  stopListening = library.onScanProgress((progress) => {
    // The final event clears the indicator rather than freezing it at 100%.
    scan.value = progress.done ? null : progress
    // Counts only become visible once the scan has committed its last batch.
    if (progress.done) {
      void refreshRoots()
      // The row count and every row position changed; the panel re-reads its
      // window rather than being handed rows from here.
      trackList.reload()
    }
  })

  await refreshRoots()
})

onUnmounted(() => {
  // The bridge holds a listener on the main world; dropping this leaks it.
  stopListening?.()
  // Releases the audio device and every listener the engine still holds. This
  // sits here because this view is the app's only route, so its teardown is the
  // app's; when the docking shell lands the lifetime moves up to the root.
  playback.dispose()
})

async function addFolder(): Promise<void> {
  adding.value = true
  notice.value = null

  try {
    const root = await library.addRoot()
    // `null` means the picker was cancelled, which is not worth reporting.
    if (root) await refreshRoots()
  } catch (err) {
    // A FermataError's message is contractually safe to show; anything else
    // could be carrying a path or a stack, so it gets a generic line.
    notice.value = err instanceof FermataError ? err.message : 'That folder could not be added.'
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <main class="min-h-screen bg-default text-default p-10">
    <div class="mx-auto max-w-2xl space-y-6">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-music-4" class="size-7 text-primary" />
        <h1 class="text-2xl font-semibold text-highlighted">Fermata</h1>
      </div>

      <p class="text-muted">
        Add a folder to index it, then double-click a track to play it. Next and previous follow the
        list's sort order as it was when playback started.
      </p>

      <UAlert
        v-if="notice"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="notice"
      />

      <UCard v-if="scan">
        <div class="flex items-center gap-3">
          <UIcon name="i-lucide-loader-circle" class="size-5 shrink-0 animate-spin text-primary" />
          <div class="min-w-0 flex-1">
            <p class="text-sm text-highlighted">
              Scanning — {{ scan.filesSeen }} found, {{ scan.tracksIndexed }} indexed
            </p>
            <!-- Basename only. The contract never sends a full path here. -->
            <p class="truncate text-xs text-muted">{{ scan.currentFile ?? 'Reading folders…' }}</p>
          </div>
        </div>
      </UCard>

      <UCard>
        <dl class="grid grid-cols-2 gap-y-2 text-sm">
          <dt class="text-muted">Electron</dt>
          <dd class="text-right tabular-nums">{{ versions.electron }}</dd>
          <dt class="text-muted">Chromium</dt>
          <dd class="text-right tabular-nums">{{ versions.chrome }}</dd>
          <dt class="text-muted">Node</dt>
          <dd class="text-right tabular-nums">{{ versions.node }}</dd>
          <dt class="text-muted">Library roots</dt>
          <dd class="text-right tabular-nums">{{ roots.length }}</dd>
          <dt class="text-muted">Tracks</dt>
          <dd class="text-right tabular-nums">{{ trackCount }}</dd>
          <dt class="text-muted">Booted</dt>
          <dd class="text-right tabular-nums">{{ shell.bootedAt }}</dd>
        </dl>
      </UCard>

      <UCard v-if="roots.length">
        <ul class="divide-y divide-default text-sm">
          <li v-for="root in roots" :key="root.id" class="flex items-center gap-3 py-2 first:pt-0">
            <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
            <!-- The user picked this path, so showing it back is not disclosure. -->
            <span class="truncate" :title="root.path">{{ root.path }}</span>
            <span class="ml-auto shrink-0 tabular-nums text-muted">{{ root.trackCount }}</span>
          </li>
        </ul>
      </UCard>

      <NowPlaying />

      <!-- The island. Its height comes from here because a virtualized list
           needs a bounded viewport to virtualize against; nothing else about
           it is this view's business. -->
      <div class="h-96">
        <TrackList @activate="playTrack" />
      </div>

      <div class="flex gap-3">
        <UButton
          color="primary"
          icon="i-lucide-folder-plus"
          :loading="adding"
          :disabled="adding"
          @click="addFolder"
        >
          Add folder
        </UButton>
      </div>
    </div>
  </main>
</template>
