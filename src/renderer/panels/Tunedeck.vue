<script setup lang="ts">
import { useDeckData } from '@renderer/panels/tunedeck/deckData'
import { tunedeckRegistry } from '@renderer/panels/tunedeck/panes'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * The Tunedeck: a panel island that arranges tabs and groups and knows nothing
 * else.
 *
 * D15 calls this "an extended control and information surface opened from
 * NowPlaying", and the temptation is to build it *as* an extension of
 * NowPlaying — reaching into the playback store for a queue, into the track
 * list for a selection. It imports neither, and neither imports it. The only
 * thing crossing the boundary is a boolean in `stores/tunedeck`, which is the
 * same arrangement the sidebar's cover toggle uses.
 *
 * Nothing here is drawer-shaped. There is no scrim, no dismiss gesture, no
 * fixed positioning and no width: the host decides where this sits and how big
 * it is, and this fills what it is given. That is what makes the promotion to a
 * dock pane a change of parent rather than a rewrite, which is the whole reason
 * D4 puts the content in an island in the first place.
 *
 * ## Tabs over a stack
 *
 * The deck used to render every registered pane in one scrolling column. Four
 * cards' worth of panes later that was 380 pixels wide and several screens
 * tall, answering four unrelated questions at once and separating them with
 * nothing stronger than a hairline. Tabs put one subject on screen at a time;
 * the strict accordion inside a tab puts one *part* of that subject on screen
 * at a time, which is what pays for the tab bar's own height.
 *
 * The arrangement still comes from the registry rather than from markup here. A
 * new group is a component plus a line in `tunedeck/panes.ts`; this file does
 * not change, and that is the seam W7-1 exists to prove.
 *
 * ## What the shell draws and what it does not
 *
 * Headers, chevrons, badges and tooltips are the shell's — they are the same
 * three widgets in eight places, and a group that drew its own would be eight
 * chances to disagree about a border. Everything below a header is the group's
 * own component against its own stores. The shell reads `badge()` and `hint`
 * and understands neither.
 */

const tunedeck = useTunedeckStore()

// The deck's shared stores, kept current while it is open. Here rather than in
// the panes because a shut group's badge is read from a store the shut group
// would otherwise have been the one to fill. See `deckData.ts`.
useDeckData()

function isOpen(groupId: string): boolean {
  const tab = tunedeck.activeTab
  return tab !== undefined && tunedeck.openGroupId(tab) === groupId
}
</script>

