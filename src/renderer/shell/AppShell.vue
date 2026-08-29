<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import OnboardingModal from '@renderer/onboarding/OnboardingModal.vue'
import AppTitleBar from '@renderer/panels/AppTitleBar.vue'
import CommandPalette from '@renderer/panels/CommandPalette.vue'
import NewPlaylistModal from '@renderer/panels/NewPlaylistModal.vue'
import NowPlaying from '@renderer/panels/NowPlaying.vue'
import TrackInfoModal from '@renderer/panels/TrackInfoModal.vue'
import TrackMetadataEditor from '@renderer/panels/TrackMetadataEditor.vue'
import PaneResizer from '@renderer/shell/PaneResizer.vue'
import { shellTabs } from '@renderer/shell/routes'
import { useGlobalShortcuts } from '@renderer/shell/useGlobalShortcuts'
import { useIdleAutoShow } from '@renderer/shell/useIdleAutoShow'
import { useStageTransport } from '@renderer/shell/useStageTransport'
import { useContainerWidth } from '@renderer/shell/useContainerWidth'
import { useZenMode } from '@renderer/shell/useZenMode'
import { SHELL_BAND_PANE, SIDEBAR_PANE } from '@renderer/shell/shellLayout'
import ShellSidebar from '@renderer/shell/ShellSidebar.vue'
import ShellTabs from '@renderer/shell/ShellTabs.vue'
import Tunedeck from '@renderer/panels/Tunedeck.vue'
import { TUNEDECK_PANE } from '@renderer/panels/tunedeck/tunedeckPanes'
import { useBrowseStore } from '@renderer/stores/browse'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { useOnboardingStore } from '@renderer/stores/onboarding'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { useShellStore } from '@renderer/stores/shell'
import { useTunedeckStore } from '@renderer/stores/tunedeck'
import { useZenStore } from '@renderer/stores/zen'
import { useSettings } from '@renderer/settings'
import { maybeOpenOnboardingWizard } from '@renderer/shell/onboardingGate'
import { TAB_NAV_BAR_KEY } from '@shared/settings'

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
 *
 * What it no longer does is let the router own the frame's *shape*. The
 * sidebar's width used to live inside `UDashboardPanel`, which meant it lived
 * inside a `v-if` — a look at Now Playing unmounted the panel and the dragged
 * width went with it. That component could not be fixed from outside: it takes
 * `defaultSize` and emits nothing, so the number was unreachable. The split is
 * a `PaneResizer` over the shell store now, and the width is a value the frame
 * reads rather than a value the frame happens to still have.
 */
const route = useRoute()
const router = useRouter()
const roots = useLibraryRootsStore()
const playback = usePlaybackStore()
const playlists = usePlaylistsStore()
const shell = useShellStore()
const tunedeck = useTunedeckStore()
const zen = useZenStore()
const onboarding = useOnboardingStore()
const settings = useSettings()

/**
 * G5(b): the tab row is an opt-out. Off collapses its grid track to nothing and
 * skips mounting the row entirely — navigation falls to the global shortcuts
 * (D27), the palette, and the title bar's View menu. The other three rows (title
 * bar, body, transport) are fixed; only the second track changes.
 */
const tabNavBar = computed(() => settings.get<boolean>(TAB_NAV_BAR_KEY))

/**
 * Whether the Now Playing stage is carrying the transport instead of the bar —
 * always in Zen, and on the Now Playing view when the operator has merged the
 * player into it. Either way the bar's row goes; the difference is only how much
 * else does, which the grid below decides.
 */
const stageOwnsTransport = useStageTransport()

/**
 * Zen mode overrides the frame's shape rather than any one setting. It collapses
 * to a single body row — no title bar, no tab row, no transport — so the Now
 * Playing stage is the whole window. The merged Now Playing view is the gentler
 * version: it keeps the title bar and tab row and drops only the transport row,
 * since the stage carries the transport there. The tab-bar preference is not
 * touched by either, only outvoted, and returns as it was on the way out.
 */
const gridRows = computed(() => {
  if (zen.active) return 'grid-rows-[minmax(0,1fr)]'
  if (stageOwnsTransport.value) {
    return tabNavBar.value
      ? 'grid-rows-[2.25rem_2.25rem_minmax(0,1fr)]'
      : 'grid-rows-[2.25rem_minmax(0,1fr)]'
  }
  return tabNavBar.value
    ? 'grid-rows-[2.25rem_2.25rem_minmax(0,1fr)_5rem]'
    : 'grid-rows-[2.25rem_minmax(0,1fr)_5rem]'
})

/**
 * Instantiated here, not in `Sources`.
 *
 * The browse predicate decides what the song list contains, and the song list
 * is not the sidebar's dependant — it outlives it. Creating the store with the
 * frame is what makes the library filtered by whatever the user last chose
 * regardless of which tab is showing, including on the tab where the facets are
 * not drawn at all.
 */
