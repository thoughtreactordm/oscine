<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { DropdownMenuItem } from '@nuxt/ui'
import { appInfo, windowControls } from '@renderer/ipc'
import IndexingIndicator from '@renderer/panels/IndexingIndicator.vue'
import AppLogo from '@renderer/shell/AppLogo.vue'
import { SHORTCUTS, type ShortcutCategory } from '@renderer/shell/globalShortcuts'
import { shellTabs } from '@renderer/shell/routes'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { usePaletteStore } from '@renderer/stores/palette'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'
import { useTunedeckStore } from '@renderer/stores/tunedeck'
import { useZenStore } from '@renderer/stores/zen'
import { OPEN_SOURCE_CREDITS } from '@renderer/panels/openSourceCredits'
import { useSettings } from '@renderer/settings'
import {
  COLOR_MODE_TOGGLE_KEY,
  COMMAND_PALETTE_AFFORDANCE_KEY,
  ZEN_MODE_TOGGLE_BUTTON_KEY
} from '@shared/settings'
import type { ColorModeToggle } from '@shared/settings'

/**
 * The menu reaches the stores directly rather than emitting to a parent. The
 * bar outlives every tab now, so there is no parent that could still be holding
 * the panel an "Add music folder…" would have been forwarded to.
 */
const roots = useLibraryRootsStore()
const palette = usePaletteStore()
const playback = usePlaybackStore()
const shell = useShellStore()
const tunedeck = useTunedeckStore()
const zen = useZenStore()
const router = useRouter()
const settings = useSettings()
const maximized = ref(false)

/**
 * G5(a): the palette's title-bar face is an opt-out. The flex-1 spacer stays
 * either way so hiding the box does not let the menu and window controls close
 * up — the chrome keeps its shape, it just loses the search box.
 */
const paletteAffordance = computed(() => settings.get<boolean>(COMMAND_PALETTE_AFFORDANCE_KEY))
const colorModeToggle = computed(() => settings.get<ColorModeToggle>(COLOR_MODE_TOGGLE_KEY))

/**
 * The Zen mode button in the chrome, an opt-in like the color-mode toggle beside
 * it. Off by default — the mode is still reachable from the View menu, the
 * palette and Ctrl/Cmd+Shift+Z whether or not this is shown.
 */
const zenModeButton = computed(() => settings.get<boolean>(ZEN_MODE_TOGGLE_BUTTON_KEY))

/**
 * The About dialog and the Open Source dialog, opened from the Help menu and
 * closed by their own chrome. Both live here because the title bar is the one
 * component mounted for the whole life of the window — the same reason the
 * remove-folder confirmation does.
 */
const aboutOpen = ref(false)
const openSourceOpen = ref(false)
const shortcutsOpen = ref(false)

/**
 * The running version, read once when the bar mounts. It comes from
 * `app.getVersion()` in main rather than from a bundled `package.json` so the
 * number in the About box is the one the built app actually reports, not a copy
 * that a packaging step could leave behind.
 */
const version = ref('')

/** Placeholder until the documentation site exists — G7 says a stand-in is fine. */
const DOCS_URL = 'https://github.com/thoughtreactordm/oscine'

/**
 * The shortcut hint on the search box. Cosmetic — the binding itself is
 * `useGlobalShortcuts`, which reads `metaKey || ctrlKey` and does not care which
 * this label shows. macOS gets ⌘, everything else Ctrl.
 */
const shortcutHint = computed(() =>
  navigator.platform.toUpperCase().includes('MAC') ? '⌘K' : 'Ctrl K'
)

/** The order the reference groups G6's set; the categories the table carries. */
const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = ['Playback', 'Navigation']

/**
 * The fixed 1.0 shortcut set (G6), grouped for the reference modal and read
 * straight from `SHORTCUTS` — the keymap the app actually obeys — so the printed
 * set cannot drift from the bound one. The keycaps are Nuxt UI `Kbd` tokens the
 * modal renders directly, so `meta` localises to Ctrl or ⌘ on its own.
 */
