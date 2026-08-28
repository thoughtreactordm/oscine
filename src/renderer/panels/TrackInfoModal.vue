<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Track, TrackFormatDetail } from '@shared/library'
import { hasArtwork } from '@shared/ipc'
import { library } from '@renderer/ipc'
import {
  buildFormatRows,
  buildReplayGainRows,
  type SignalRow
} from '@renderer/panels/tunedeck/signalReadout'
import { useSignalFormats } from '@renderer/panels/tunedeck/signalFormats'
import { useTrackInfoStore } from '@renderer/stores/trackInfo'

/**
 * What a track *is*, read-only (**G8**).
 *
 * D7 says v1 never writes tags, so this shows and does not edit: a correction
 * would live in `track_overrides`, which is a different card. It reuses the
 * Tunedeck signal readout wholesale — `buildFormatRows` and `buildReplayGainRows`
 * are already the tested answer to "what does this file say", and the deck pane
 * and this dialog agreeing about a bitrate is worth more than a second phrasing
 * of it. The only thing new here is the identity block, which the deck has no
 * room for and a details dialog is exactly the place for.
 *
 * The cover sits in its own left-hand sleeve, large enough to look at, with
 * the transport's blurred bleed on the upper left when art is present — the
 * same treatment the metadata editor wears, so the two dialogs read as a pair.
 * The chrome header is overlaid and unpainted so that wash can sit behind the
 * close control rather than stopping at a solid band.
 *
 * Mounted once by the frame; opened by the shared track menu on any surface. See
 * `stores/trackInfo` for why it is state and not a component the list owns.
 */
const store = useTrackInfoStore()
const formats = useSignalFormats()

const open = computed(() => store.track !== null)

/**
 * The on-demand format parse, keyed by the track it belongs to.
 *
 * Container, bitrate and codec profile are re-read from the file rather than
 * stored (see `TrackFormatDetail`). Keyed by id and dropped when a late reply is
 * for a track the dialog has since moved off, the same guard `FormatPane` keeps.
 */
const detail = ref<TrackFormatDetail | null>(null)
const detailTrackId = ref<number | null>(null)

watch(
  () => store.track?.id ?? null,
  async (trackId) => {
    detail.value = null
    detailTrackId.value = trackId
    // Negative ids are downloaded podcast episodes, not library rows — the parse
    // is a library lookup, so it is simply not asked for. Podcasts are out of
    // G8's pass anyway; this only guards the shared modal against one.
    if (trackId === null || trackId < 0) return
    try {
      const result = await library.getTrackFormatDetail(trackId)
      if (detailTrackId.value === trackId) detail.value = result
    } catch {
      // The file moved or is unreadable. The index still holds codec, rate, depth
      // and channels, so the format block degrades rather than emptying.
    }
  }
)

function timestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

/**
 * The identity block — the tags a person reads, not the ones the decoder does.
 *
 * A fact we do not have is not a row, the same rule the format readout keeps,
 * with two standing exceptions: Title is always shown because a track always has
 * one, and Album artist only when it differs from the track artist, where the
 * distinction is the thing worth showing and repeating it is noise.
 */
function identityRows(track: Track): SignalRow[] {
  const rows: SignalRow[] = [{ key: 'title', label: 'Title', value: track.title }]
  if (track.artist !== null) rows.push({ key: 'artist', label: 'Artist', value: track.artist })
  if (track.album !== null) rows.push({ key: 'album', label: 'Album', value: track.album })
  if (track.albumArtist !== null && track.albumArtist !== track.artist) {
    rows.push({ key: 'albumArtist', label: 'Album artist', value: track.albumArtist })
  }
  if (track.trackNo !== null) {
    rows.push({ key: 'trackNo', label: 'Track', value: String(track.trackNo) })
  }
  if (track.discNo !== null) {
    rows.push({ key: 'discNo', label: 'Disc', value: String(track.discNo) })
  }
  if (track.year !== null) rows.push({ key: 'year', label: 'Year', value: String(track.year) })
  rows.push({
    key: 'playCount',
    label: 'Plays',
    value: track.playCount.toLocaleString()
  })
  if (track.lastPlayedAt !== null) {
    rows.push({ key: 'lastPlayed', label: 'Last played', value: timestamp(track.lastPlayedAt) })
  }
  return rows
}

