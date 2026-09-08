<script setup lang="ts">
import { computed, watch } from 'vue'
import FavoriteStar from '@renderer/panels/FavoriteStar.vue'
import { describeCredit } from '@renderer/panels/tunedeck/imageCredit'
import { useArtistFavorites } from '@renderer/stores/artistStars'
import { useFocusedHeaderStore } from '@renderer/stores/focusedHeader'

/**
 * Who the song list is currently about — one genre, one artist, or one album.
 *
 * Replaces the compact "Songs" title when `focusKind` is set. The column and
 * group choosers stay in the parent: they are chrome for the list, not facts
 * about the source, and they have to sit in the same place whether this strip
 * is showing or not.
 *
 * An album draws its sleeve on the left, the same sharp thumbnail the grouped
 * list uses. The blurred cover behind the panel is a surface; this one is the
 * record. Artists and genres keep the small icon — they have no sleeve to show.
 *
 * ## Why there is no rule under it
 *
 * `FocusedBackdrop` runs behind this strip and on past it into the first rows.
 * A border here would draw a line across a continuous surface and cut the
 * picture in half, the same reason the Tunedeck identity header dropped its
 * hairline.
 *
 * ## Why the tag row holds its height when empty
 *
 * Tag coverage arrives over IPC, and the store clears it to `[]` on every
 * artist change — so a row that only exists when `focusTags` is non-empty pops
 * in a frame or two after the name, and again in reverse when the next artist
 * has no tags. Reserving one badge-row of height for the whole of an artist
 * focus makes both transitions still. The reservation is deliberately keyed on
 * `kind === 'artist'` rather than on the tags themselves: only the artist
 * branch of the store ever loads coverage, so holding the space under an album
 * or genre would be dead margin waiting for something that never comes.
 */

const focus = useFocusedHeaderStore()
const stars = useArtistFavorites()

const credit = computed(() => (focus.photo ? describeCredit(focus.photo.credit) : null))

const artistId = computed(() => focus.artistId)
const artistName = computed(() => focus.artist?.name ?? 'this artist')
const starred = computed(() => (artistId.value !== null ? stars.isFavorite(artistId.value) : false))
const starPending = computed(() =>
  artistId.value !== null ? stars.isPending(artistId.value) : false
)

watch(
  artistId,
  (id) => {
    if (id !== null) void stars.hydrate([id])
  },
  { immediate: true }
)

function toggleArtist(): void {
  const id = artistId.value
  if (id !== null) void stars.toggle(id)
}
</script>

<template>
  <div class="flex min-w-0 flex-1 gap-3">
    <img
      v-if="focus.sleeve"
      :src="focus.sleeve"
      alt=""
      aria-hidden="true"
      class="size-14 shrink-0 rounded bg-elevated object-cover"
      draggable="false"
    />

    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex h-8 min-w-0 items-center gap-2">
        <UIcon
          v-if="!focus.sleeve"
          :name="focus.icon"
          class="size-5 shrink-0 text-primary"
          aria-hidden="true"
        />

        <h2
          class="min-w-0 truncate text-xl font-bold leading-tight tracking-tight text-highlighted"
        >
          {{ focus.title }}
        </h2>

        <UTooltip v-if="artistId !== null" text="Favorite this artist">
          <FavoriteStar
            :favorite="starred"
            :pending="starPending"
            :label="artistName"
            @toggle="toggleArtist"
          />
        </UTooltip>

        <UPopover v-if="credit" :ui="{ content: 'w-64 p-3' }">
          <UButton
            variant="ghost"
            size="xs"
            icon="i-tabler-info-circle"
            square
            class="shrink-0 text-dimmed"
            :aria-label="credit.summary"
          />
          <template #content>
            <p class="text-xs font-medium text-highlighted">Photograph</p>
            <p v-if="credit.name" class="mt-1 text-xs leading-relaxed text-muted">
              {{ credit.name }}
            </p>
            <p class="mt-2 text-xs leading-relaxed text-dimmed">
              <template v-if="credit.licence">
                <a
                  v-if="credit.licenceUrl"
                  :href="credit.licenceUrl"
                  target="_blank"
                  rel="noreferrer"
                  class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
                >
                  {{ credit.licence }}
                </a>
                <span v-else>{{ credit.licence }}</span>
                ·
              </template>
              <a
                :href="credit.descriptionUrl"
                target="_blank"
                rel="noreferrer"
                class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
              >
                Wikimedia Commons
              </a>
            </p>
          </template>
        </UPopover>
      </div>

      <p
        v-if="focus.detail"
        class="mt-1 truncate text-sm text-muted"
        :class="{ 'ps-7': !focus.sleeve }"
      >
        {{ focus.detail }}
      </p>

      <div v-if="focus.kind === 'artist'" class="mt-2 min-h-6" :class="{ 'ps-7': !focus.sleeve }">
        <ul
          v-if="focus.focusTags.length > 0"
          class="m-0 flex list-none flex-wrap gap-1 p-0"
          aria-label="Tags"
        >
          <li v-for="tag in focus.focusTags" :key="tag.id">
            <UTooltip :text="`On ${tag.carried.toLocaleString()} of this artist's tracks`">
              <UBadge color="neutral" variant="subtle" size="sm" class="max-w-40 truncate">
                {{ tag.label }}
              </UBadge>
            </UTooltip>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
