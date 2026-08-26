<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { shellTabs } from '@renderer/shell/routes'
import { usePlaybackStore } from '@renderer/stores/playback'
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
const playback = usePlaybackStore()

/**
 * Now Playing is a transient destination, not a fixed place: it appears while
 * there is a track to look at and stands down when there is not, exactly as the
 * deck does off the same `hasTrack` (G2). The route stays registered either way
 * — hiding the chip is a statement about the row, not about what is reachable —
 * so a deep link or the tick that returns here on a played-through queue still
 * lands, and the chip reappears with the track.
 */
const isTabVisible = (name: string): boolean => name !== 'now-playing' || playback.hasTrack

/**
 * Two groups, split on `trailing`. The primary destinations sit at the left; the
 * library-wide utilities (Stats, Settings) are pushed to the right and fenced
 * off with a divider, so "where in the library am I" and "what do I want to do
 * to the library" read as separate concerns (G1).
 */
const leadingTabs = computed(() =>
  shellTabs.filter((tab) => !tab.trailing && isTabVisible(tab.name))
)
const trailingTabs = computed(() => shellTabs.filter((tab) => tab.trailing))
</script>

<template>
  <nav
    class="flex h-full min-w-0 items-center gap-1 border-b border-default bg-elevated/40 px-2"
    aria-label="Views"
  >
    <UButton
      v-for="tab in leadingTabs"
      :key="tab.name"
      :icon="tab.icon"
      :label="tab.label"
      size="xs"
      variant="ghost"
      :color="shell.activeTab === tab.name ? 'primary' : 'neutral'"
      class="h-full rounded-none border-b-2 px-3 text-sm tracking-wide"
      :class="shell.activeTab === tab.name ? 'border-primary' : 'border-transparent'"
      :ui="{ leadingIcon: shell.activeTab === tab.name ? '' : 'opacity-50' }"
      :aria-pressed="shell.activeTab === tab.name"
      @click="router.push({ name: tab.name })"
    />

    <!-- The trailing utilities, right-aligned and set off with a divider. -->
    <div class="ml-auto flex h-full items-center gap-1 border-l border-default pl-2">
      <UButton
        v-for="tab in trailingTabs"
        :key="tab.name"
        :icon="tab.icon"
        :label="tab.label"
        size="xs"
        variant="ghost"
        :color="shell.activeTab === tab.name ? 'primary' : 'neutral'"
        class="h-full rounded-none border-b-2 px-3 text-sm tracking-wide"
        :class="shell.activeTab === tab.name ? 'border-primary' : 'border-transparent'"
        :ui="{ leadingIcon: shell.activeTab === tab.name ? '' : 'opacity-50' }"
        :aria-pressed="shell.activeTab === tab.name"
        @click="router.push({ name: tab.name })"
      />
    </div>
  </nav>
</template>
