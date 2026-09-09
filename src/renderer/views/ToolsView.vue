<script setup lang="ts">
import { computed } from 'vue'
import TagWritebackReview from '@renderer/panels/tools/TagWritebackReview.vue'
import CdRipPane from '@renderer/panels/tools/CdRipPane.vue'
import { CD_RIP_TOOL, TAG_WRITEBACK_TOOL, useToolsStore } from '@renderer/stores/tools'

/**
 * The Tools tab's body — **W16-6 / W18-7**. Renders whichever tool the rail has
 * active. Adding a tool is an entry in `TOOLS` and a branch here.
 */
const tools = useToolsStore()
const active = computed(() => tools.activeToolId)
</script>

<template>
  <div class="h-full min-h-0 bg-default">
    <TagWritebackReview v-if="active === TAG_WRITEBACK_TOOL" />
    <CdRipPane v-else-if="active === CD_RIP_TOOL" />
  </div>
</template>