const shortcutGroups = computed(() =>
  SHORTCUT_CATEGORIES.map((category) => ({
    category,
    shortcuts: SHORTCUTS.filter((spec) => spec.category === category)
  }))
)

/**
 * The keycaps for one binding, by id — how a title-bar menu item shows the same
 * shortcut the global handler obeys, through Nuxt UI's `kbds`. The tab items
 * build their own `meta + N`, since one row of the table stands for all six.
 */
function shortcutKeys(id: string): string[] {
  return [...(SHORTCUTS.find((spec) => spec.id === id)?.keys ?? [])]
}

/**
 * A wider floor on the menu panels than the default, so a row's label and its
 * shortcut hint sit apart rather than crowding. A floor, not a fixed width — a
 * long folder path in the Library menu still grows past it.
 */
const menuUi = { content: 'min-w-52' }

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

/**
 * Transport verbs, then the two standing modes.
 *
 * The verbs act on the current track and grey out with an empty transport, the
 * way the transport bar's own buttons do. Shuffle and repeat are modes, not
 * verbs — they can be armed with nothing playing and apply to the next thing
 * started — so they stay enabled and read as a separate group below the divider.
 *
 * Shuffle is a checkbox because it is on or off; repeat is a submenu of three
 * mutually exclusive modes rather than the transport's single cycling button,
 * because a menu can show all three at once and say which is current, where the
 * button can only show the one it is on.
 */
const playbackItems = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: 'Previous',
      icon: 'i-tabler-player-skip-back',
      kbds: shortcutKeys('previous'),
      disabled: !playback.hasTrack,
      onSelect: () => playback.previous()
    },
    {
      label: playback.isPlaying ? 'Pause' : 'Play',
      icon: playback.isPlaying ? 'i-tabler-player-pause' : 'i-tabler-player-play',
      kbds: shortcutKeys('playPause'),
      disabled: !playback.hasTrack,
      onSelect: () => playback.toggle()
    },
    {
      label: 'Next',
      icon: 'i-tabler-player-skip-forward',
      kbds: shortcutKeys('next'),
      disabled: !playback.hasTrack,
      onSelect: () => playback.next()
    }
  ],
  [
    {
      label: 'Shuffle',
      icon: playback.shuffleEnabled ? 'i-tabler-arrows-shuffle' : 'i-tabler-arrows-right',
      type: 'checkbox',
      checked: playback.shuffleEnabled,
      onUpdateChecked: () => void playback.toggleShuffle()
    },
    {
      label: 'Repeat',
      icon: playback.repeatMode === 'one' ? 'i-tabler-repeat-once' : 'i-tabler-repeat',
      children: [
        {
          label: 'Off',
          type: 'checkbox',
          checked: playback.repeatMode === 'off',
          onUpdateChecked: () => playback.setRepeatMode('off')
        },
        {
          label: 'All',
          type: 'checkbox',
          checked: playback.repeatMode === 'all',
          onUpdateChecked: () => playback.setRepeatMode('all')
        },
        {
          label: 'This track',
          type: 'checkbox',
          checked: playback.repeatMode === 'one',
          onUpdateChecked: () => playback.setRepeatMode('one')
        }
      ]
    }
  ]
])

/**
 * View — every tab, then the two surfaces that are not tabs.
 *
 * The tab list is `shellTabs`, the same array the tab row renders, so the menu
 * cannot list a destination the row does not have or miss one it gains. Tunedeck
 * and Quick Menu follow after a divider: neither is a place you navigate to, so
 * they read as a separate group. Tunedeck toggles in place; Quick Menu belongs
 * to Now Playing, so choosing it goes there and asks the drawer to open — see
 * `shell.requestQuickMenu`.
 */