<template>
  <UCard
    as="aside"
    variant="soft"
    class="h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'flex h-full min-h-0 flex-col p-0 sm:p-0' }"
    aria-label="Tunedeck"
  >
    <header class="flex shrink-0 items-center gap-2 border-b border-default px-3 py-2">
      <UIcon name="i-tabler-device-audio-tape" class="size-4 shrink-0 text-muted" />
      <h2 class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">Tunedeck</h2>
      <UTooltip text="Close Tunedeck">
        <UButton
          variant="ghost"
          size="xs"
          icon="i-tabler-x"
          square
          aria-label="Close Tunedeck"
          @click="tunedeck.close()"
        />
      </UTooltip>
    </header>

    <!--
      The accordion column. Shut headers are `shrink-0` and the open region
      takes the rest, so a virtualized list inside a group is given a definite
      height to resolve against rather than falling back to its own ceiling —
      which is the difference between a queue that scrolls inside its group and
      one that scrolls the whole deck.
    -->
    <div
      class="flex min-h-0 flex-1 flex-col"
      role="tabpanel"
      :aria-label="tunedeck.activeTab?.title"
    >
      <!--
        The tab's standing strip, above every group and outside the accordion.
        Only the Artist tab declares one; the shell neither knows nor cares what
        is in it, which is the same arrangement it has with `badge` and `hint`.
      -->
      <component :is="tunedeck.activeTab.header" v-if="tunedeck.activeTab?.header" />

      <section
        v-for="group in tunedeck.activeTab?.groups ?? []"
        :key="group.id"
        class="flex min-h-0 flex-col border-b border-default last:border-b-0"
        :class="isOpen(group.id) ? 'flex-1' : 'shrink-0'"
      >
        <h3 class="flex shrink-0 items-center">
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-default items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-elevated/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
            :aria-expanded="isOpen(group.id)"
            :aria-controls="`tunedeck-group-${group.id}`"
            @click="tunedeck.openGroup(tunedeck.activeTabId, group.id)"
          >
            <UIcon
              name="i-tabler-chevron-right"
              class="size-3.5 shrink-0 text-dimmed transition-transform"
              :class="isOpen(group.id) ? 'rotate-90' : ''"
              aria-hidden="true"
            />
            <UIcon
              :name="group.icon"
              class="size-3.5 shrink-0"
              :class="isOpen(group.id) ? 'text-primary' : 'text-dimmed'"
              aria-hidden="true"
            />
            <span
              class="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide"
              :class="isOpen(group.id) ? 'text-highlighted' : 'text-muted'"
            >
              {{ group.title }}
            </span>
            <!--
              What is inside, while it is shut. Without this the accordion trades
              a wall of information for a row of closed doors, and deciding which
              to open means opening all of them.
            -->
            <UBadge
              v-if="group.badge?.()"
              :label="group.badge()!"
              size="sm"
              color="neutral"
              variant="subtle"
              class="shrink-0 tabular-nums"
            />
          </button>

          <!--
            The group's one verb, for the same reason as the tooltip below it:
            a button nested inside the toggle would fire the collapse too.
            Before the hint rather than after, so that the info button keeps one
            position across all eight headers — it is the affordance that is
            always in the same place, and an action appearing to its right would
            move it on two groups out of eight.
          -->
          <UTooltip v-if="group.action?.available()" :text="group.action.label">
            <UButton
              variant="ghost"
              size="xs"
              :icon="group.action.icon"
              square
              class="mr-2 shrink-0 text-dimmed"
              :aria-label="group.action.label"
              @click="group.action.run()"
            />
          </UTooltip>

          <!--
            Where the standing footnotes went. A sibling of the button rather
            than a child of it: a tooltip trigger nested inside a toggle is one
            control with two meanings, and hovering to read the caveat would
            look like aiming at the thing that collapses the group.
          -->
          <UTooltip v-if="group.hint" :text="group.hint">
            <UButton
              variant="ghost"
              size="xs"
              icon="i-tabler-info-circle"
              square
              class="mr-2 shrink-0 text-dimmed"
              :aria-label="`About ${group.title}`"
            />
          </UTooltip>
        </h3>

        <div
          v-if="isOpen(group.id)"
          :id="`tunedeck-group-${group.id}`"
          class="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        >
          <component :is="group.component" />
        </div>
      </section>
    </div>

    <!--
      The tab bar sits below the panel, not above it. Two reasons, one of them
      the deck's own shape: it is a tall narrow column whose header is already at
      the top, and a second horizontal band under the first turns the top eighth
      of the panel into chrome. At the bottom it lands where the transport
      controls are, which is where the pointer already is.
    -->

    <!--
      Icon over label rather than beside it. The deck's minimum is 280px, which
      is 70 per tab: "Related" beside a 14px icon does not fit that at a legible
      size, and a tab bar that truncates its own labels is a tab bar you have to
      learn by position. Stacked, the label has the full 70 to itself.
    -->
    <nav
      class="flex shrink-0 items-stretch border-t border-default"
      role="tablist"
      aria-label="Tunedeck sections"
    >
      <button
        v-for="tab in tunedeckRegistry.tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="tab.id === tunedeck.activeTabId"
        :tabindex="tab.id === tunedeck.activeTabId ? 0 : -1"
        class="flex min-w-0 flex-1 cursor-default flex-col items-center gap-0.5 border-t-2 px-1 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
        :class="
          tab.id === tunedeck.activeTabId
            ? 'border-primary text-primary'
            : 'border-transparent text-dimmed hover:bg-elevated/60 hover:text-muted'
        "
        @click="tunedeck.selectTab(tab.id)"
      >
        <UIcon :name="tab.icon" class="size-4 shrink-0" aria-hidden="true" />
        <span class="min-w-0 max-w-full truncate text-[11px] font-medium leading-tight">
          {{ tab.title }}
        </span>
      </button>
    </nav>
  </UCard>
</template>
