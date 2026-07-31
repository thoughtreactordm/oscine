<script setup lang="ts">
import { ALBUM_ART_SIZES, ALBUM_ART_SIZE_KEYS } from '@renderer/panels/groupingLayout'
import { useTrackGroupingStore } from '@renderer/stores/grouping'

/**
 * Album grouping, from the toolbar. One preference, wherever it is mounted.
 *
 * Grouping only has anything to draw under an album-major ordering — under any
 * other column the albums interleave and there are no runs — so the popover
 * says as much rather than leaving a switch that appears to do nothing. The
 * setting itself stays live either way: turning it on while sorted by Title is
 * a statement about what to do once the list is sorted by album, not a no-op to
 * be swallowed.
 *
 * Whether *this* list can be grouped is a prop rather than something read out of
 * a store, and that is the island rule doing real work: this used to ask
 * `trackList` — the library's song list — which was invisibly wrong the moment
 * the chooser appeared over a second list. The playlist contents pane is always
 * groupable, because turning it on re-sorts the pane rather than waiting for a
 * column that pane does not have.
 */
const grouping = useTrackGroupingStore()

withDefaults(
  defineProps<{
    /** Whether the list this sits over has runs to head right now. */
    groupable: boolean
    /** Shown when it does not, to say what would make it groupable. */
    hint?: string
  }>(),
  { hint: undefined }
)
</script>

<template>
  <UPopover :ui="{ content: 'w-72' }">
    <UButton
      color="neutral"
      :variant="grouping.enabled && groupable ? 'soft' : 'ghost'"
      size="xs"
      icon="i-tabler-library"
      aria-label="Album grouping"
      title="Album grouping"
    />

    <template #content>
      <div class="flex flex-col">
        <div class="flex items-center gap-2 border-b border-default px-3 py-2">
          <h3 class="text-sm font-semibold text-highlighted">Albums</h3>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            class="ms-auto"
            @click="grouping.reset()"
          >
            Reset
          </UButton>
        </div>

        <div class="px-3 py-2">
          <UCheckbox
            :model-value="grouping.enabled"
            label="Group by album"
            description="Head each album with its sleeve."
            @update:model-value="grouping.toggleEnabled()"
          />
        </div>

        <div class="border-t border-default px-3 py-2">
          <p id="album-art-size" class="pb-1.5 text-xs font-medium text-muted">Sleeve size</p>
          <div class="flex gap-1" role="group" aria-labelledby="album-art-size">
            <UButton
              v-for="size in ALBUM_ART_SIZE_KEYS"
              :key="size"
              color="neutral"
              :variant="grouping.enabled && grouping.artSize === size ? 'soft' : 'ghost'"
              size="xs"
              class="flex-1 justify-center"
              :aria-pressed="grouping.enabled && grouping.artSize === size"
              @click="grouping.setArtSize(size)"
            >
              {{ ALBUM_ART_SIZES[size].label }}
            </UButton>
          </div>
        </div>

        <p v-if="!groupable && hint" class="border-t border-default px-3 py-2 text-xs text-dimmed">
          {{ hint }}
        </p>
      </div>
    </template>
  </UPopover>
</template>
