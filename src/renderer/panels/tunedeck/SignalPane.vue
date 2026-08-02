<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TrackFormatDetail } from '@shared/library'
import { resolveNormalization } from '@renderer/audio/normalization'
import { library } from '@renderer/ipc'
import {
  buildFormatRows,
  buildReplayGainRows,
  describeDecodePath,
  describeLoudness
} from '@renderer/panels/tunedeck/signalReadout'
import { useDisplayFormatStore } from '@renderer/stores/displayFormat'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * What is actually playing, at the signal level.
 *
 * Fermata's pitch is format-first and until this pane there was nowhere in the
 * app that said so. Three blocks, in descending order of how often they are
 * looked at: what the file is, what is being done to its loudness, and how it
 * reached the speakers.
 *
 * The third block is the one that justifies the card. R1's admission guard
 * routes a track too large to decode to an `<audio>` element, and the only
 * symptom above the audio layer is that a boundary which should have been
 * gapless is a hard cut. That verdict used to exist solely as a `console.info`
 * line. It is now a sentence with the numbers behind it, and this is the one
 * place in the app an operator can find out why a transition was hard.
 *
 * ## Where the data comes from
 *
 * Three sources, none of them new state:
 *
 * - `playback.nowPlaying` — the indexed `Track`, already in hand.
 * - `playback.admission` — R1's own decision object, mirrored out of the engine
 *   by the controller. Read, never acted on: a pane that changed behaviour on
 *   `path` would be a pane that knows which engine won.
 * - `library.getTrackFormatDetail` — container, bitrate and codec profile,
 *   re-parsed from the file on demand. Not columns, and deliberately not: see
 *   `TrackFormatDetail`.
 *
 * The loudness block calls `resolveNormalization` with the same policy the
 * scheduler was handed, so the pane and the audible gain cannot disagree.
 */

const playback = usePlaybackStore()
const display = useDisplayFormatStore()

/**
 * Sizes and durations as the operator writes them everywhere else.
 *
 * A plain object of the store's own functions rather than the store: they read
 * `settings.get` on each call, so the reactivity survives being passed by
 * reference and a change to `view.fileSizeFormat` reflows this pane along with
 * the track list. See `createDisplayFormats`.
 */
const formats = {
  duration: (seconds: number | null) => display.duration(seconds),
  size: (bytes: number | null) => display.fileSize(bytes)
}

/**
 * The on-demand format parse, keyed by the track it belongs to.
 *
 * The id is stored beside the result rather than trusted implicitly, because
 * these arrive out of order: skipping through five tracks starts five parses
 * and nothing guarantees the fifth answers last. A late reply for a track that
 * is no longer playing is dropped rather than rendered.
 */
const detail = ref<TrackFormatDetail | null>(null)
const detailTrackId = ref<number | null>(null)
const detailFailed = ref(false)

watch(
  () => playback.nowPlaying?.id ?? null,
  async (trackId) => {
    detail.value = null
    detailFailed.value = false
    detailTrackId.value = trackId
    if (trackId === null) return
    // Negative ids are downloaded podcast episodes, which are not library rows
    // — see `episodePlaybackTrackId`. The format block is a library lookup, so
    // it is simply not asked for; every other block still renders.
    if (trackId < 0) return

    try {
      const result = await library.getTrackFormatDetail(trackId)
      if (detailTrackId.value !== trackId) return
      detail.value = result
    } catch {
      if (detailTrackId.value !== trackId) return
      // The file moved, or is unreadable. The index still knows codec, rate,
      // depth and channels, so the block degrades rather than emptying — the
      // note below is what tells the operator the rest is missing on purpose.
      detailFailed.value = true
    }
  },
  { immediate: true }
)

const formatRows = computed(() => {
  const track = playback.nowPlaying
  return track === null ? [] : buildFormatRows(track, detail.value, formats)
})

const normalization = computed(() => {
  const track = playback.nowPlaying
  return track === null ? null : resolveNormalization(track, playback.normalizationPolicy)
})

const loudness = computed(() =>
  normalization.value === null ? null : describeLoudness(normalization.value)
)

const replayGainRows = computed(() => {
  const track = playback.nowPlaying
  if (track === null || loudness.value === null) return []
  return buildReplayGainRows(track, loudness.value.applied)
})

const decodePath = computed(() =>
  playback.admission === null ? null : describeDecodePath(playback.admission, formats)
)
</script>

