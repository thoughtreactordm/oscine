<script setup lang="ts">
import { useRouter } from 'vue-router'
import { EQUALIZER_TOOL, useToolsStore } from '@renderer/stores/tools'

/**
 * A one-line pointer above the Audio settings — **W19-4**.
 *
 * The equalizer is a whole surface with its own interaction model, so it lives in
 * the Tools tab, not as a generated settings control (see `customControls.ts` on
 * why the register stays small). An operator hunting for tone controls in Audio
 * settings would otherwise find nothing, so Audio gets this line and no more.
 */
const router = useRouter()
const tools = useToolsStore()

function openEqualizer(): void {
  tools.select(EQUALIZER_TOOL)
  void router.push({ name: 'tools' })
}
</script>

<template>
  <div class="flex items-center justify-between gap-3 border-b border-default/60 px-4 py-3">
    <p class="text-xs text-dimmed">
      The equalizer is a full surface — bands, a draggable curve and saved presets. It lives in the
      Tools tab.
    </p>
    <UButton
      size="xs"
      color="neutral"
      variant="subtle"
      icon="i-tabler-adjustments"
      trailing-icon="i-tabler-arrow-right"
      label="Open equalizer"
      class="shrink-0"
      @click="openEqualizer"
    />
  </div>
</template>
