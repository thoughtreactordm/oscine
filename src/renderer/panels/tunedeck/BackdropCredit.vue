<script setup lang="ts">
import { computed } from 'vue'
import { describeCredit } from '@renderer/panels/tunedeck/imageCredit'
import { useArtistImageStore } from '@renderer/stores/artistImage'

/**
 * Who took the picture behind the deck — the licence half of **D14**'s images.
 *
 * ## Why it is in the title bar
 *
 * It began inline with the artist's name, which was right while `DeckBackdrop`
 * was scoped to the artist tab and wrong the moment it was not. Commons licences
 * require the author and the licence to be named *wherever the work is shown*,
 * and the work is now shown behind all four tabs. A credit that only appeared on
 * one of them would be an unattributed photograph on the other three.
 *
 * The deck's own title bar is the only chrome that is on screen whatever the
 * operator is looking at, which makes it the only correct home for a control
 * whose whole job is to always be there while the picture is.
 *
 * ## Why a popover and not a line
 *
 * The credit for one Commons file is routinely longer than this deck is wide —
 * a photographer, an institution, a required attribution string and a licence
 * name. The alternative to a popover is a truncated attribution, which is a
 * worse answer than a complete one behind a control that is always present. The
 * summary is also the button's `aria-label`, so the credit is never *only*
 * visual and never depends on the popover being opened to exist.
 *
 * Absent entirely when the backdrop is the blurred cover fallback: album art
 * came off the operator's own disk and there is nobody to attribute it to.
 */

const images = useArtistImageStore()

const credit = computed(() => (images.image ? describeCredit(images.image.credit) : null))
</script>

<template>
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
        <!--
          `target="_blank"` rather than an IPC call, for the reason the
          biography's licence line gives: main's `setWindowOpenHandler` already
          routes https to the system browser and denies the window.
        -->
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
</template>
