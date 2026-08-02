<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TrackFormatDetail } from '@shared/library'
import { library } from '@renderer/ipc'
import { buildFormatRows } from '@renderer/panels/tunedeck/signalReadout'
import { useSignalFormats } from '@renderer/panels/tunedeck/signalFormats'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * What the file is (W7-3).
 *
 * Fermata's pitch is format-first and until this readout there was nowhere in
 * the app that said so. It was the first of `SignalPane`'s three blocks; it is
 * now the first of the Track tab's three groups, and the split is what lets the
 * other two collapse out of the way when what you came for is the bit depth.
 *
 * ## Where the data comes from
 *
 * Two sources, neither of them new state: `playback.nowPlaying` for the indexed
 * columns, and `library.getTrackFormatDetail` for container, bitrate and codec
 * profile — re-parsed from the file on demand rather than stored. See
 * `TrackFormatDetail` for why those three are not columns.
 */

const playback = usePlaybackStore()
const formats = useSignalFormats()

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
    // — see `episodePlaybackTrackId`. The format parse is a library lookup, so
    // it is simply not asked for; the indexed columns still render.
    if (trackId < 0) return

    try {
      const result = await library.getTrackFormatDetail(trackId)
      if (detailTrackId.value !== trackId) return
      detail.value = result
    } catch {
      if (detailTrackId.value !== trackId) return
      // The file moved, or is unreadable. The index still knows codec, rate,
      // depth and channels, so the group degrades rather than emptying — the
      // note below is what tells the operator the rest is missing on purpose.
      detailFailed.value = true
    }
  },
  { immediate: true }
)

const rows = computed(() => {
  const track = playback.nowPlaying
  return track === null ? [] : buildFormatRows(track, detail.value, formats)
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <p v-if="playback.nowPlaying === null" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. The readout follows the transport.
    </p>

    <template v-else>
      <!--
        Definition rows rather than a table: two columns that need to align with
        nothing else, and a `dl` says what they are to a screen reader without
        borrowing a grid's semantics.
      -->
      <dl v-if="rows.length > 0" class="m-0 flex flex-col gap-1">
        <div v-for="row in rows" :key="row.key" class="flex items-baseline gap-2">
          <dt class="shrink-0 text-xs text-dimmed">{{ row.label }}</dt>
          <dd
            class="m-0 ml-auto flex min-w-0 items-baseline gap-1.5 text-right text-xs tabular-nums text-default"
          >
            <span class="truncate">{{ row.value }}</span>
            <span v-if="row.note" class="shrink-0 text-dimmed">{{ row.note }}</span>
          </dd>
        </div>
      </dl>

      <!--
        Stays as text rather than moving to a tooltip: it is not an explanation
        of a feature but a report that this particular file could not be read,
        and a fact about the track in front of you should not need hovering.
      -->
      <p v-if="detailFailed" class="flex items-center gap-1.5 text-xs text-muted">
        <UIcon name="i-tabler-file-unknown" class="size-3.5 shrink-0" />
        <span>The file could not be re-read, so container and bitrate are missing.</span>
      </p>
    </template>
  </div>
</template>