const viewItems = computed<DropdownMenuItem[][]>(() => [
  shellTabs.map((tab, index) => ({
    label: tab.label,
    icon: tab.icon,
    // The same Mod+digit `navigateTab` binds, one row of the table per tab.
    kbds: ['meta', String(index + 1)],
    onSelect: () => void router.push({ name: tab.name })
  })),
  [
    {
      label: 'Tunedeck',
      icon: 'i-tabler-adjustments',
      // The deck stands down with an empty transport, and the toggle refuses in
      // that state — so it is disabled here for the same reason the transport's
      // own button is, rather than offering a click that does nothing.
      disabled: !playback.hasTrack,
      onSelect: () => tunedeck.toggle()
    },
    {
      label: 'Quick Menu',
      icon: 'i-tabler-layout-sidebar-left-expand',
      onSelect: () => {
        void router.push({ name: 'now-playing' })
        shell.requestQuickMenu()
      }
    }
  ],
  [
    {
      // A checkbox, because Zen is a state the menu can both enter and report:
      // the tick says whether the window is in Zen now, and toggling it leaves.
      label: 'Zen mode',
      icon: 'i-tabler-focus-2',
      type: 'checkbox',
      checked: zen.active,
      onUpdateChecked: () => zen.toggle()
    }
  ]
])

/**
 * Help — About, the documentation link, then the Open Source credits.
 *
 * The documentation target is a placeholder for now (G7). Both modals are opened
 * from here and rendered at the foot of this component.
 */
const helpItems = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: 'About Oscine',
      icon: 'i-tabler-info-circle',
      onSelect: () => {
        aboutOpen.value = true
      }
    },
    {
      label: 'Documentation',
      icon: 'i-tabler-book',
      onSelect: () => void appInfo.openExternal(DOCS_URL)
    }
  ],
  [
    {
      label: 'Keyboard shortcuts',
      icon: 'i-tabler-keyboard',
      onSelect: () => {
        shortcutsOpen.value = true
      }
    },
    {
      label: 'Open Source',
      icon: 'i-tabler-heart-handshake',
      onSelect: () => {
        openSourceOpen.value = true
      }
    }
  ]
])

/**
 * The four menus, folded into one when the chrome is too narrow to lay them out
 * (§5). Each becomes a submenu carrying its own groups, so nothing is lost — the
 * bar just spends one button's width instead of four. The overflow trigger and
 * the four inline buttons are both always rendered; a container query shows one
 * and hides the other, so there is no width measurement to keep in step.
 */
function flattenGroups(groups: DropdownMenuItem[][]): DropdownMenuItem[] {
  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ type: 'separator' as const }, ...group]
  )
}

const overflowItems = computed<DropdownMenuItem[][]>(() => [
  [
    { label: 'Library', icon: 'i-tabler-folder', children: flattenGroups(libraryItems.value) },
    {
      label: 'Playback',
      icon: 'i-tabler-player-play',
      children: flattenGroups(playbackItems.value)
    },
    { label: 'View', icon: 'i-tabler-layout-2', children: flattenGroups(viewItems.value) },
    { label: 'Help', icon: 'i-tabler-help-circle', children: flattenGroups(helpItems.value) }
  ]
])

onMounted(async () => {
  stopMaximizedListener = windowControls.onMaximizedChange((value) => {
    maximized.value = value
  })
  maximized.value = await windowControls.isMaximized()
  version.value = await appInfo.getVersion()
})

onUnmounted(() => stopMaximizedListener?.())

async function toggleMaximize(): Promise<void> {
  maximized.value = await windowControls.toggleMaximize()
}
</script>