interface InfoSection {
  key: string
  title: string
  rows: readonly SignalRow[]
}

/** The sections, in order, omitting any that has nothing to say. */
const sections = computed<InfoSection[]>(() => {
  const track = store.track
  if (track === null) return []
  const groups: InfoSection[] = [
    { key: 'details', title: 'Details', rows: identityRows(track) },
    { key: 'format', title: 'Format', rows: buildFormatRows(track, detail.value, formats) },
    // No applied field: a track looked at in a dialog is not necessarily the one
    // playing, so no gain is "in force" and no row is marked applied.
    { key: 'replayGain', title: 'ReplayGain', rows: buildReplayGainRows(track, null) }
  ]
  return groups.filter((group) => group.rows.length > 0)
})

const artwork = computed(() => {
  const url = store.track?.artwork.large
  return url && hasArtwork(url) ? url : null
})

const subtitle = computed(() => {
  const track = store.track
  if (track === null) return ''
  return [track.artist, track.album].filter((part) => part !== null).join(' · ')
})
</script>

<template>
  <UModal
    :open="open"
    title="Track info"
    :description="store.track?.title ?? ''"
    :ui="{
      description: 'sr-only',
      title: 'sr-only',
      content: 'sm:max-w-3xl overflow-hidden divide-y-0',
      header: 'absolute inset-x-0 top-0 z-10 bg-transparent pointer-events-none',
      close: 'pointer-events-auto',
      body: 'sm:p-0'
    }"
    @update:open="(value: boolean) => !value && store.close()"
  >
    <template #body>
      <div v-if="store.track !== null" class="relative isolate overflow-hidden">
        <!--
          The transport's cover bleed, cropped to the upper left so the readout
          does not have to fight it. Token blur and bleed, no drift: a details
          dialog is something you read, not something that should be moving.
        -->
        <div v-if="artwork !== null" class="cover-bleed" aria-hidden="true">
          <div class="cover-bleed-art" :style="{ backgroundImage: `url('${artwork}')` }" />
        </div>

        <div class="flex min-h-0">
          <aside class="flex w-64 shrink-0 flex-col p-4">
            <div
              class="aspect-square w-full overflow-hidden rounded-md border border-default bg-elevated/60"
            >
              <img
                v-if="artwork !== null"
                :src="artwork"
                alt=""
                aria-hidden="true"
                class="size-full object-cover"
                draggable="false"
              />
              <div v-else class="flex size-full items-center justify-center">
                <UIcon name="i-tabler-vinyl" class="size-12 text-dimmed/40" aria-hidden="true" />
              </div>
            </div>
          </aside>

          <div class="flex min-w-0 flex-1 flex-col gap-4 p-4 pl-2 pr-12">
            <header class="min-w-0">
              <h2 class="truncate text-base font-semibold text-highlighted">
                {{ store.track.title }}
              </h2>
              <p v-if="subtitle" class="truncate text-sm text-muted">{{ subtitle }}</p>
            </header>

            <section v-for="group in sections" :key="group.key" class="flex flex-col gap-1.5">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">
                {{ group.title }}
              </h3>
              <dl class="m-0 flex flex-col gap-1">
                <div v-for="row in group.rows" :key="row.key" class="flex items-baseline gap-2">
                  <dt class="shrink-0 text-xs text-dimmed">{{ row.label }}</dt>
                  <dd
                    class="m-0 ml-auto flex min-w-0 items-baseline gap-1.5 text-right text-xs tabular-nums text-default"
                  >
                    <span class="truncate">{{ row.value }}</span>
                    <span v-if="row.note" class="shrink-0 text-dimmed">{{ row.note }}</span>
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
/*
 * Same treatment as the transport bar (`NowPlaying.vue`) and the metadata
 * editor: the theme's blur and bleed, overscaled so the blur does not show a
 * hard edge. Masked to the upper left so it is atmosphere around the sleeve,
 * not a wash over the readout.
 */
.cover-bleed {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: calc(var(--oscine-cover-bleed) * 0.65);
  mask-image: radial-gradient(77% 70% at 0% 0%, black 0%, black 22%, transparent 52%);
}

.cover-bleed-art {
  position: absolute;
  top: -21%;
  left: -20%;
  width: 63%;
  height: 77%;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  filter: blur(var(--oscine-cover-blur)) saturate(3.6);
  transform: scale(1.45);
}
</style>
