<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { SearchEntityKind, SearchHit } from '@shared/search'
import { search as searchIpc } from '@renderer/ipc'
import {
  buildNavigationCommands,
  matchNavigation,
  type NavigationCommand
} from '@renderer/shell/navigationCommands'
import { homeTabForKind, performSelection } from '@renderer/shell/paletteActivation'
import { createPaletteSearch } from '@renderer/shell/paletteSearch'
import { shellTabs } from '@renderer/shell/routes'
import { usePaletteStore } from '@renderer/stores/palette'

/**
 * The command palette — D21's one prefixed modal, and RQ1's spike.
 *
 * Mounted once by the frame beside `NewPlaylistModal`, for the same reason: the
 * gestures that open it (Ctrl/Cmd+K, the title-bar box) come from places a tab
 * change unmounts, so the modal cannot live under a route.
 *
 * The RQ1 question this answers is whether one `UCommandPalette` can render
 * synchronous and asynchronous groups together without stutter. It can, by
 * taking the filtering off Fuse: every group is handed over with `ignoreFilter`,
 * so the Views group is matched here (`matchNavigation`) and the entity groups
 * arrive already ranked from `search.query` (`createPaletteSearch`). Fuse never
 * re-scans a 100k-track result set — the per-group cap and the prefix modes are
 * the brakes (RQ2), not a client-side pass. The mitigation the design reserved —
 * windowing the entity groups — is not needed at these caps and stays available.
 *
 * Actions and Settings are the other two D21 groups; they are stubs here and
 * W13-7 fills them from the command and settings registries.
 */
const palette = usePaletteStore()
const router = useRouter()

const search = createPaletteSearch({ query: searchIpc.query })

/** Built once — a new tab is a new command with no work here. */
const navCommands = buildNavigationCommands(shellTabs)

const GROUP_LABELS: Record<Exclude<SearchEntityKind, 'view'>, string> = {
  album: 'Albums',
  artist: 'Artists',
  playlist: 'Playlists',
  track: 'Tracks',
  show: 'Shows'
}

const GROUP_ICONS: Record<Exclude<SearchEntityKind, 'view'>, string> = {
  album: 'i-tabler-disc',
  artist: 'i-tabler-user',
  playlist: 'i-tabler-playlist',
  track: 'i-tabler-music',
  show: 'i-tabler-microphone'
}

function close(): void {
  palette.close()
}

/**
 * Navigation is a router push, like the tab row — the frame mirrors the route
 * back into `shell.activeTab`, so this stays the one place that writes it. Deep
 * targets (a specific playlist) layer on here in W13-7.
 */
function navigate(tab: string): void {
  void router.push({ name: tab })
}

function navItem(command: NavigationCommand): CommandPaletteItem {
  return {
    label: command.label,
    icon: command.icon,
    onSelect: () => performSelection({ tab: command.tab }, { navigate, close })
  }
}

function hitItem(hit: SearchHit): CommandPaletteItem {
  return {
    label: hit.title,
    suffix: hit.subtitle ?? undefined,
    icon: hit.kind === 'view' ? undefined : GROUP_ICONS[hit.kind],
    onSelect: () => performSelection({ tab: homeTabForKind(hit.kind) }, { navigate, close })
  }
}

/**
 * The groups, in D21 category order: Views, then the entity groups main already
 * ranked and ordered, then Actions and Settings. Empty groups are omitted, and a
 * prefix mode narrows to its own — `@`/`#` scope `search.query` in main, `>`/`/`
 * would scope the (stubbed) renderer groups.
 */
const groups = computed<CommandPaletteGroup[]>(() => {
  const { mode, text } = search.parsed.value
  const out: CommandPaletteGroup[] = []

  if (mode === 'blended') {
    const nav = matchNavigation(navCommands, text)
    if (nav.length > 0) {
      out.push({ id: 'views', label: 'Views', ignoreFilter: true, items: nav.map(navItem) })
    }
  }

  for (const group of search.result.value.groups) {
    if (group.kind === 'view' || group.hits.length === 0) continue
    out.push({
      id: group.kind,
      label: GROUP_LABELS[group.kind],
      ignoreFilter: true,
      items: group.hits.map(hitItem)
    })
  }

  // Actions and Settings — the remaining D21 groups — are wired in W13-7.
  return out
})

/** The raw input, prefix and all; the parse and debounce live in `search`. */
function onSearchTerm(term: string): void {
  search.setTerm(term)
}

/** A fresh palette every open: drop the last query and any in-flight request. */
watch(
  () => palette.open,
  (open) => {
    if (!open) search.reset()
  }
)
</script>

<template>
  <UModal
    v-model:open="palette.open"
    title="Search"
    description="Jump to anything — prefix with > actions, @ artists, # playlists, / settings."
    :ui="{ header: 'sr-only', body: 'p-0 sm:p-0' }"
  >
    <template #body>
      <UCommandPalette
        :groups="groups"
        :loading="search.loading.value"
        :fuse="{ fuseOptions: { threshold: 0.3 } }"
        placeholder="Search everything…"
        :close="false"
        class="h-96"
        @update:search-term="onSearchTerm"
      />
    </template>
  </UModal>
</template>
