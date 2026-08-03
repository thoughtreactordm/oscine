<script setup lang="ts">
import { computed } from 'vue'
import type { StatsScopeBy } from '@shared/stats'
import { listeningRows, listeningState } from '@renderer/panels/tunedeck/listeningStats'
import { useDisplayFormatStore } from '@renderer/stores/displayFormat'
import { useTrackStatsStore } from '@renderer/stores/trackStats'

/**
 * Play counts and listening time for what is playing — **D17**, W10-11.
 *
 * The stats engine's numbers where they belong to the music rather than to a
 * report: the same `stats.summary` the dashboard asks the whole log, asked of
 * the group the playing track falls into. One component, mounted twice with
 * different scopes — see `panes.ts` for which tab gets which and why.
 *
 * Local, and the only deck pane besides Favorite Songs that is. Nothing here
 * waits on a lookup, so it draws with the cable pulled exactly as it does
 * plugged in — **D14**'s third rule, kept because there is nothing to wait for.
 *
 * ## Not virtualized, and it is not an exception
 *
 * The standing invariant is about *lists* — rows drawn from a collection whose
 * length is a property of the library. This draws one row per scope, and the
 * scopes are a fixed tuple in the contract. There is no length here to grow.
 */

const props = defineProps<{ scopes: readonly StatsScopeBy[] }>()

const stats = useTrackStatsStore()
const display = useDisplayFormatStore()

const state = computed(() =>
  listeningState({
    seedId: stats.seedId,
    loading: stats.loading,
    failed: stats.failed,
    answered: stats.answered
  })
)

const rows = computed(() => listeningRows(props.scopes, stats.result ?? {}))

/**
 * One line for both dates, and an en dash between them rather than two labelled
 * fields. `First … Last …` spends two words saying what the order already says,
 * in a column where a long artist name is already competing for the width.
 *
 * A single listen collapses to one date instead of repeating it either side of
 * the dash — the day is the fact, and `12 Mar 2024 – 12 Mar 2024` states it
 * twice while implying a stretch of time that did not happen.
 */
function span(row: { span: { first: number; last: number } | null }): string {
  if (row.span === null) return ''
  const first = display.date(row.span.first)
  const last = display.date(row.span.last)
  return first === last ? first : `${first} – ${last}`
}
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <template v-if="state === 'rows'">
      <div v-for="row in rows" :key="row.scope" class="flex flex-col gap-0.5 px-1">
        <span class="text-xs text-muted">{{ row.label }}</span>

        <!--
          The number, and the only line in the group set at reading weight. It
          is what someone opened this for; the label above names it and the
          dates below qualify it.
        -->
        <span v-if="row.total !== null" class="text-sm tabular-nums text-default">
          {{ row.total }}
        </span>
        <span v-else class="text-sm text-dimmed">{{ row.absent }}</span>

        <span v-if="span(row) !== ''" class="text-xs tabular-nums text-dimmed">
          {{ span(row) }}
        </span>
      </div>
    </template>

    <!--
      Three states and no fourth. There is deliberately no empty state: a zero
      is a real answer and draws as one, which is what keeps a freshly scanned
      track from making this group vanish out from under the operator.
    -->
    <p v-else-if="state === 'standby'" class="px-1 py-4 text-center text-xs text-muted">
      Nothing playing. This follows the current track.
    </p>

    <div v-else-if="state === 'failed'" class="flex flex-col items-center gap-2 px-1 py-4">
      <p class="text-center text-xs text-muted">Could not read the listening log.</p>
      <UButton
        label="Try again"
        size="xs"
        color="neutral"
        variant="subtle"
        @click="stats.refresh()"
      />
    </div>

    <p v-else class="px-1 py-4 text-center text-xs text-dimmed">Counting…</p>
  </div>
</template>
