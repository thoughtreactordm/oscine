<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { SearchEntityKind, SearchHit } from '@shared/search'
import { library, search as searchIpc } from '@renderer/ipc'
import { albumPlayParams } from '@renderer/panels/discoverShelves'
import { useSettings } from '@renderer/settings'
import { buildActionCommands } from '@renderer/shell/actionCommands'
import { matchCommands, type Command } from '@renderer/shell/commandRegistry'
import {
  buildNavigationCommands,
  matchNavigation,
  type NavigationCommand
} from '@renderer/shell/navigationCommands'
import { buildOnboardingCommands } from '@renderer/shell/onboardingCommands'
import {
  activateHit,
  performSelection,
  type HitActivationDeps
} from '@renderer/shell/paletteActivation'
import { createPaletteSearch } from '@renderer/shell/paletteSearch'
import { buildSettingsCommands } from '@renderer/shell/settingsCommands'
import { shellTabs } from '@renderer/shell/routes'
import { useOnboardingStore } from '@renderer/stores/onboarding'
import { usePaletteStore } from '@renderer/stores/palette'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { usePodcastsStore } from '@renderer/stores/podcasts'
import { useSettingsNavStore } from '@renderer/stores/settingsNav'
import { useZenStore } from '@renderer/stores/zen'

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
 * Actions and Settings are the other two D21 groups, filled from the command
 * registry (`actionCommands` plus D-ONB-6's `onboarding.rerun`) and the settings
 * registry (`settingsCommands`); entity hits carry their own verb through
 * `activateHit`.
 */
const palette = usePaletteStore()
const router = useRouter()
const playback = usePlaybackStore()
const onboarding = useOnboardingStore()
const playlists = usePlaylistsStore()
const podcasts = usePodcastsStore()
const settings = useSettings()
const settingsNav = useSettingsNavStore()
const zen = useZenStore()
const toast = useToast()

const search = createPaletteSearch({ query: searchIpc.query })

/** Built once — a new tab is a new command with no work here. */
const navCommands = buildNavigationCommands(shellTabs)

/** In blended mode the command groups are capped so they never bury the entities. */
const COMMANDS_BLENDED_CAP = 5

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
 * targets (a specific playlist) reach it through `hitDeps` below.
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

/** The D22 confirmation, shared by the Actions and Settings groups. */
function notify(message: string): void {
  toast.add({ title: message, icon: 'i-tabler-check', color: 'primary' })
}

/**
 * The two D21 command groups, built once. Their `run` closures carry the
 * store verbs, the toast and the dismissal, so `matchCommands` is all the
 * component does at query time — the same shape as the Views group.
 * Onboarding's re-run is folded into Actions (see below), not a third group.
 */
const actionCommands = buildActionCommands({
  toggle: () => playback.toggle(),
  next: () => playback.next(),
  previous: () => playback.previous(),
  toggleShuffle: () => playback.toggleShuffle(),
  cycleRepeat: () => playback.cycleRepeat(),
  clearQueue: () => playback.clearQueue(),
  toggleZen: () => zen.toggle(),
  notify,
  close
})

/**
 * D-ONB-6. Lives in the Actions group as a verb, not in `/` settings — the
 * done-key is internal. Closes the palette first so the wizard is not a second
 * overlay on top of the finder.
 */
const onboardingCommands = buildOnboardingCommands({
  openWizard: () => onboarding.openWizard(),
  close
})

const settingCommands = buildSettingsCommands({
  get: (key) => settings.get(key),
  set: (key, value) => settings.set(key, value),
  reveal: (key) => settingsNav.reveal(key),
  goToSettings: () => navigate('settings'),
  notify,
  close
})

function commandItem(command: Command): CommandPaletteItem {
  return { label: command.label, icon: command.icon, onSelect: () => void command.run() }
}

/** Play one track now, resolving the row main holds behind the hit's id. */
async function playTrackNow(trackId: number): Promise<void> {
  const [track] = await library.getTracksByIds({ ids: [trackId] })
  if (track) await playback.playTracks({ tracks: [track], index: 0 })
}

/** How an entity hit is activated — album/track play, a show downloads, the rest navigate. */
const hitDeps: HitActivationDeps = {
  playAlbum: (albumId) => void playback.playFromList(albumPlayParams(albumId)),
  playTrack: (trackId) => void playTrackNow(trackId),
  openPlaylist: (playlistId) => playlists.openTab(playlistId),
  openShow: (podcastId) => podcasts.openTab(podcastId),
  downloadLatestEpisode: (podcastId) =>
    void podcasts.downloadLatest(podcastId).then((episode) => {
      if (episode) notify(`Downloading “${episode.title}”`)
    }),
  navigate,
  close
}

function hitItem(hit: SearchHit): CommandPaletteItem {
  return {
    label: hit.title,
    suffix: hit.subtitle ?? undefined,
    icon: hit.kind === 'view' ? undefined : GROUP_ICONS[hit.kind],
    onSelect: () => activateHit(hit, hitDeps)
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

  // Actions and Settings — the last two D21 groups. Their own prefix shows the
  // whole group; blended shows them only once there is text to match and caps
  // them, so a keystroke of entities is never buried under every command.
  if (mode === 'action' || (mode === 'blended' && text.length > 0)) {
    const items = matchCommands([...actionCommands, ...onboardingCommands], text)
    if (items.length > 0) {
      out.push({
        id: 'actions',
        label: 'Actions',
        ignoreFilter: true,
        items: items.map(commandItem)
      })
    }
  }

  if (mode === 'setting' || (mode === 'blended' && text.length > 0)) {
    const matched = matchCommands(settingCommands, text)
    const items = mode === 'blended' ? matched.slice(0, COMMANDS_BLENDED_CAP) : matched
    if (items.length > 0) {
      out.push({
        id: 'settings',
        label: 'Settings',
        ignoreFilter: true,
        items: items.map(commandItem)
      })
    }
  }

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
    description="Jump to anything. Prefix with > for actions, @ for artists, # for playlists, / for settings."
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
