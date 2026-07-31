<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import AppTitleBar from '@renderer/panels/AppTitleBar.vue'
import NowPlaying from '@renderer/panels/NowPlaying.vue'
import ShellSidebar from '@renderer/shell/ShellSidebar.vue'
import ShellTabs from '@renderer/shell/ShellTabs.vue'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The frame.
 *
 * Four rows, of which two never change: the title bar at the top and the
 * transport at the bottom are the application, not a view of it, and they are
 * mounted once for the life of the window so a tab change cannot interrupt
 * playback or drop the OS media session.
 *
 * Between them, the tab row decides what the other two rows contain — a body,
 * and optionally something for the sidebar to put above its cover pane. Both
 * arrive as routed views, which is what keeps this component ignorant of every
 * tab that exists: it places, it does not know.
 */
const route = useRoute()
const roots = useLibraryRootsStore()
const playback = usePlaybackStore()

/**
 * Tabs that want the whole width say so in the route table. Dropping the panel
 * rather than collapsing it is deliberate: a zero-width pane still owns a
 * resize handle, and a distraction-free screen with a drag target down its left
 * edge is not one.
 */
const hasSidebar = computed(() => route.meta.sidebar)

/**
 * Scan progress and the roots list outlive any one tab, so the frame owns their
 * subscription rather than the sidebar that happens to draw them.
 */
onMounted(() => roots.start())

onUnmounted(() => {
  roots.stop()
  playback.dispose()
})
</script>

<template>
  <main
    class="grid h-screen grid-rows-[2.25rem_2.25rem_minmax(0,1fr)_5rem] overflow-hidden bg-border text-default"
  >
    <AppTitleBar />

    <ShellTabs />

    <div class="relative min-h-0 overflow-hidden">
      <UDashboardGroup
        unit="px"
        :persistent="false"
        class="gap-px"
        :ui="{ base: 'absolute inset-0' }"
        storage-key="fermata-shell"
      >
        <UDashboardPanel
          v-if="hasSidebar"
          id="sidebar"
          :default-size="320"
          :min-size="240"
          :max-size="480"
          resizable
          class="min-h-0 min-w-60 bg-default"
        >
          <ShellSidebar>
            <RouterView name="sidebar" />
          </ShellSidebar>
        </UDashboardPanel>

        <UDashboardPanel id="body" class="min-h-0 min-w-120 flex-1 bg-default">
          <RouterView />
        </UDashboardPanel>
      </UDashboardGroup>
    </div>

    <div class="min-h-0 border-t border-default bg-default">
      <NowPlaying />
    </div>
  </main>
</template>