useBrowseStore()

/**
 * The app's one global shortcut, registered once with the frame — D27. Mounted
 * here and nowhere else, so there is a single seam for W8's keyboard subsystem
 * to absorb rather than a scatter of `keydown` listeners to hunt down.
 */
useGlobalShortcuts()

/**
 * G4: the idle auto-show, mounted once with the frame for the same reason the
 * shortcut is — it watches the transport and the route from outside any one tab
 * and moves between them, so it cannot live under a view a tab change unmounts.
 */
useIdleAutoShow()

/**
 * Zen mode's frame half — the navigation and the fullscreen subscription the
 * store leaves to the frame, mounted once here for the reason the two above are.
 */
useZenMode()

const sidebarWidth = shell.paneSize(SIDEBAR_PANE)

/**
 * The reflowed band's height, dragged and remembered — the vertical counterpart
 * to `sidebarWidth`, live only while the rail is a band (§2).
 */
const bandHeight = shell.paneSize(SHELL_BAND_PANE)

/**
 * Suspends the collapse animation for the length of a drag.
 *
 * The two want the same property for opposite reasons: the collapse needs the
 * width interpolated so the pane can leave rather than vanish, and the drag
 * needs it applied on the frame it was computed or the edge is towed 200ms
 * behind the cursor. Measured on the built app before this was here — the pane
 * settled at the right number, a fifth of a second after the pointer stopped.
 */
const resizing = ref(false)

/** The same exemption for the deck's own collapse. */
const deckResizing = ref(false)

/**
 * Tabs that want the whole width say so in the route table. The sidebar is
 * collapsed to nothing rather than dropped: at zero width there is no resize
 * handle to catch — the handle is hidden with it — and animating a width is the
 * only way the pane can leave without the body jumping the moment the route
 * changes.
 */
const hasSidebar = computed(() => route.meta.sidebar === true)

/**
 * §2: below ~760px the rail and the body can no longer sit side by side, so the
 * frame reflows the rail into a band above the body and drops the body's width
 * floor. Measured on the sidebar+body region rather than the viewport — the deck
 * is a sibling outside that region, so opening it narrows what is measured here
 * and pulls the reflow forward exactly when the deck is the thing eating the
 * width. Only the browse rails carry the band presentation (`route.meta.reflow`);
 * the utility rails keep their column and simply crunch.
 */
const regionRef = ref<HTMLElement | null>(null)
const { width: regionWidth } = useContainerWidth(regionRef)
const compactSidebar = computed(
  () =>
    hasSidebar.value &&
    route.meta.reflow === true &&
    regionWidth.value > 0 &&
    regionWidth.value < 760
)

// The transport reads this to bring its cover thumbnail back when the band has
// taken the full-size cover pane off screen — see the shell store.
watch(compactSidebar, (compact) => shell.setSidebarCompact(compact), { immediate: true })

/**
 * Which way the body slides, from the order of the tab row.
 *
 * Driven from the route rather than from the click, so the direction is right
 * for a keyboard shortcut, a deep link and the back button too — anything that
 * moves the tab without going through the row. The first tab of the session
 * resolves to `none`, because there is no previous index to have come from and
 * a frame that animates itself in on launch reads as a page load.
 */
watch(
  () => route.name,
  (name) => {
    const index = shellTabs.findIndex((tab) => tab.name === name)
    shell.setActiveTab(typeof name === 'string' ? name : null, index)
  },
  { immediate: true }
)

const bodyTransition = computed(() => `tab-${shell.direction}`)

/**
 * G2: a queue that plays through on its own returns the frame to the view the
 * user came from — but only from Now Playing, and only on the natural end.
 *
 * The tick fires for the played-through boundary and no other: a pause, a Stop
 * and a skip past the last row are all decisions to stay, and none of them
 * reach here. The tab gate is the second half — the return is Now Playing's
 * lifecycle, so the frame stays put when the queue ends behind a view the user
 * chose to be on instead. Navigation goes through the router, which keeps
 * `shell.activeTab` in step exactly as the tab row's own clicks do.
 */
watch(
  () => playback.endedNaturally,
  () => {
    if (shell.activeTab === 'now-playing') void router.push({ name: shell.returnView })
  }
)

/**
 * Scan progress and the roots list outlive any one tab, so the frame owns their
 * subscription rather than the sidebar that happens to draw them.
 *
 * The playlists are here for the same reason, and it took a real gap to notice:
 * the rail and the body each read them on mount, and both live in Curate, so on
 * a launch straight into Library the "Add to playlist" submenu offered "New
 * playlist…" and nothing else — against a library that had three. The list is
 * not Curate's; Curate is just where it was first drawn.
 */
