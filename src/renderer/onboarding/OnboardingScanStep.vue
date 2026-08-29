<script setup lang="ts">
import { computed } from 'vue'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { describeScanStep, libraryTrackCount } from './scanStep'

/**
 * The last wizard step: a view of the scan already running.
 *
 * `library.scanRoot` was called from the root step. This component does not
 * start a second one. Finish in the modal footer is skippable on purpose, so
 * the operator can leave while these numbers are still moving; the title-bar
 * chip keeps the same store visible after the modal closes.
 */
const roots = useLibraryRootsStore()

const view = computed(() => describeScanStep(roots.scan, libraryTrackCount(roots.roots)))
</script>

<template>
  <div class="flex flex-col gap-3" role="status" aria-live="polite">
    <div class="flex items-start gap-3">
      <UIcon
        :name="view.active ? 'i-tabler-refresh' : 'i-tabler-circle-check'"
        class="mt-0.5 size-5 shrink-0 text-primary"
        :class="{ 'motion-safe:animate-spin': view.active }"
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-highlighted">{{ view.headline }}</p>
        <p v-if="view.counts" class="mt-1 text-xs tabular-nums text-muted">{{ view.counts }}</p>
        <p v-if="view.file" class="mt-1 truncate text-xs text-dimmed" :title="view.file">
          {{ view.file }}
        </p>
      </div>
    </div>

    <UProgress v-if="view.active" animation="carousel" size="2xs" />
  </div>
</template>