<template>
  <div class="flex flex-col gap-3">
    <template v-if="playback.nowPlaying === null">
      <p class="px-1 py-4 text-center text-xs text-muted">
        Nothing playing. The readout follows the transport.
      </p>
    </template>

    <template v-else>
      <!--
        Definition rows rather than a table: three blocks of two columns that
        never need to align with each other, and a `dl` says what they are to a
        screen reader without borrowing a grid's semantics.
      -->
      <dl v-if="formatRows.length > 0" class="m-0 flex flex-col gap-1">
        <div v-for="row in formatRows" :key="row.key" class="flex items-baseline gap-2">
          <dt class="shrink-0 text-xs text-dimmed">{{ row.label }}</dt>
          <dd
            class="m-0 ml-auto flex min-w-0 items-baseline gap-1.5 text-right text-xs tabular-nums text-default"
          >
            <span class="truncate">{{ row.value }}</span>
            <span v-if="row.note" class="shrink-0 text-dimmed">{{ row.note }}</span>
          </dd>
        </div>
      </dl>

      <p v-if="detailFailed" class="flex items-center gap-1.5 text-xs text-muted">
        <UIcon name="i-tabler-file-unknown" class="size-3.5 shrink-0" />
        <span>The file could not be re-read, so container and bitrate are missing.</span>
      </p>

      <!--
        Loudness. The summary is the answer to "which mode is actually being
        applied right now", which is not the same question as "which mode is
        selected" — album mode on a track with only a track gain falls back, and
        that is exactly what someone opens this pane to find out.
      -->
      <section v-if="loudness !== null" class="flex flex-col gap-1 border-t border-default pt-3">
        <h4 class="flex items-center gap-1.5 text-xs font-medium uppercase text-dimmed">
          <UIcon name="i-tabler-adjustments-alt" class="size-3.5 shrink-0" />
          <span>ReplayGain</span>
        </h4>
        <p class="text-xs text-muted">{{ loudness.summary }}</p>
        <p v-if="loudness.peakLimited" class="flex items-center gap-1.5 text-xs text-warning">
          <UIcon name="i-tabler-alert-triangle" class="size-3.5 shrink-0" />
          <span>Pulled back to keep the peak under unity.</span>
        </p>
        <dl v-if="replayGainRows.length > 0" class="m-0 mt-1 flex flex-col gap-1">
          <div v-for="row in replayGainRows" :key="row.key" class="flex items-baseline gap-2">
            <dt class="shrink-0 text-xs text-dimmed">{{ row.label }}</dt>
            <dd
              class="m-0 ml-auto flex min-w-0 items-baseline gap-1.5 text-right text-xs tabular-nums text-default"
            >
              <span class="truncate">{{ row.value }}</span>
              <UBadge
                v-if="row.note === 'applied'"
                label="applied"
                size="sm"
                color="primary"
                variant="subtle"
                class="shrink-0"
              />
              <span v-else-if="row.note" class="shrink-0 text-dimmed">{{ row.note }}</span>
            </dd>
          </div>
        </dl>
      </section>

      <!--
        The decode path. Visibly distinct from the blocks above — an icon, a
        colour and a headline word — because W7-3's acceptance is that the
        streaming state can be *found*, and a state that reads like one more
        row of metadata has not been found.
      -->
      <section
        v-if="decodePath !== null"
        class="flex flex-col gap-1.5 border-t border-default pt-3"
      >
        <h4 class="flex items-center gap-1.5 text-xs font-medium uppercase text-dimmed">
          <UIcon name="i-tabler-cpu" class="size-3.5 shrink-0" />
          <span>Decode path</span>
        </h4>

        <div
          class="flex items-center gap-2 rounded-sm px-2 py-1.5"
          :class="decodePath.streaming ? 'bg-warning/10' : 'bg-elevated'"
        >
          <UIcon
            :name="decodePath.streaming ? 'i-tabler-antenna-bars-5' : 'i-tabler-database'"
            class="size-4 shrink-0"
            :class="decodePath.streaming ? 'text-warning' : 'text-primary'"
          />
          <span
            class="text-sm font-medium"
            :class="decodePath.streaming ? 'text-warning' : 'text-highlighted'"
          >
            {{ decodePath.label }}
          </span>
        </div>

        <p class="text-xs text-muted">{{ decodePath.explanation }}</p>
        <p v-if="decodePath.consequence !== null" class="text-xs text-dimmed">
          {{ decodePath.consequence }}
        </p>

        <!--
          The estimate against the cap, as a bar. A ratio of two byte counts is
          the one fact here that is read faster as a length than as a number,
          and it is the fact that decides the path. Hidden entirely when the
          track could not be priced: an empty meter would say "free".
        -->
        <div
          v-if="decodePath.capFraction !== null"
          class="h-1 w-full overflow-hidden rounded-full bg-accented"
          role="presentation"
        >
          <div
            class="h-full rounded-full transition-[width]"
            :class="decodePath.streaming ? 'bg-warning' : 'bg-primary'"
            :style="{ width: `${Math.round(decodePath.capFraction * 100)}%` }"
          />
        </div>

        <dl class="m-0 flex flex-col gap-1">
          <div v-for="row in decodePath.rows" :key="row.key" class="flex items-baseline gap-2">
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
    </template>
  </div>
</template>
