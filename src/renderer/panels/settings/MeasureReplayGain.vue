<script setup lang="ts">
import { computed } from 'vue'
import { formatCount, measureView } from '@renderer/replaygain/measureModel'
import { useReplayGainStore } from '@renderer/stores/replayGain'
import { useSettingsNavStore } from '@renderer/stores/settingsNav'
import { AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING } from '@shared/settings'

/**
 * "Measure ReplayGain" — W25-1, D37 Decision A's explicit start.
 *
 * Above the Audio rows rather than between them, beside the equalizer pointer.
 * The rows are a uniform-height virtualized list, and this block grows a
 * progress bar and a status line; placing it mid-list would mean giving up the
 * fixed row height the list is built on. It is not a setting either — it has
 * no stored value — which is the same reason the Library section's actions are
 * not rows.
 *
 * Everything it says comes from `measureView`; this component only lays it out
 * and forwards clicks. Errors surface inline, not as a toast, because the
 * operator is looking at this block when they happen.
 */
const replayGain = useReplayGainStore()
const nav = useSettingsNavStore()

const view = computed(() =>
  measureView({
    summary: replayGain.summary,
    job: replayGain.job,
    computeAllowed: replayGain.computeAllowed,
    busy: replayGain.busy
  })
)

const percent = computed(() => Math.round((view.value.progress?.fraction ?? 0) * 100))

function primary(): void {
  const button = view.value.primary
  if (!button) return
  const request = button.action === 'resume' ? replayGain.resumeJob() : replayGain.startJob()
  // The store keeps the message in `error`, which is drawn below.
  request.catch(() => {})
}

function cancel(): void {
  replayGain.cancelJob().catch(() => {})
}

function showGate(): void {
  nav.reveal(AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING.key)
}
</script>

<template>
  <section
    class="flex flex-col gap-2 border-b border-default/60 px-4 py-3"
    aria-label="Measure ReplayGain"
  >
    <div class="flex items-center gap-3">
      <UIcon
        name="i-tabler-wave-sine"
        class="size-4 shrink-0"
        :class="replayGain.active ? 'text-primary' : 'text-dimmed'"
      />

      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-medium text-highlighted">Measure ReplayGain</span>
        <span v-if="view.counts" class="truncate text-[11px] text-muted">
          {{ formatCount(view.counts.tagged) }} tagged ·
          {{ formatCount(view.counts.computed) }} measured ·
          {{ formatCount(view.counts.missing) }} missing
        </span>
        <USkeleton v-else class="mt-1 h-3 w-48" />
      </div>

      <UButton
        v-if="view.cancel"
        size="xs"
        color="neutral"
        variant="subtle"
        icon="i-tabler-player-stop"
        :label="view.cancel.label"
        :disabled="view.cancel.disabled"
        class="shrink-0"
        @click="cancel"
      />
      <UButton
        v-else-if="view.primary"
        size="xs"
        color="primary"
        variant="soft"
        :icon="
          view.primary.action === 'resume' ? 'i-tabler-player-skip-forward' : 'i-tabler-player-play'
        "
        :label="view.primary.label"
        :disabled="view.primary.disabled"
        :loading="replayGain.busy"
        class="shrink-0"
        @click="primary"
      />
    </div>

    <div v-if="view.progress" class="flex flex-col gap-1 pl-7">
      <UProgress :model-value="percent" size="xs" class="max-w-md" />
      <span class="truncate text-[11px] text-muted">
        {{ view.progress.label }}
        <template v-if="view.progress.currentTitle"> — {{ view.progress.currentTitle }}</template>
      </span>
    </div>

    <p v-if="view.status" class="pl-7 text-[11px] text-dimmed">{{ view.status }}</p>

    <p v-if="view.reason" class="flex flex-wrap items-center gap-x-2 pl-7 text-[11px] text-dimmed">
      <span>{{ view.reason }}</span>
      <UButton
        v-if="!replayGain.computeAllowed"
        size="xs"
        color="neutral"
        variant="link"
        label="Show setting"
        class="p-0 text-[11px]"
        @click="showGate"
      />
    </p>

    <p v-if="replayGain.error" class="pl-7 text-[11px] text-error">{{ replayGain.error }}</p>

    <p class="pl-7 text-[11px] text-dimmed">
      Decodes untagged tracks in the background to measure their loudness. Results are used for
      playback only; nothing is written to your files.
    </p>
  </section>
</template>
