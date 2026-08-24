<script setup lang="ts">
import { computed } from 'vue'

/**
 * The star — playlists and artists, never tracks (**D24**, product rule 6).
 *
 * The heart's opposite number, and drawn as the heart is in `TrackList`: a
 * two-state toggle button whose glyph carries the state and whose accessible
 * name carries the subject. It is deliberately its own glyph — a control that
 * reused the heart would say a starred playlist and a hearted track are the same
 * kind of favorite, which product rule 6 says they are not.
 *
 * `aria-pressed` rather than a shape-changing label, so a screen reader hears
 * one named toggle rather than two controls; the label names the entity so the
 * star is navigable where several sit together.
 *
 * It owns no store. The parent holds the id and hands in `favorite`/`pending`
 * and takes the `toggle` — the same control serves the playlist header and the
 * artist header without either store leaking into the other's surface.
 */
const props = defineProps<{
  /** Whether the entity is starred, as the store currently knows it. */
  favorite: boolean
  /** A toggle in flight — the button is disabled so a second click is dropped. */
  pending?: boolean
  /** The entity's name, for the accessible label on an otherwise identical glyph. */
  label: string
}>()

const emit = defineEmits<{ toggle: [] }>()

const ariaLabel = computed(() =>
  props.favorite ? `Unfavorite ${props.label}` : `Favorite ${props.label}`
)
</script>

<template>
  <button
    type="button"
    class="flex size-6 items-center justify-center rounded hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
    :aria-pressed="favorite"
    :aria-label="ariaLabel"
    :disabled="pending"
    @click.stop="emit('toggle')"
    @dblclick.stop
  >
    <UIcon
      :name="favorite ? 'i-tabler-star-filled' : 'i-tabler-star'"
      class="size-4"
      :class="favorite ? 'text-primary' : 'text-dimmed'"
      aria-hidden="true"
    />
  </button>
</template>
