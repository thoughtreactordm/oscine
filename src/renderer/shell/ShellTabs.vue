<script setup lang="ts">
import { useRouter } from 'vue-router'
import { shellTabs } from '@renderer/shell/routes'
import { useShellStore } from '@renderer/stores/shell'

/**
 * The tab row, between the title bar and everything that changes.
 *
 * Buttons rather than links: these are panes of one application window, not
 * pages, and `aria-current="page"` on an anchor would claim a navigation that
 * the user never made. The router is still what the row *pushes* to — the route
 * is what survives a reload and what a deep link addresses — but what it reads
 * back is `shell.activeTab`, which the frame mirrors from the route.
 *
 * One direction each way, deliberately. A row that both wrote and read the
 * router would be the second place in the shell that decides which tab is
 * current, and the transition direction already has to be computed from one
 * ordered sequence of tab changes rather than from two.
 */
const router = useRouter()
const shell = useShellStore()
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
      :color="shell.activeTab === tab.name ? 'primary' : 'neutral'"
      class="h-full rounded-none border-b-2 px-3 text-xs"
      :class="shell.activeTab === tab.name ? 'border-primary' : 'border-transparent'"
      :aria-pressed="shell.activeTab === tab.name"
      @click="router.push({ name: tab.name })"
    />
  </nav>
</template>
