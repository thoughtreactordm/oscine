<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { library } from '@renderer/ipc'
import { formatDuration } from '@renderer/panels/displayFormat'
import DiscTrackTable from '@renderer/panels/tools/DiscTrackTable.vue'
import ReleaseMatchPicker from '@renderer/panels/tools/ReleaseMatchPicker.vue'
import { RIP_COLLISION_OPTIONS, RIP_PHASE_LABEL } from '@renderer/panels/tools/cdRipModel'
import { useBrowseStore } from '@renderer/stores/browse'
import { useCdRipStore } from '@renderer/stores/cdRip'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { artworkUrl } from '@shared/ipc'
import type { RipOutcome } from '@shared/cdrip'

/**
 * Rip CD — **W18-7**. Polls the drive only while this pane is on screen.
 */
const store = useCdRipStore()
const browse = useBrowseStore()
const roots = useLibraryRootsStore()
const router = useRouter()

onMounted(() => store.startPolling())
onBeforeUnmount(() => store.stopPolling())

const summaryText = computed(() => {
  const summary = store.summary
  if (!summary) return ''
  const tracks = summary.trackCount === 1 ? '1 track' : `${summary.trackCount} tracks`
  return `${tracks} · ${formatDuration(summary.durationSec, 'auto')}`
})

const progressText = computed(() => {
  const progress = store.progress
  if (!progress) return ''
  const phase = RIP_PHASE_LABEL[progress.phase]
  return `${phase} · track ${progress.trackIndex + 1} of ${progress.trackCount}`
})

const progressPct = computed(() => {
  const progress = store.progress
  if (!progress || progress.trackCount <= 0) return 0
  const sector = progress.sectorsTotal > 0 ? progress.sectorsDone / progress.sectorsTotal : 0
  return Math.round(((progress.trackIndex + sector) / progress.trackCount) * 100)
})

const reportSummary = computed(() => {
  const report = store.report
  if (!report) return ''
  return `Wrote ${report.written} · skipped ${report.skipped} · failed ${report.failed} of ${report.total}`
})

const outcomeByTrack = computed(() => {
  const map = new Map<number, RipOutcome>()
  for (const outcome of store.report?.outcomes ?? []) map.set(outcome.trackNumber, outcome)
  return map
})

const collisionItems = RIP_COLLISION_OPTIONS.map((option) => ({
  label: option.label,
  value: option.value
}))

const showAddRoot = computed(
  () =>
    store.destination.trim() !== '' &&
    store.destResult !== null &&
    !store.destResult.ok &&
    store.destResult.reason === 'outside-roots'
)

const canReveal = computed(() => (store.report?.trackIds.length ?? 0) > 0)

async function revealAlbum(): Promise<void> {
  const trackId = store.report?.trackIds[0]
  if (trackId === undefined) return
  const facets = await library.trackFacets(trackId)
  if (facets.albumId !== null) browse.revealAlbum(facets.albumId)
  else if (facets.artistId !== null) browse.revealArtist(facets.artistId)
  await router.push({ name: 'library' })
}

function onYear(value: unknown): void {
  if (value === '' || value === null || value === undefined) {
    store.setYear(null)
    return
  }
  const parsed = Number(value)
  store.setYear(Number.isFinite(parsed) ? Math.trunc(parsed) : null)
}

function toggleAll(): void {
  store.setAllIncluded(store.headerState !== 'all')
}

