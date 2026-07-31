<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { shellTabs } from '@renderer/shell/routes'

/**
 * The tab row, between the title bar and everything that changes.
 *
 * Buttons rather than links: these are panes of one application window, not
 * pages, and `aria-current="page"` on an anchor would claim a navigation that
 * the user never made. The router is still what holds the state — the route is
 * the tab — so the position survives a reload and can be deep-linked.
 */
const route = useRoute()
const router = useRouter()
</script>

<template>
  <nav
    class="flex h-full min-w-0 items-center gap-1 border-b border-default bg-elevated/40 px-2"
    aria-label="Views"
  >
    <UButton
      v-for="tab in shellTabs"
      :key="tab.name"
      :icon="tab.icon"
      :label="tab.label"
      size="xs"
      variant="ghost"
      :color="route.name === tab.name ? 'primary' : 'neutral'"
      class="h-full rounded-none border-b-2 px-3 text-xs"
      :class="route.name === tab.name ? 'border-primary' : 'border-transparent'"
      :aria-pressed="route.name === tab.name"
      @click="router.push({ name: tab.name })"
    />
  </nav>
</template>
