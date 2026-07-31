<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { windowControls } from '@renderer/ipc'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The menu reaches the stores directly rather than emitting to a parent. The
 * bar outlives every tab now, so there is no parent that could still be holding
 * the panel an "Add music folder…" would have been forwarded to.
 */
const roots = useLibraryRootsStore()
const playback = usePlaybackStore()
const maximized = ref(false)
let stopMaximizedListener: (() => void) | null = null

const libraryItems: DropdownMenuItem[] = [
  {
    label: 'Add music folder…',
    icon: 'i-tabler-folder-plus',
    onSelect: () => void roots.addFolder()
  }
]

const playbackItems = computed<DropdownMenuItem[]>(() => [
  {
    label: 'Previous',
    icon: 'i-tabler-player-skip-back',
    disabled: !playback.hasTrack,
    onSelect: () => playback.previous()
  },
  {
    label: playback.isPlaying ? 'Pause' : 'Play',
    icon: playback.isPlaying ? 'i-tabler-player-pause' : 'i-tabler-player-play',
    disabled: !playback.hasTrack,
    onSelect: () => playback.toggle()
  },
  {
    label: 'Next',
    icon: 'i-tabler-player-skip-forward',
    disabled: !playback.hasTrack,
    onSelect: () => playback.next()
  }
])

onMounted(async () => {
  stopMaximizedListener = windowControls.onMaximizedChange((value) => {
    maximized.value = value
  })
  maximized.value = await windowControls.isMaximized()
})

onUnmounted(() => stopMaximizedListener?.())

async function toggleMaximize(): Promise<void> {
  maximized.value = await windowControls.toggleMaximize()
}
</script>

<template>
  <header
    class="app-drag-region flex h-full min-w-0 items-center border-b border-default bg-elevated/70 text-sm select-none"
    aria-label="Application toolbar"
  >
    <div class="flex h-full shrink-0 items-center gap-2 px-3" aria-label="Fermata">
      <span class="flex size-5 items-center justify-center rounded bg-primary text-inverted">
        <UIcon name="i-tabler-wave-sine" class="size-3.5" />
      </span>
      <span class="text-xs font-semibold tracking-wide text-highlighted">Fermata</span>
    </div>

    <nav class="app-no-drag flex h-full items-center" aria-label="Application menu">
      <UDropdownMenu :items="libraryItems" :content="{ align: 'start', sideOffset: 0 }">
        <UButton
          label="Library"
          color="neutral"
          variant="ghost"
          size="xs"
          class="h-full rounded-none px-2.5 text-xs"
        />
      </UDropdownMenu>

      <UDropdownMenu :items="playbackItems" :content="{ align: 'start', sideOffset: 0 }">
        <UButton
          label="Playback"
          color="neutral"
          variant="ghost"
          size="xs"
          class="h-full rounded-none px-2.5 text-xs"
        />
      </UDropdownMenu>
    </nav>

    <div class="flex-1" />

    <div class="app-no-drag flex h-full shrink-0 items-center" aria-label="Window controls">
      <UColorModeSwitch />
      <UButton
        icon="i-tabler-minus"
        color="neutral"
        variant="ghost"
        class="h-full w-11 justify-center rounded-none"
        aria-label="Minimize"
        @click="windowControls.minimize()"
      />
      <UButton
        :icon="maximized ? 'i-tabler-copy' : 'i-tabler-square'"
        color="neutral"
        variant="ghost"
        class="h-full w-11 justify-center rounded-none"
        :aria-label="maximized ? 'Restore' : 'Maximize'"
        @click="toggleMaximize"
      />
      <UButton
        icon="i-tabler-x"
        color="neutral"
        variant="ghost"
        class="h-full w-11 justify-center rounded-none hover:bg-error hover:text-inverted"
        aria-label="Close"
        @click="windowControls.close()"
      />
    </div>
  </header>
</template>