onMounted(() => {
  roots.start()
  void playlists.refresh()
  // After hydration, not before: until `settings.getAll` lands the surface
  // holds the done-key's default (`false`) and would open the wizard on every
  // launch, including upgrades main has already backfilled.
  void maybeOpenOnboardingWizard({
    ready: settings.ready,
    get: settings.get,
    openWizard: onboarding.openWizard
  })
})

onUnmounted(() => {
  roots.stop()
  playback.dispose()
})
</script>

<template>
  <main class="grid h-screen overflow-hidden bg-default text-default" :class="gridRows">
    <AppTitleBar v-if="!zen.active" />

    <ShellTabs v-if="tabNavBar && !zen.active" />

    <div class="flex min-h-0 min-w-0 overflow-hidden">
      <!--
        Sidebar and body are nested one level in so that the deck is outside
        them. That is not tidiness: `PaneResizer` measures its own parent, so
        the sidebar's handle now measures a row the deck has already been taken
        out of, and `SIDEBAR_PANE.reserve` stays exactly the body's wide-mode
        `min-w-90` instead of having to grow and shrink with a pane it knows
        nothing about.
        A static reserve that had to account for the deck would be wrong in one
        of the two states whichever number it held.
      -->
      <div
        ref="regionRef"
        class="flex min-h-0 min-w-0 flex-1 overflow-hidden"
        :class="compactSidebar ? 'flex-col' : 'flex-row'"
      >
        <!--
          Wide: the rail as a left column, its width dragged and animated as
          before. The cover pane rides inside `ShellSidebar` here and only here.
        -->
        <template v-if="!compactSidebar">
          <div
            class="shell-sidebar min-h-0 overflow-hidden bg-default"
            :style="{ width: hasSidebar ? `${sidebarWidth}px` : '0px' }"
            :data-resizing="resizing || undefined"
            :inert="hasSidebar ? undefined : true"
          >
            <!--
              The inner width is the full one whatever the outer is animating
              towards. Without it the sidebar's contents would reflow through every
              frame of the collapse — a virtualized facet list re-measuring itself
              320 times on the way to zero — instead of being clipped by a container
              that is closing over them.
            -->
            <div class="h-full min-h-0" :style="{ width: `${sidebarWidth}px` }">
              <ShellSidebar>
                <RouterView v-slot="{ Component }" name="sidebar">
                  <Transition name="tab-fade" mode="out-in">
                    <component :is="Component" v-if="Component" :key="shell.activeTab" />
                  </Transition>
                </RouterView>
              </ShellSidebar>
            </div>
          </div>

          <PaneResizer
            v-if="hasSidebar"
            v-model:size="sidebarWidth"
            :pane="SIDEBAR_PANE"
            @dragging="resizing = $event"
          />
        </template>

        <!--
          Compact: the same routed rail, reflowed into a fixed-height band above
          the body (§2). `layout="band"` is what asks each rail to lay its sections
          side by side; the cover pane is deliberately absent here, which is the
          "auto close" the narrow layout wants. Only one `RouterView name="sidebar"`
          is mounted at a time — this branch or the column above — so crossing the
          breakpoint remounts the rail (it reads from stores) but never the body,
          which is a stable sibling of both branches below.
        -->
        <div
          v-else
          class="shell-band shrink-0 overflow-hidden bg-default"
          :style="{ height: `${bandHeight}px` }"
        >
          <RouterView v-slot="{ Component }" name="sidebar">
            <component :is="Component" v-if="Component" :key="shell.activeTab" layout="band" />
          </RouterView>
        </div>

        <!--
          The band's own edge, the vertical twin of the sidebar's. Drawn only in
          the reflowed layout, between the band and the body, so the operator sets
          how much of the narrow window the sources keep. Measures the region — its
          parent — for the height it has to divide, exactly as the sidebar handle
          measures it for width.
        -->
        <PaneResizer v-if="compactSidebar" v-model:size="bandHeight" :pane="SHELL_BAND_PANE" />

        <div
          class="relative min-h-0 flex-1 overflow-hidden bg-default"
          :class="compactSidebar ? 'min-w-0' : 'min-w-90'"
        >
          <RouterView v-slot="{ Component }">
            <Transition :name="bodyTransition">
              <component
                :is="Component"
                v-if="Component"
                :key="shell.activeTab"
                class="absolute inset-0"
              />
            </Transition>
          </RouterView>
        </div>
      </div>

      <!--
        The deck, in flow rather than over it (D15).

        `UDrawer` would have been the shorter route and it cannot do this job:
        its content is `fixed` and portalled to the body, so it necessarily
        covers the track list — which is the arrangement D15 considered and
        rejected, on the grounds that a deck you cannot browse alongside is not
        worth the panes it holds. A sibling in the row displaces instead, and
        gets a real resize handle rather than vaul's drag-to-dismiss for free.

        Collapsed to zero width rather than dropped, for the two reasons the
        sidebar is: at zero there is no handle to catch, and animating a width
        is the only way the pane can leave without the body jumping.

        `showing` rather than `open`: the deck describes a track, so it stands
        down when there is not one and comes back on the next play without the
        operator's preference having been touched. The same flag drives all
        three attributes, so there is no state where the handle is draggable
        beside a pane that is not there.
      -->
      <PaneResizer
        v-if="tunedeck.showing"
        v-model:size="tunedeck.width"
        :pane="TUNEDECK_PANE"
        @dragging="deckResizing = $event"
      />

      <div
        class="shell-tunedeck min-h-0 shrink-0 overflow-hidden bg-default"
        :style="{ width: tunedeck.showing ? `${tunedeck.width}px` : '0px' }"
        :data-resizing="deckResizing || undefined"
        :inert="tunedeck.showing ? undefined : true"
      >
        <div class="h-full min-h-0" :style="{ width: `${tunedeck.width}px` }">
          <Tunedeck />
        </div>
      </div>
    </div>

    <!--
      The transport bar — dropped, not merely hidden, whenever the stage carries
      the transport instead: always in Zen, and on the merged Now Playing view.
      The grid loses its row so the stage takes the height. On every other view,
      and with the merge off, the bar is here as it always was.
    -->
    <div v-if="!stageOwnsTransport" class="min-h-0 border-t border-default bg-default">
      <NowPlaying />
    </div>

    <!--
      Mounted with the frame, like the title bar and the transport, and for the
      same reason: the gesture that opens it is made in the sidebar, which a tab
      change unmounts. It draws nothing until something asks it to.
    -->
    <NewPlaylistModal />

    <!--
      Track Info, mounted with the frame for the same reason: it is opened by a
      right-click in a list or on a card, both of which a tab change unmounts.
    -->
    <TrackInfoModal />

    <!-- The metadata editor (W16), mounted with the frame for TrackInfoModal's reason. -->
    <TrackMetadataEditor />

    <!--
      The command palette, mounted with the frame for the reason the playlist
      modal is: Ctrl/Cmd+K and the title-bar box both open it from outside any
      one tab, so it cannot live under a route that a tab change unmounts.
    -->
    <CommandPalette />

    <!--
      First-run setup, mounted with the frame for the same reason the playlist
      modal is: the launch gate and a later Settings re-run both open it from
      outside any one tab.
    -->
    <OnboardingModal />
  </main>