function onCollision(value: unknown): void {
  if (value === 'skip' || value === 'overwrite' || value === 'suffix') {
    store.setCollision(value)
  }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-default">
    <header class="flex shrink-0 items-center gap-3 border-b border-default px-4 py-2">
      <UIcon name="i-tabler-disc" class="size-4 shrink-0 text-dimmed" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-highlighted">Rip CD</p>
        <p class="truncate text-xs text-muted">
          {{ summaryText || 'Insert a disc to begin' }}
        </p>
      </div>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-tabler-refresh"
        label="Refresh"
        :disabled="store.ripping"
        @click="store.refresh()"
      />
      <template v-if="store.status === 'ripping'">
        <span class="text-xs tabular-nums text-muted">{{ progressText }}</span>
        <UButton
          size="xs"
          color="error"
          variant="soft"
          icon="i-tabler-x"
          label="Cancel"
          @click="store.cancelRip()"
        />
      </template>
      <UButton
        v-else
        size="xs"
        color="primary"
        label="Rip"
        :disabled="!store.ripEnabled"
        @click="store.startRip()"
      />
    </header>

    <div
      v-if="store.canResume"
      class="flex shrink-0 items-center gap-2 border-b border-default px-4 py-2 text-xs"
    >
      <UIcon name="i-tabler-player-play" class="size-4 shrink-0 text-primary" />
      <span class="min-w-0 flex-1 truncate text-muted">{{ store.resumeText }}</span>
      <UButton
        size="xs"
        color="primary"
        label="Resume"
        :disabled="store.ripping"
        @click="store.resumeRip()"
      />
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        label="Dismiss"
        :disabled="store.ripping"
        @click="store.dismissResume()"
      />
    </div>

    <div v-if="store.status === 'ripping'" class="h-1 w-full shrink-0 bg-elevated">
      <div
        class="h-full bg-primary transition-[width] duration-150"
        :style="{ width: `${progressPct}%` }"
      />
    </div>

    <div
      v-if="store.status === 'done' && store.report"
      class="flex shrink-0 items-center gap-2 border-b border-default px-4 py-2 text-xs"
    >
      <UIcon
        :name="store.report.failed > 0 ? 'i-tabler-alert-triangle' : 'i-tabler-check'"
        class="size-4"
        :class="store.report.failed > 0 ? 'text-error' : 'text-success'"
      />
      <span class="text-muted">{{ reportSummary }}</span>
      <span v-if="store.report.cancelled" class="text-warning">· stopped early</span>
      <UButton
        v-if="canReveal"
        size="xs"
        color="neutral"
        variant="ghost"
        label="Show in library"
        @click="revealAlbum()"
      />
    </div>

    <div
      v-if="store.detection === 'ready' && store.showPicker"
      class="flex min-h-0 flex-1 flex-col"
    >
      <p v-if="summaryText" class="shrink-0 px-4 pt-3 text-xs text-muted">{{ summaryText }}</p>
      <ReleaseMatchPicker
        :candidates="store.candidates"
        :selected-index="store.selectedCandidate"
        @select="store.selectCandidate"
        @confirm="store.confirmCandidate"
        @skip="store.skipPicker"
      />
    </div>

    <div v-else-if="store.detection === 'ready'" class="@container flex min-h-0 flex-1 flex-col">
      <div class="max-h-[60%] shrink-0 space-y-3 overflow-y-auto border-b border-default px-4 py-3">
        <p v-if="store.notice" class="text-[11px] text-warning">{{ store.notice }}</p>
        <p v-else-if="store.quietLine" class="text-[11px] text-dimmed">{{ store.quietLine }}</p>
        <p v-else-if="store.lookingUp" class="text-[11px] text-dimmed">Looking up this disc…</p>
        <div class="rip-details grid items-start gap-4">
          <div class="w-40 min-w-0">
            <p class="text-[11px] font-medium text-dimmed">Album art</p>
            <div
              class="mt-1 flex aspect-square flex-col items-center justify-center gap-2 rounded-md border border-default bg-elevated"
            >
              <img
                v-if="store.artwork?.hash"
                :src="artworkUrl(store.artwork.hash, 'large')"
                :alt="`Cover art for ${store.album || 'this disc'}`"
                class="size-full rounded-md object-contain"
                draggable="false"
              />
              <template v-else>
                <UIcon name="i-tabler-vinyl" class="size-10 text-dimmed" />
                <span class="text-[11px] text-dimmed">No album art</span>
              </template>
            </div>
            <div class="mt-2 flex flex-wrap gap-1">
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                :label="store.artwork ? 'Replace…' : 'Choose…'"
                :loading="store.pickingArtwork"
                :disabled="store.ripping || store.pickingArtwork"
                aria-label="Choose album art"
                @click="store.pickArtwork()"
              />
              <UButton
                v-if="store.artwork"
                size="xs"
                color="neutral"
                variant="ghost"
                label="Remove"
                :disabled="store.ripping || store.pickingArtwork"
                @click="store.removeArtwork()"
              />
            </div>
            <p v-if="store.artworkError" role="alert" class="mt-1 text-[11px] text-warning">
              {{ store.artworkError }}
            </p>
          </div>
          <div class="min-w-0 space-y-2">
            <div class="min-w-0">
              <label for="rip-album" class="text-[11px] font-medium text-dimmed">Title</label>
              <UInput
                id="rip-album"
                :model-value="store.album"
                size="sm"
                class="mt-1 w-full"
                placeholder="Unknown Album"
                aria-label="Album"
                :disabled="store.ripping"
                @update:model-value="store.setAlbum(String($event ?? ''))"
              />
            </div>
            <div class="min-w-0">
              <label for="rip-artist" class="text-[11px] font-medium text-dimmed">Artist</label>
              <UInput
                id="rip-artist"
                :model-value="store.albumArtist"
                size="sm"
                class="mt-1 w-full"
                placeholder="Unknown Artist"
                aria-label="Album artist"
                :disabled="store.ripping"
                @update:model-value="store.setAlbumArtist(String($event ?? ''))"
              />
            </div>
            <div class="min-w-0">
              <label for="rip-year" class="text-[11px] font-medium text-dimmed">Year</label>
              <UInput
                id="rip-year"
                :model-value="store.year === null ? '' : String(store.year)"
                size="sm"
                class="mt-1 w-full"
                placeholder="Year"
                aria-label="Year"
                :disabled="store.ripping"
                @update:model-value="onYear($event)"
              />
            </div>
          </div>
          <div class="rip-output min-w-0 space-y-2">
            <div class="min-w-0">
              <label for="rip-destination" class="text-[11px] font-medium text-dimmed"
                >Destination</label
              >
              <div class="mt-1 flex gap-1">
                <UInput
                  id="rip-destination"
                  :model-value="store.destination"
                  size="sm"
                  class="min-w-0 flex-1"
                  aria-label="Rip destination"
                  :disabled="store.ripping"
                  @update:model-value="store.setDestinationPath(String($event ?? ''))"
                />
                <UButton
                  size="sm"
                  color="neutral"
                  variant="soft"
                  label="Choose…"
                  :disabled="store.ripping"
                  @click="store.pickDestination()"
                />
              </div>
              <p v-if="store.destReason" class="mt-1 text-[11px] text-warning">
                {{ store.destReason }}
                <button
                  v-if="showAddRoot"
                  type="button"
                  class="ml-1 text-primary underline-offset-2 hover:underline"
                  @click="roots.addFolder()"
                >
                  Add as a library folder
                </button>
              </p>
            </div>
            <div class="min-w-0">
              <label for="rip-template" class="text-[11px] font-medium text-dimmed"
                >Naming template</label
              >
              <UInput
                id="rip-template"
                :model-value="store.template"
                size="sm"
                class="mt-1 w-full"
                aria-label="Naming template"
                :disabled="store.ripping"
                @update:model-value="store.setTemplate(String($event ?? ''))"
              />
              <p v-if="store.preview" class="mt-1 truncate font-mono text-[11px] text-dimmed">
                {{ store.preview }}
              </p>
            </div>
            <div>
              <label for="rip-collision" class="text-[11px] font-medium text-dimmed"
                >If a file exists</label
              >
              <USelect
                id="rip-collision"
                :model-value="store.collision"
                value-key="value"
                :items="collisionItems"
                size="sm"
                class="mt-1 w-full"
                :disabled="store.ripping"
                aria-label="If a file exists"
                @update:model-value="onCollision($event)"
              />
            </div>
          </div>
        </div>
      </div>

      <DiscTrackTable
        :tracks="store.tracks"
        :header-state="store.headerState"
        :duration-of="store.trackDurationSec"
        :outcomes="outcomeByTrack"
        :disabled="store.ripping"
        @toggle-all="toggleAll"
        @toggle="store.toggleIncluded"
        @update:title="store.setTrackTitle"
        @update:artist="store.setTrackArtist"
      />
    </div>

    <div v-else class="grid min-h-0 flex-1 place-items-center p-8 text-center">
      <div class="max-w-sm">
        <template v-if="store.detection === 'reading'">
          <UIcon name="i-tabler-loader-2" class="mx-auto size-6 animate-spin text-dimmed" />
          <p class="mt-2 text-sm font-medium text-default">Reading the disc…</p>
          <p class="mt-1 text-xs text-muted">
            {{ store.notice || 'Waiting for the table of contents.' }}
          </p>
        </template>
        <template v-else-if="store.detection === 'no-drive'">
          <UIcon name="i-tabler-device-usb" class="mx-auto size-6 text-dimmed" />
          <p class="mt-2 text-sm font-medium text-default">No optical drive</p>
          <p class="mt-1 text-xs text-muted">
            {{
              store.notice ||
              'Connect a CD drive and press Refresh. Oscine only looks while this pane is open.'
            }}
          </p>
        </template>
        <template v-else-if="store.detection === 'no-disc'">
          <UIcon name="i-tabler-disc" class="mx-auto size-6 text-dimmed" />
          <p class="mt-2 text-sm font-medium text-default">No disc in the drive</p>
          <p class="mt-1 text-xs text-muted">
            Insert an audio CD and press Refresh, or wait a moment.
          </p>
        </template>
        <template v-else>
          <UIcon name="i-tabler-file" class="mx-auto size-6 text-dimmed" />
          <p class="mt-2 text-sm font-medium text-default">This disc has no audio tracks</p>
          <p class="mt-1 text-xs text-muted">
            Data-only discs cannot be ripped here. Insert an audio CD.
          </p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
@container (min-width: 28rem) {
  .rip-details {
    grid-template-columns: 10rem minmax(0, 1fr);
  }

  .rip-output {
    grid-column: 1 / -1;
  }
}

@container (min-width: 44rem) {
  .rip-details {
    grid-template-columns: 10rem minmax(0, 1fr) minmax(0, 1.25fr);
  }

  .rip-output {
    grid-column: auto;
  }
}
</style>
