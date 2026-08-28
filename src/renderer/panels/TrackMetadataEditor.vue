<script setup lang="ts">
import { computed } from 'vue'
import type { OverrideField } from '@shared/overrides'
import { useTrackEditStore } from '@renderer/stores/trackEdit'

/**
 * The track-metadata editor — **W16 (editor)**, D7's correction layer made
 * editable. An editable sibling to the read-only Track Info dialog: it edits the
 * fields a person reads (title, artist, album, track/disc, year, genre) for one
 * track or a whole selection, records the change in `track_overrides`, and lets
 * it show at once in the library without ever touching a file. Flushing to disk
 * is the separate write-back review.
 *
 * Mounted once by the frame; opened by the shared context menus on any surface.
 */
interface FieldSpec {
  readonly key: OverrideField
  readonly label: string
  readonly numeric: boolean
  readonly hint?: string
}

const FIELDS: readonly FieldSpec[] = [
  { key: 'title', label: 'Title', numeric: false },
  { key: 'artist', label: 'Artist', numeric: false },
  { key: 'album', label: 'Album', numeric: false },
  { key: 'trackNo', label: 'Track №', numeric: true },
  { key: 'discNo', label: 'Disc №', numeric: true },
  { key: 'year', label: 'Year', numeric: true },
  { key: 'genre', label: 'Genre', numeric: false, hint: 'Separate multiple with “;”' }
]

const store = useTrackEditStore()

const heading = computed(() => (store.label ? `Edit — ${store.label}` : 'Edit metadata'))

function mixed(field: OverrideField): boolean {
  return store.editState?.[field].mixed ?? false
}
function overridden(field: OverrideField): boolean {
  return store.editState?.[field].overridden ?? false
}
function placeholder(field: FieldSpec): string {
  if (mixed(field.key)) return 'Multiple values'
  return field.numeric ? '—' : ''
}
</script>

<template>
  <UModal
    :open="store.open"
    title="Edit metadata"
    :description="store.label"
    :ui="{ description: 'sr-only', title: 'sr-only' }"
    @update:open="(value: boolean) => !value && store.close()"
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <header class="min-w-0">
          <h2 class="truncate text-base font-semibold text-highlighted">{{ heading }}</h2>
          <p class="truncate text-xs text-muted">
            Corrections show in the library at once; your files are untouched until you write them
            back.
          </p>
        </header>

        <div v-if="store.loading" class="grid place-items-center py-8">
          <UIcon name="i-tabler-loader-2" class="size-6 animate-spin text-dimmed" />
        </div>

        <div v-else-if="store.trackIds.length === 0" class="py-8 text-center text-sm text-muted">
          Nothing to edit.
        </div>

        <form v-else class="flex flex-col gap-3" @submit.prevent="store.save()">
          <div v-for="field in FIELDS" :key="field.key" class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <label :for="`edit-${field.key}`" class="text-xs font-medium text-dimmed">
                {{ field.label }}
              </label>
              <span
                v-if="overridden(field.key)"
                class="size-1.5 rounded-full bg-primary"
                title="This field is a correction"
              />
              <button
                v-if="overridden(field.key)"
                type="button"
                class="ml-auto inline-flex items-center gap-1 text-[11px] transition-colors"
                :class="
                  store.reverting[field.key] ? 'text-primary' : 'text-dimmed hover:text-default'
                "
                @click="store.toggleRevert(field.key)"
              >
                <UIcon name="i-tabler-arrow-back-up" class="size-3.5" />
                {{ store.reverting[field.key] ? 'Reverting to file' : 'Revert to file' }}
              </button>
            </div>
            <UInput
              :id="`edit-${field.key}`"
              v-model="store.values[field.key]"
              :placeholder="placeholder(field)"
              :disabled="store.reverting[field.key]"
              :inputmode="field.numeric ? 'numeric' : undefined"
              size="sm"
            />
            <p v-if="field.hint" class="text-[11px] text-dimmed">{{ field.hint }}</p>
          </div>

          <p v-if="store.errorMessage" class="text-xs text-error">{{ store.errorMessage }}</p>
        </form>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="store.close()" />
        <UButton
          color="primary"
          label="Save"
          :loading="store.saving"
          :disabled="!store.canSave()"
          @click="store.save()"
        />
      </div>
    </template>
  </UModal>
</template>
