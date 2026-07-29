<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { FermataError, library } from '@renderer/ipc'
import { AudioEngineError, createAudioEngine, type AudioEngine, type PlaybackStatus } from '@renderer/audio'
import { useShellStore } from '@renderer/stores/shell'
import type { LibraryRoot, ScanProgress, Track } from '@shared/library'

// Placeholder shell. W4-1 replaces this with the real virtualized TrackList
// island; for now it exercises the IPC boundary end to end, which is also the
// only way to drive W2-2's add-root flow by hand.
//
// The transport controls below are a W3-1 verification harness, not a design.
// The card's acceptance is behavioural — three codecs playing, seeking and
// reporting duration — and none of it can be checked without something that
// drives the engine. W4-1 deletes all of it and builds the real player UI; what
// should survive is the shape of the coupling, which is that this file imports
// `createAudioEngine` and an `AudioEngine` handle and names no Web Audio type.
const shell = useShellStore()
const versions = window.fermata.versions

const roots = ref<LibraryRoot[]>([])
const tracks = ref<Track[]>([])
const scan = ref<ScanProgress | null>(null)
const adding = ref(false)
const notice = ref<string | null>(null)

const trackCount = computed(() => roots.value.reduce((total, root) => total + root.trackCount, 0))

let stopListening: (() => void) | null = null

// --- playback ------------------------------------------------------------

// Deliberately NOT a `ref`. Vue's reactivity deep-proxies whatever it wraps,
// and reading a `#private` field through a Proxy throws — the engine would blow
// up on its first getter. It is not reactive data anyway; the refs below mirror
// it from its events.
let engine: AudioEngine | null = null
let unsubscribes: Array<() => void> = []

const status = ref<PlaybackStatus>('idle')
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const nowPlaying = ref<Track | null>(null)
const audioNotice = ref<string | null>(null)
// While the scrub handle is held, timeupdate must not fight the user for the
// slider's value.
const scrubbing = ref(false)

const isPlaying = computed(() => status.value === 'playing')
const isBusy = computed(() => status.value === 'loading')
const canPlay = computed(() => nowPlaying.value !== null && !isBusy.value)

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

async function refreshRoots(): Promise<void> {
  try {
    roots.value = await library.listRoots()
  } catch {
    notice.value = 'Could not read the library.'
  }
}

async function refreshTracks(): Promise<void> {
  try {
    const result = await library.listTracks({
      sort: 'title',
      direction: 'asc',
      offset: 0,
      limit: 200
    })
    tracks.value = result.tracks
  } catch {
    notice.value = 'Could not list tracks.'
  }
}

async function playTrack(track: Track): Promise<void> {
  if (!engine) return
  audioNotice.value = null
  nowPlaying.value = track

  try {
    await engine.load(track.id)
    await engine.play()
  } catch (err) {
    // `load` rejects *and* emits `error`, and the subscription below already
    // turned that into a notice — handling both would double-report. The one
    // case worth catching here is `aborted`, which is not a fault at all: it
    // means a newer track was clicked while this one was still decoding.
    if (err instanceof AudioEngineError && err.code === 'aborted') return
  }
}

async function togglePlay(): Promise<void> {
  if (!engine || !canPlay.value) return
  if (isPlaying.value) engine.pause()
  else await engine.play()
}

function onScrubStart(): void {
  scrubbing.value = true
}

function onScrubInput(event: Event): void {
  currentTime.value = Number((event.target as HTMLInputElement).value)
}

function onScrubEnd(): void {
  engine?.seek(currentTime.value)
  scrubbing.value = false
}

function onVolumeInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  volume.value = value
  engine?.setVolume(value)
}

onMounted(async () => {
  stopListening = library.onScanProgress((progress) => {
    // The final event clears the indicator rather than freezing it at 100%.
    scan.value = progress.done ? null : progress
    // Counts only become visible once the scan has committed its last batch.
    if (progress.done) {
      void refreshRoots()
      void refreshTracks()
    }
  })

  engine = createAudioEngine()
  unsubscribes = [
    engine.on('statuschange', (next) => {
      status.value = next
    }),
    engine.on('timeupdate', (position) => {
      duration.value = position.duration
      if (!scrubbing.value) currentTime.value = position.currentTime
    }),
    // M1 is one track at a time with a hard stop, so the end of a track is the
    // end of playback. The queue that reacts to this arrives with M2.
    engine.on('ended', () => {
      audioNotice.value = null
    }),
    engine.on('error', (err) => {
      audioNotice.value = err.message
    })
  ]

  await Promise.all([refreshRoots(), refreshTracks()])
})

onUnmounted(() => {
  // The bridge holds a listener on the main world; dropping this leaks it.
  stopListening?.()
  for (const off of unsubscribes) off()
  unsubscribes = []
  // Releases the audio device and every listener the engine still holds.
  engine?.dispose()
  engine = null
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
        Add a folder to index it, then pick a track to play. The transport below is a W3-1
        verification harness — W4-1 replaces this whole view.
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

      <!-- Transport. W3-1 harness — see the note at the top of this file. -->
      <UCard>
        <div class="space-y-4">
          <UAlert
            v-if="audioNotice"
            color="error"
            variant="subtle"
            icon="i-lucide-volume-x"
            :description="audioNotice"
          />

          <div class="flex items-center gap-3">
            <UButton
              :icon="isPlaying ? 'i-lucide-pause' : 'i-lucide-play'"
              :color="canPlay ? 'primary' : 'neutral'"
              :loading="isBusy"
              :disabled="!canPlay"
              @click="togglePlay"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-highlighted">
                {{ nowPlaying?.title ?? 'Nothing loaded' }}
              </p>
              <p class="truncate text-xs text-muted">
                {{ nowPlaying?.artist ?? '—' }} · {{ status }}
              </p>
            </div>
            <span class="shrink-0 tabular-nums text-xs text-muted">
              {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
            </span>
          </div>

          <!-- Native range inputs, deliberately: this harness is temporary, and
               a component's v-model semantics are one more thing that could be
               wrong while diagnosing audio. W4-1 picks the real control. -->
          <input
            type="range"
            class="w-full accent-primary"
            min="0"
            :max="duration || 1"
            step="0.01"
            :value="currentTime"
            :disabled="!duration"
            @pointerdown="onScrubStart"
            @input="onScrubInput"
            @change="onScrubEnd"
            @pointerup="onScrubEnd"
          />

          <div class="flex items-center gap-3">
            <UIcon name="i-lucide-volume-2" class="size-4 shrink-0 text-muted" />
            <input
              type="range"
              class="w-40 accent-primary"
              min="0"
              max="1"
              step="0.01"
              :value="volume"
              @input="onVolumeInput"
            />
            <span class="tabular-nums text-xs text-muted">{{ Math.round(volume * 100) }}%</span>
          </div>
        </div>
      </UCard>

      <UCard v-if="tracks.length">
        <ul class="divide-y divide-default text-sm">
          <li v-for="track in tracks" :key="track.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 py-2 text-left hover:text-primary"
              :class="{ 'text-primary': nowPlaying?.id === track.id }"
              @click="playTrack(track)"
            >
              <UIcon
                :name="
                  nowPlaying?.id === track.id && isPlaying ? 'i-lucide-volume-2' : 'i-lucide-play'
                "
                class="size-4 shrink-0 text-muted"
              />
              <span class="truncate">{{ track.title }}</span>
              <span class="truncate text-muted">{{ track.artist ?? '' }}</span>
              <span class="ml-auto shrink-0 tabular-nums text-muted">
                {{ track.codec ?? '' }}
              </span>
            </button>
          </li>
        </ul>
      </UCard>

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
