<script setup lang="ts">
import { computed } from 'vue'
import TagWritebackReview from '@renderer/panels/tools/TagWritebackReview.vue'
import { TAG_WRITEBACK_TOOL, useToolsStore } from '@renderer/stores/tools'

/**
 * The Tools tab's body — **W16-6**. Renders whichever tool the rail has active.
 * One tool today; the `v-if` chain is where the next one lands.
 */
const tools = useToolsStore()
const active = computed(() => tools.activeToolId)
</script>

<template>
  <div class="h-full min-h-0 bg-default">
    <TagWritebackReview v-if="active === TAG_WRITEBACK_TOOL" />
  </div>
</template>
