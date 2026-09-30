<script setup lang="ts">
import type { DiscMetadataProposal } from '@shared/cdrip'

/**
 * MusicBrainz pressings for the disc in the drive — **W18-7**. Nothing is
 * pre-selected: the operator confirms, matching R5's stance on identity.
 */
defineProps<{
  candidates: readonly DiscMetadataProposal[]
  selectedIndex: number | null
}>()

const emit = defineEmits<{
  select: [index: number]
  confirm: []
  skip: []
}>()

function meta(candidate: DiscMetadataProposal): string {
  const parts: string[] = []
  if (candidate.year !== null) parts.push(String(candidate.year))
  if (candidate.country) parts.push(candidate.country)
  if (candidate.format) parts.push(candidate.format)
  parts.push(`${candidate.tracks.length} tracks`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <p class="text-xs font-medium text-muted">Matching releases</p>
      <p class="mt-0.5 text-[11px] text-dimmed">
        Nothing is applied until you confirm. Pressings differ by country and year.
      </p>
      <ul class="mt-3 space-y-1" role="listbox" aria-label="Matching releases">
        <li v-for="(candidate, index) in candidates" :key="candidate.releaseMbid ?? index">
          <button
            type="button"
            role="option"
            class="flex w-full flex-col rounded-md border px-3 py-2 text-left transition-colors"
            :class="
              selectedIndex === index
                ? 'border-primary bg-elevated'
                : 'border-default hover:bg-elevated/60'
            "
            :aria-selected="selectedIndex === index"
            @click="emit('select', index)"
          >
            <span class="truncate text-sm font-medium text-highlighted">{{
              candidate.album || 'Untitled'
            }}</span>
            <span class="truncate text-xs text-muted">{{
              candidate.albumArtist || 'Unknown artist'
            }}</span>
            <span class="mt-0.5 truncate text-[11px] text-dimmed">{{ meta(candidate) }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div class="flex shrink-0 items-center justify-end gap-2 border-t border-default px-4 py-2">
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        label="Enter titles yourself"
        @click="emit('skip')"
      />
      <UButton
        size="xs"
        color="primary"
        label="Use this release"
        :disabled="selectedIndex === null"
        @click="emit('confirm')"
      />
    </div>
  </div>
</template>
