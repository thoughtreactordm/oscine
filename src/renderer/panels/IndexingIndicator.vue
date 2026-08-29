<script setup lang="ts">
import { computed } from 'vue'
import { indexingChipDetail, indexingChipLabel } from '@renderer/shell/scanProgress'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'

/**
 * Always-on indexing cue in the title bar.
 *
 * `roots.scan` is the same ref the wizard's scan step and the Library sidebar
 * read. It is `null` when nothing is in flight, including after a scan
 * finishes, so this mounts nothing the rest of the time. The chip is the
 * answer to dismissing the first-run modal mid-scan: the operator still
 * sees that the library is filling in.
 */
const roots = useLibraryRootsStore()

const scan = computed(() => roots.scan)
const label = computed(() => (scan.value ? indexingChipLabel(scan.value) : ''))
const detail = computed(() => (scan.value ? indexingChipDetail(scan.value) : ''))
</script>

<template>
  <div
    v-if="scan"
    class="app-no-drag flex h-full max-w-56 shrink-0 items-center px-2"
    role="status"
    aria-live="polite"
    :aria-label="detail"
  >
    <UTooltip :text="detail">
      <span class="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
        <UIcon name="i-tabler-refresh" class="size-3.5 shrink-0 motion-safe:animate-spin" />
        <span class="truncate tabular-nums">{{ label }}</span>
      </span>
    </UTooltip>
  </div>
</template>
