<script setup lang="ts">
import { computed } from 'vue'
import { describeDecodePath } from '@renderer/panels/tunedeck/signalReadout'
import { useSignalFormats } from '@renderer/panels/tunedeck/signalFormats'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * How this track reached the speakers (W7-3).
 *
 * The group that justifies the card. R1's admission guard routes a track too
 * large to decode to an `<audio>` element, and the only symptom above the audio
 * layer is that a boundary which should have been gapless is a hard cut. That
 * verdict used to exist solely as a `console.info` line. It is a sentence with
 * the numbers behind it, and this is the one place in the app an operator can
 * find out why a transition was hard.
 *
 * `playback.admission` is R1's own decision object, mirrored out of the engine
 * by the controller. Read, never acted on: a pane that changed behaviour on
 * `path` would be a pane that knows which engine won.
 *
 * The explanation and consequence lines stay inline. They are computed per
 * track from the numbers below them — the whole point of the group — and a
 * tooltip is the wrong home for the thing you opened the group to read.
 */

const playback = usePlaybackStore()
const formats = useSignalFormats()

const decodePath = computed(() =>
  playback.admission === null ? null : describeDecodePath(playback.admission, formats)
)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <p v-if="decodePath === null" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. The readout follows the transport.
    </p>

    <template v-else>
      <!--
        An icon, a colour and a headline word, because W7-3's acceptance is that
        the streaming state can be *found*, and a state that reads like one more
        row of metadata has not been found.
      -->
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
        the one fact here that is read faster as a length than as a number, and
        it is the fact that decides the path. Hidden entirely when the track
        could not be priced: an empty meter would say "free".
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
    </template>
  </div>
</template>