</template>

<style scoped>
/*
 * The collapse, and only the collapse.
 *
 * A drag has to be exempt rather than merely brief: an interrupted transition
 * does not snap to its new target, it re-eases towards it, so every pointermove
 * restarts a 200ms interpolation and the edge trails the cursor for as long as
 * the drag lasts. `data-resizing` is the handle saying it has the width for
 * now.
 */
.shell-sidebar,
.shell-tunedeck {
  transition: width 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.shell-sidebar[data-resizing],
.shell-tunedeck[data-resizing] {
  transition: none;
}

/*
 * Tabs cross-fade with a few pixels of travel in the direction the row moved.
 * Small on purpose: these are panes of one window, and a slide long enough to
 * read as navigation would be claiming something about the application that is
 * not true.
 */
.tab-forward-enter-active,
.tab-forward-leave-active,
.tab-back-enter-active,
.tab-back-leave-active,
.tab-fade-enter-active,
.tab-fade-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

/*
 * Both views are `absolute inset-0` inside a `relative` body, which is what
 * lets them overlap for the length of the cross-fade instead of the outgoing
 * one collapsing the layout as it leaves. It does mean a tab's view has to have
 * a single root element — every one of them does, and a fragment would lose the
 * transition silently rather than break.
 */
.tab-forward-enter-from {
  opacity: 0;
  transform: translateX(1.5rem);
}

.tab-forward-leave-to {
  opacity: 0;
  transform: translateX(-1.5rem);
}

.tab-back-enter-from {
  opacity: 0;
  transform: translateX(-1.5rem);
}

.tab-back-leave-to {
  opacity: 0;
  transform: translateX(1.5rem);
}

/*
 * The sidebar fades without travel, and out before in. It is inside a container
 * that is changing width at the same time, so a horizontal slide would be two
 * horizontal movements disagreeing about the same edge.
 */
.tab-fade-enter-from,
.tab-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .shell-sidebar,
  .shell-tunedeck,
  .tab-forward-enter-active,
  .tab-forward-leave-active,
  .tab-back-enter-active,
  .tab-back-leave-active,
  .tab-fade-enter-active,
  .tab-fade-leave-active {
    transition-duration: 0ms;
  }

  .tab-forward-enter-from,
  .tab-forward-leave-to,
  .tab-back-enter-from,
  .tab-back-leave-to {
    transform: none;
  }
}
</style>
