<script setup lang="ts">
import { computed } from 'vue'
import { isSortableColumn, type TrackColumnSpec } from '@renderer/panels/columnLayout'
import { useTrackColumnsStore } from '@renderer/stores/columns'
import { useTrackListStore } from '@renderer/stores/trackList'

/**
 * Column visibility, order and sort, from the keyboard.
 *
 * The header handles pointer reordering by drag; this is the other half, and the
 * only half that works without a mouse. It is also where the sort lives when its
 * column is hidden: a header that is not rendered cannot be clicked, and W4-4
 * requires that hiding the sorted column not strand the ordering somewhere the
 * user cannot reach. Every sortable column is listed here whether or not it is
 * visible, so the sort is always changeable and always legible.
 */
const columns = useTrackColumnsStore()
const panel = useTrackListStore()

const visibleCount = computed(() => columns.visibleColumns.length)

function columnName(column: TrackColumnSpec): string {
  return column.title ?? column.label
}

/** Position among the visible columns, which is what the move buttons step through. */
function visiblePosition(column: TrackColumnSpec): number {
  return columns.visibleColumns.findIndex((entry) => entry.key === column.key)
}
</script>

<template>
  <UPopover :ui="{ content: 'w-80' }">
    <UButton
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-lucide-columns-3"
      aria-label="Choose columns"
      title="Choose columns"
    />

    <template #content>
      <div class="flex flex-col">
        <div class="flex items-center gap-2 border-b border-default px-3 py-2">
          <h3 class="text-sm font-semibold text-highlighted">Columns</h3>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            class="ms-auto"
            @click="columns.reset()"
          >
            Reset to defaults
          </UButton>
        </div>

        <ul class="max-h-96 overflow-y-auto py-1" aria-label="Track list columns">
          <li
            v-for="column in columns.orderedColumns"
            :key="column.key"
            class="flex items-center gap-1 px-2 py-0.5"
          >
            <UCheckbox
              :model-value="columns.isVisible(column.key)"
              :label="columnName(column)"
              :disabled="columns.isVisible(column.key) && visibleCount <= 1"
              class="min-w-0 flex-1"
              :ui="{ label: 'truncate' }"
              @update:model-value="columns.toggleVisible(column.key)"
            />

            <UButton
              v-if="isSortableColumn(column.key)"
              color="neutral"
              :variant="panel.sort === column.key ? 'soft' : 'ghost'"
              size="xs"
              :icon="
                panel.sort === column.key && panel.direction === 'desc'
                  ? 'i-lucide-arrow-down-narrow-wide'
                  : 'i-lucide-arrow-up-narrow-wide'
              "
              :aria-label="`Sort by ${columnName(column)}`"
              :title="`Sort by ${columnName(column)}`"
              @click="panel.setSort(column.key)"
            />
            <!-- Keeps the move buttons in one column for rows with no sort. -->
            <span v-else class="size-6 shrink-0" aria-hidden="true" />

            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-chevron-up"
              :disabled="!columns.isVisible(column.key) || visiblePosition(column) <= 0"
              :aria-label="`Move ${columnName(column)} left`"
              :title="`Move ${columnName(column)} left`"
              @click="columns.move(column.key, -1)"
            />
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-chevron-down"
              :disabled="
                !columns.isVisible(column.key) || visiblePosition(column) >= visibleCount - 1
              "
              :aria-label="`Move ${columnName(column)} right`"
              :title="`Move ${columnName(column)} right`"
              @click="columns.move(column.key, 1)"
            />
          </li>
        </ul>

        <p class="border-t border-default px-3 py-2 text-xs text-dimmed">
          Drag a header to reorder. Focus the edge between two headers and use the arrow keys to
          resize, or double-click it to restore the default width.
        </p>
      </div>
    </template>
  </UPopover>
</template>