<template>
  <header
    class="app-titlebar app-drag-region flex h-full min-w-0 items-center border-b border-default bg-elevated/70 text-sm select-none"
    aria-label="Application toolbar"
  >
    <div class="flex h-full shrink-0 items-center gap-2 px-3" aria-label="Oscine">
      <AppLogo class="size-6" />
      <span class="app-logo app-wordmark text-sm font-semibold tracking-wide text-highlighted">
        oscine
      </span>
    </div>

    <!--
      The full menu bar and the single overflow menu that replaces it are both
      here; a container query on the header shows exactly one (see the styles).
    -->
    <div class="app-overflow app-no-drag h-full items-center px-1">
      <UDropdownMenu
        :items="overflowItems"
        :content="{ align: 'start', sideOffset: 0 }"
        :ui="menuUi"
      >
        <UButton
          icon="i-tabler-menu-2"
          color="neutral"
          variant="ghost"
          size="xs"
          square
          class="h-full rounded-none"
          aria-label="Menu"
        />
      </UDropdownMenu>
    </div>

    <nav class="app-menubar app-no-drag h-full items-center" aria-label="Application menu">
      <UDropdownMenu
        :items="libraryItems"
        :content="{ align: 'start', sideOffset: 0 }"
        :ui="menuUi"
      >
        <UButton
          label="Library"
          color="neutral"
          variant="ghost"
          size="xs"
          class="h-full rounded-none px-2.5 text-xs"
        />
      </UDropdownMenu>

      <UDropdownMenu
        :items="playbackItems"
        :content="{ align: 'start', sideOffset: 0 }"
        :ui="menuUi"
      >
        <UButton
          label="Playback"
          color="neutral"
          variant="ghost"
          size="xs"
          class="h-full rounded-none px-2.5 text-xs"
        />
      </UDropdownMenu>

      <UDropdownMenu :items="viewItems" :content="{ align: 'start', sideOffset: 0 }" :ui="menuUi">
        <UButton
          label="View"
          color="neutral"
          variant="ghost"
          size="xs"
          class="h-full rounded-none px-2.5 text-xs"
        />
      </UDropdownMenu>

      <UDropdownMenu :items="helpItems" :content="{ align: 'start', sideOffset: 0 }" :ui="menuUi">
        <UButton
          label="Help"
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
        v-if="paletteAffordance"
        type="button"
        class="app-search app-no-drag flex h-6 w-full max-w-80 items-center gap-2 rounded-md border border-default bg-default/60 px-2.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-default"
        aria-label="Search"
        @click="palette.openPalette()"
      >
        <UIcon name="i-tabler-search" class="size-3.5 shrink-0" />
        <span class="flex-1 text-left">Search…</span>
        <UKbd :value="shortcutHint" size="sm" />
      </button>
    </div>

    <!--
      Live while `roots.scan` is set, gone the moment it is null. Always-on so
      a first-run Finish (or a rescan from any tab) still has an indexing cue
      after the modal or sidebar that started it is gone.
    -->
    <IndexingIndicator />

    <div class="app-no-drag flex h-full shrink-0 items-center" aria-label="Window controls">
      <!--
        Zen mode, an opt-in affordance to the left of the window controls like the
        color-mode toggle beside it. Lit while the mode is on so it reads as a
        toggle rather than only a way in; the mode hides this whole bar, so the way
        back out is the stage, the palette and the shortcut.
      -->
      <UTooltip v-if="zenModeButton" :text="zen.active ? 'Exit Zen mode' : 'Enter Zen mode'">
        <UButton
          icon="i-tabler-ear-scan"
          :color="zen.active ? 'primary' : 'neutral'"
          variant="ghost"
          :aria-pressed="zen.active"
          aria-label="Zen mode"
          @click="zen.toggle()"
        />
      </UTooltip>
      <UColorModeSwitch v-if="colorModeToggle === 'switch'" />
      <UColorModeButton v-else-if="colorModeToggle === 'button'" color="neutral" variant="ghost" />
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

    <!--
      About — the mark and wordmark exactly as the bar wears them, the running
      version, and the byline. The mark is the same `AppLogo` the title bar
      wears and the app icon is built from (see `scripts/make-icons.mjs`), so it
      themes with everything else.
    -->
    <UModal v-model:open="aboutOpen" title="About Oscine">
      <template #body>
        <div class="flex flex-col items-center gap-2 py-4 text-center">
          <AppLogo class="size-24" />
          <div class="flex flex-col items-center gap-4">
            <span class="app-logo text-2xl font-semibold tracking-wide text-highlighted">
              oscine
            </span>

            <p class="text-muted text-sm italic font-light mb-4">
              A music player that takes pride in ownership and building connections with one's
              music. Subscriptions, advertisements, and corporate whims should not hold you back
              from a modern and intelligent listening experience.
            </p>

            <p class="text-muted text-sm italic font-light mb-4">
              Please support <strong>real human musicians</strong> by purchasing music as directly
              from them as you can. Oscine attempts to make this as easy as possible without being
              an actual storefront.
            </p>

            <span class="text-sm text-muted font-semibold">Version {{ version || '—' }}</span>
          </div>
          <p class="text-sm text-dimmed">Created with ❤️ by Michael DeLally</p>
        </div>
      </template>
    </UModal>

    <!--
      Open Source — the notable stack, hand-curated (G7). Deliberately not a dump
      of the dependency tree: name, licence and a link to each project Oscine
      leans on. The list lives in `openSourceCredits.ts`.
    -->
    <UModal
      v-model:open="openSourceOpen"
      title="Open Source"
      description="Oscine is built on the work of these projects."
      :ui="{ body: 'sm:max-h-[60vh] overflow-y-auto' }"
    >
      <template #body>
        <ul class="flex flex-col gap-1">
          <li
            v-for="credit in OPEN_SOURCE_CREDITS"
            :key="credit.name"
            class="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-elevated"
          >
            <div class="flex min-w-0 flex-col">
              <button
                type="button"
                class="truncate text-left text-sm font-medium text-highlighted hover:underline"
                @click="appInfo.openExternal(credit.url)"
              >
                {{ credit.name }}
              </button>
              <span class="truncate text-xs text-muted">{{ credit.purpose }}</span>
            </div>
            <UBadge color="neutral" variant="subtle" size="sm" class="shrink-0">
              {{ credit.license }}
            </UBadge>
          </li>
        </ul>
      </template>
    </UModal>

    <!--
      Keyboard shortcuts — the reference G6 asks Help to carry, rendered from
      `SHORTCUTS`, the same table `useGlobalShortcuts` dispatches, so what is
      printed here is what the keys actually do.
    -->
    <UModal
      v-model:open="shortcutsOpen"
      title="Keyboard shortcuts"
      :ui="{ body: 'sm:max-h-[60vh] overflow-y-auto' }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <section
            v-for="group in shortcutGroups"
            :key="group.category"
            class="flex flex-col gap-1"
          >
            <h3 class="px-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {{ group.category }}
            </h3>
            <ul class="flex flex-col gap-1">
              <li
                v-for="shortcut in group.shortcuts"
                :key="shortcut.id"
                class="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-elevated"
              >
                <span class="text-sm text-highlighted">{{ shortcut.description }}</span>
                <span class="flex shrink-0 items-center gap-1">
                  <UKbd v-for="(key, index) in shortcut.keys" :key="index" :value="key" size="sm" />
                </span>
              </li>
            </ul>
          </section>
        </div>
      </template>
    </UModal>
  </header>
</template>

<style scoped>
/*
 * The wordmark is brand, not body copy: it wears Sora regardless of the theme's
 * type tokens, which is why the family is set here rather than routed through a
 * token. Only the colour of the mark is themeable, and that already is (the
 * `text-highlighted` class on the span).
 */
.app-logo {
  font-family: 'Sora Variable', system-ui, sans-serif;
}

/*
 * The chrome sheds width in the order it can most afford to (§5), each stage
 * keyed to the bar's own width, not the viewport's:
 *   - the wordmark goes first — the mark still says which app this is;
 *   - then the search box, whose job the palette shortcut already does;
 *   - then the four menus fold into one `☰`, so a bare-minimum window still
 *     reaches every one of them.
 * The window controls never move: they are the last thing that may leave, and on
 * a frameless window they are the only way to close it.
 */
.app-titlebar {
  container-type: inline-size;
}

.app-menubar {
  display: flex;
}

.app-overflow {
  display: none;
}

@container (max-width: 760px) {
  .app-wordmark {
    display: none;
  }
}

@container (max-width: 720px) {
  .app-search {
    display: none;
  }
}

@container (max-width: 680px) {
  .app-menubar {
    display: none;
  }

  .app-overflow {
    display: flex;
  }
}
</style>
