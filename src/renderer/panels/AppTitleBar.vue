<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { windowControls } from '@renderer/ipc'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { usePaletteStore } from '@renderer/stores/palette'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The menu reaches the stores directly rather than emitting to a parent. The
 * bar outlives every tab now, so there is no parent that could still be holding
 * the panel an "Add music folder…" would have been forwarded to.
 */
const roots = useLibraryRootsStore()
const palette = usePaletteStore()
const playback = usePlaybackStore()
const maximized = ref(false)

/**
 * The shortcut hint on the search box. Cosmetic — the binding itself is
 * `useGlobalShortcuts`, which reads `metaKey || ctrlKey` and does not care which
 * this label shows. macOS gets ⌘, everything else Ctrl.
 */
const shortcutHint = computed(() =>
  navigator.platform.toUpperCase().includes('MAC') ? '⌘K' : 'Ctrl K'
)
let stopMaximizedListener: (() => void) | null = null

/**
 * Add, rescan, remove — the three things you can do to a library folder.
 *
 * Rescan and remove are submenus keyed by folder rather than verbs that act on
 * "the current one", because this bar has no current one: it outlives every tab
 * and the folder select lives in a sidebar that is not always mounted. Reaching
 * into `browse.rootValue` from here would make a menu in the frame chrome
 * depend on which tab the operator happens to be looking at.
 *
 * Both submenus disappear rather than grey out when there are no folders. A
 * disabled "Rescan ▸" with nothing behind it is a promise the menu cannot keep.
 */
const libraryItems = computed<DropdownMenuItem[][]>(() => {
  const folders = roots.roots
  const groups: DropdownMenuItem[][] = [
    [
      {
        label: 'Add music folder…',
        icon: 'i-tabler-folder-plus',
        onSelect: () => void roots.addFolder()
      }
    ]
  ]

  if (folders.length === 0) return groups

  groups.push([
    {
      label: 'Rescan',
      icon: 'i-tabler-refresh',
      children: [
        ...folders.map((root) => ({
          label: root.path,
          // A scan is already running somewhere, and main de-duplicates per
          // root anyway — but saying so beats a click that appears to do
          // nothing because the scan it started was folded into the live one.
          disabled: roots.scan !== null,
          onSelect: () => void roots.rescan(root.id)
        })),
        ...(folders.length > 1
          ? [
              { type: 'separator' as const },
              {
                label: 'All folders',
                disabled: roots.scan !== null,
                onSelect: () => void roots.rescanAll()
              }
            ]
          : [])
      ]
    }
  ])

  groups.push([
    {
      label: 'Remove folder',
      icon: 'i-tabler-folder-minus',
      children: folders.map((root) => ({
        label: root.path,
        disabled: roots.removing !== null,
        // Never removes directly. Every path to a removal goes through the one
        // confirmation the store builds — see `removePrompt`.
        onSelect: () => roots.requestRemove(root.id)
      }))
    }
  ])

  return groups
})

/**
 * The removal confirmation, rendered here and nowhere else.
 *
 * The frame chrome is the only thing always mounted, and a removal can be
 * started from the sidebar as easily as from this menu. See `removePrompt`.
 */
const removeOpen = computed({
  get: () => roots.removePrompt !== null,
  set: (open: boolean) => {
    if (!open) roots.cancelRemove()
  }
})

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

    <div class="flex flex-1 justify-center px-4">
      <!--
        The palette's discoverable face — D21. A button, not a live omnibar: it
        opens the same modal the shortcut does rather than becoming a second
        always-on search box in the chrome. `app-no-drag` so the click lands
        instead of starting a window drag.
      -->
      <button
        type="button"
        class="app-no-drag flex h-6 w-full max-w-80 items-center gap-2 rounded-md border border-default bg-default/60 px-2.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-default"
        aria-label="Search"
        @click="palette.openPalette()"
      >
        <UIcon name="i-tabler-search" class="size-3.5 shrink-0" />
        <span class="flex-1 text-left">Search…</span>
        <UKbd :value="shortcutHint" size="sm" />
      </button>
    </div>

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

    <!--
      One dialog for every route into a removal, in the one component that is
      always mounted. Wording comes from the store so the sidebar and this menu
      cannot ask for consent to two different things.
    -->
    <UModal
      v-model:open="removeOpen"
      :title="roots.removePrompt?.title ?? ''"
      :description="roots.removePrompt?.message ?? ''"
      :ui="{ footer: 'justify-end' }"
    >
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="roots.cancelRemove()">Keep</UButton>
        <UButton color="error" icon="i-tabler-folder-minus" @click="roots.confirmRemove()">
          Remove
        </UButton>
      </template>
    </UModal>
  </header>
</template>
