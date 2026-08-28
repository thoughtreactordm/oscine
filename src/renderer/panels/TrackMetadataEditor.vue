<script setup lang="ts">
import { computed } from 'vue'
import type { OverrideField } from '@shared/overrides'
import { artworkUrl, hasArtwork } from '@shared/ipc'
import { useTrackEditStore } from '@renderer/stores/trackEdit'

/**
 * The track-metadata editor — **W16 (editor)**, D7's correction layer made
 * editable. An editable sibling to the read-only Track Info dialog: it edits the
 * fields a person reads (title, artist, album, track/disc, year, genre) for one
 * track or a whole selection, records the change in `track_overrides`, and lets
 * it show at once in the library without ever touching a file. Flushing to disk
 * is the separate write-back review.
 *
 * The cover panel is **W16-12**: a left-hand sleeve column, large enough to
 * inspect, with Set / Remove / Revert applying immediately through the W16-10
 * ingest IPC (Decision A — a chosen cover shows everywhere before any flush),
 * across the whole selection (Decision C). When a cover is present the modal
 * wears the same blurred bleed the transport does, confined to the upper left
 * so the form stays readable. The chrome header is overlaid and unpainted so
 * that wash can sit behind the close control rather than stopping at a solid
 * band.
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

const heading = computed(() => (store.label ? `Edit ${store.label}` : 'Edit metadata'))

/** `large`: the sleeve is the subject here, and the bleed is scaled past it. */
const coverSrc = computed(() => artworkUrl(store.artworkRef.hash, 'large'))
const coverPresent = computed(() => hasArtwork(coverSrc.value) && store.artworkRef.present)

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
    :ui="{
      description: 'sr-only',
      title: 'sr-only',
      content: 'sm:max-w-3xl overflow-hidden divide-y-0',
      header: 'absolute inset-x-0 top-0 z-10 bg-transparent pointer-events-none',
      close: 'pointer-events-auto',
      body: 'sm:p-0',
      footer: 'justify-end border-t border-default'
    }"
    @update:open="(value: boolean) => !value && store.close()"
  >
    <template #body>
      <div class="relative isolate overflow-hidden">
        <!--
          The transport's cover bleed, cropped to the upper left so the form
          does not have to fight it. Token blur and bleed, no drift: a dialog
          that is being typed into should not be moving underneath the caret.
        -->
        <div v-if="coverPresent" class="cover-bleed" aria-hidden="true">
          <div class="cover-bleed-art" :style="{ backgroundImage: `url('${coverSrc}')` }" />
        </div>

        <div v-if="store.loading" class="grid place-items-center py-12">
          <UIcon name="i-tabler-loader-2" class="size-6 animate-spin text-dimmed" />
        </div>

        <div v-else-if="store.trackIds.length === 0" class="py-12 text-center text-sm text-muted">
          Nothing to edit.
        </div>

        <form v-else class="flex min-h-0" @submit.prevent="store.save()">
          <aside class="flex w-64 shrink-0 flex-col gap-3 p-4">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-dimmed">Cover</span>
              <span
                v-if="store.artworkOverridden"
                class="size-1.5 rounded-full bg-primary"
                title="This field is a correction"
              />
            </div>
            <div
              class="aspect-square w-full overflow-hidden rounded-md border border-default bg-elevated/60"
            >
              <div
                v-if="store.artworkMixed"
                class="flex size-full items-center justify-center"
                title="Multiple covers"
              >
                <UIcon name="i-tabler-layers-intersect" class="size-12 text-dimmed/50" />
              </div>
              <img
                v-else-if="coverPresent"
                :src="coverSrc"
                alt=""
                aria-hidden="true"
                class="size-full object-cover"
                draggable="false"
              />
              <div v-else class="flex size-full items-center justify-center">
                <UIcon name="i-tabler-vinyl" class="size-12 text-dimmed/40" aria-hidden="true" />
              </div>
            </div>
            <p v-if="store.artworkMixed" class="text-[11px] text-muted">Multiple covers</p>
            <div class="flex flex-col gap-1.5">
              <UButton
                type="button"
                size="xs"
                color="neutral"
                variant="soft"
                block
                icon="i-tabler-photo-plus"
                label="Set cover…"
                :loading="store.artworkBusy"
                @click="store.setCover()"
              />
              <UButton
                type="button"
                size="xs"
                color="neutral"
                variant="ghost"
                block
                icon="i-tabler-photo-off"
                label="Remove"
                :disabled="store.artworkBusy"
                @click="store.removeCover()"
              />
              <button
                v-if="store.artworkOverridden"
                type="button"
                class="inline-flex items-center justify-center gap-1 pt-0.5 text-[11px] text-dimmed transition-colors hover:text-default"
                :disabled="store.artworkBusy"
                @click="store.revertCover()"
              >
                <UIcon name="i-tabler-arrow-back-up" class="size-3.5" />
                Revert to file
              </button>
            </div>
          </aside>

          <div class="flex min-w-0 flex-1 flex-col gap-3 p-4 pl-2 pr-12">
            <header class="min-w-0">
              <h2 class="truncate text-base font-semibold text-highlighted">{{ heading }}</h2>
              <p class="truncate text-xs text-muted">
                Corrections show in the library at once; your files are untouched until you write
                them back.
              </p>
            </header>

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
          </div>
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
          :disabled="!store.canSave"
          @click="store.save()"
        />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
/*
 * Same treatment as the transport bar (`NowPlaying.vue`): the theme's blur and
 * bleed, overscaled so the blur does not show a hard edge. Masked to the upper
 * left so it is atmosphere around the sleeve, not a wash over the form.
 */
.cover-bleed {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: calc(var(--oscine-cover-bleed) * 0.65);
  mask-image: radial-gradient(77% 70% at 0% 0%, black 0%, black 22%, transparent 52%);
}

.cover-bleed-art {
  position: absolute;
  top: -21%;
  left: -20%;
  width: 63%;
  height: 77%;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  filter: blur(var(--oscine-cover-blur)) saturate(3.6);
  transform: scale(1.45);
}
</style>
