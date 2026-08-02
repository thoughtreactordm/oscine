<script setup lang="ts">
import { computed } from 'vue'
import { resolveNormalization } from '@renderer/audio/normalization'
import { buildReplayGainRows, describeLoudness } from '@renderer/panels/tunedeck/signalReadout'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * What is being done to this track's loudness (W7-3).
 *
 * `resolveNormalization` is called with the same policy the scheduler was
 * handed, so this group and the audible gain cannot disagree.
 *
 * The summary line stays inline rather than becoming a tooltip. It is the
 * answer to "which mode is actually being applied right now", which is not the
 * same question as "which mode is selected" — album mode on a track with only a
 * track gain falls back — and it is per-track, changing under you as the
 * transport moves. Derived text is the readout; standing text was the noise.
 */

const playback = usePlaybackStore()

const normalization = computed(() => {
  const track = playback.nowPlaying
  return track === null ? null : resolveNormalization(track, playback.normalizationPolicy)
})

const loudness = computed(() =>
  normalization.value === null ? null : describeLoudness(normalization.value)
)

const rows = computed(() => {
  const track = playback.nowPlaying
  if (track === null || loudness.value === null) return []
  return buildReplayGainRows(track, loudness.value.applied)
})
</script>

<template>
  <div class="flex flex-col gap-1">
    <p v-if="loudness === null" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. The readout follows the transport.
    </p>

    <template v-else>
      <p class="text-xs text-muted">{{ loudness.summary }}</p>

      <p v-if="loudness.peakLimited" class="flex items-center gap-1.5 text-xs text-warning">
        <UIcon name="i-tabler-alert-triangle" class="size-3.5 shrink-0" />
        <span>Pulled back to keep the peak under unity.</span>
      </p>

      <dl v-if="rows.length > 0" class="m-0 mt-1 flex flex-col gap-1">
        <div v-for="row in rows" :key="row.key" class="flex items-baseline gap-2">
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
    </template>
  </div>
</template>
