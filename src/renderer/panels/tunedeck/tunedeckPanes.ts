import type { Component } from 'vue'
import type { PaneSpec } from '../../shell/paneResizer'

/**
 * The Tunedeck's two contracts: how wide it is, and what may sit inside it.
 *
 * Both are here rather than in `shell/shellLayout.ts`, where the frame's own
 * pane specs live, because D15 says the drawer is the deck's *first* host and
 * not its home. A dock host that adopts the deck later needs the width bounds
 * and the pane list and nothing else; keeping them with the thing they describe
 * is what makes that a move rather than a rewrite. `SOURCES_ARTISTS_PANE` sits
 * in the shell module because the Sources panel is the sidebar's permanent
 * occupant — the deck is the one island that is expected to be reparented.
 *
 * No `@renderer` alias and no DOM type, for the reason stated at the top of
 * `paneResizer.ts`: `tests/` compiles under `tsconfig.node.json`, which maps
 * neither, and the registry's rules are exactly the part worth testing without
 * a DOM.
 */

/** Whether the deck is showing. One boolean, this machine only. */
export const TUNEDECK_OPEN_KEY = 'view.tunedeckOpen'

/** Which tab is selected. One id, resolved against the registry on read. */
export const TUNEDECK_TAB_KEY = 'view.tunedeckTab'

/**
 * The open group per tab, as a `{ [tabId]: groupId }` record.
 *
 * Per tab rather than one global id, because the deck is four separate
 * questions and returning to a tab should return to the answer you left open in
 * it. One id would mean every tab switch also collapsed the group you were
 * reading, which is the thing that makes a tabbed pane feel like it forgot you.
 */
export const TUNEDECK_GROUPS_KEY = 'view.tunedeckGroups'

/**
 * The deck's width.
 *
 * `after`, unlike every other pane in the app: the deck sits to the right of
 * its handle, so the drag that grows it moves left and the sign of the delta
 * flips. That is the whole reason `ResizeSide` exists.
 *
 * `reserve` is the sidebar's minimum plus the body's `min-w-120` plus the two
 * hairline handles between the three — 240 + 480 + 2 — rather than the body's
 * alone, because the deck's handle measures the outer row and everything else
 * is inside it. The two pixels are not pedantry: without them the drag stops
 * where the sidebar has been squeezed to 238, which is below the minimum the
 * sidebar's own handle refuses to cross, and a pane can then be narrower by
 * being pushed than it can by being dragged. Measured on the built app.
 *
 * Nothing re-clamps when the *window* shrinks, so a deck opened wide on a wide
 * window will still squeeze the sidebar past its minimum if the window is
 * dragged narrow afterwards. That is the sidebar's existing behaviour rather
 * than something the deck introduces, it recovers the moment either pane is
 * touched, and the row is `overflow-hidden` so it cannot become a scrollbar.
 *
 * The 640 ceiling is not a container limit. A deck wider than that stops being
 * a companion to the library and becomes a second body, and the panes D15 lists
 * — a queue, a signal readout, a history — are all lists of short rows that
 * gain nothing from the space.
 */
export const TUNEDECK_PANE: PaneSpec = {
  key: 'tunedeck.deck',
  axis: 'x',
  side: 'after',
  label: 'Tunedeck width',
  defaultSize: 380,
  min: 280,
  max: 640,
  reserve: 722
}

/**
 * One collapsible group, as the deck needs to know it.
 *
 * A group is what a pane used to be: a title, an icon and a component that
 * knows how to draw itself against its own stores. The deck gained a level
 * above this — tabs — because four panes in one scroll was four unrelated
 * questions answered at once, and stacking is not an arrangement.
 *
 * `badge` is the first addition, and it is a *read* rather than a slot for
 * behaviour. A collapsed group with no number on it is a closed box: the whole
 * value of collapsing "Up next" is lost if you then cannot tell whether there
 * is anything in it without opening it. It is a thunk rather than a value
 * because it is called during render, which is the only time a Pinia store is
 * safe to reach for from a module that is imported at startup.
 *
 * `hint` is the second. It is where the standing footnotes went: one sentence,
 * on the header, behind a tooltip, instead of a permanent line of grey text
 * under every list.
 *
 * `action` is the third and the only one that is not a read — see below for why
 * it is capped at one.
 */
/**
 * The one verb a group may put on its own header.
 *
 * "Clear" was a full-width row above the list holding a single right-aligned
 * button — a 28px band of empty space, in a column where the accordion exists
 * to buy vertical space back. The header already runs the width of the deck and
 * already carries two other affordances, so the button costs nothing there.
 *
 * Icon and tooltip rather than a label, matching the info button beside it: a
 * word competing with the group title for the same row is a second heading.
 *
 * Deliberately narrow. It is one action, not a menu — a group needing two is a
 * group whose pane should draw its own toolbar, and this staying singular is
 * what keeps the header from becoming one.
 */
export interface TunedeckGroupAction {
  /** The tooltip, and the button's accessible name. */
  readonly label: string
  readonly icon: string
  /**
   * Whether there is anything to act on. False hides the button outright rather
   * than disabling it, which is what the inline row's `v-if` did: a permanently
   * greyed Clear on an empty trail is a control advertising a state you are
   * already in.
   */
  readonly available: () => boolean
  readonly run: () => void
}

export interface TunedeckGroup {
  /** Unique across the whole deck, not just its tab: it keys the open-group record. */
  readonly id: string
  /** The group heading, and the accessible name of its region. */
  readonly title: string
  /** An icon name, resolved by the icon component rather than by this module. */
  readonly icon: string
  /** What is inside, when it is shut. `null` for "nothing worth counting". */
  readonly badge?: () => string | null
  /** The caveat this group carries, if it carries one. Rendered as a tooltip. */
  readonly hint?: string
  /** The one thing this group can be told to do from its header. */
  readonly action?: TunedeckGroupAction
  readonly component: Component
}

/**
 * One tab: a question the deck answers, and the groups that answer it.
 *
 * Four of them, and the split is by *subject* rather than by feature: who made
 * this, what is this file, what else is like it, and what is happening. A tab
 * with no groups is rejected rather than rendered — it would be a heading that
 * opens onto nothing, which is exactly the state an "arrives later" placeholder
 * tab would have shipped in.
 */
export interface TunedeckTab {
  /** Stable across builds: it keys the selected tab. */
  readonly id: string
  readonly title: string
  readonly icon: string
  readonly groups: readonly TunedeckGroup[]
}

export interface TunedeckRegistry {
  /** In the order the deck shows them, left to right. */
  readonly tabs: readonly TunedeckTab[]
  tabById(id: string): TunedeckTab | undefined
  groupById(id: string): TunedeckGroup | undefined
}

/**
 * The tab list, checked once.
 *
 * Throws rather than dropping a bad entry, and throws at import time because
 * that is when the list is built. A duplicate id is not a condition the app can
 * be in — it is two files disagreeing about who owns a name, and the failure it
 * would otherwise cause arrives much later, as one group's stored open-state
 * applied to another. Loud and immediate is the cheaper of the two.
 *
 * Group ids are unique across the *deck* rather than within a tab. They are
 * keys in one flat persisted record, and two tabs each owning a group called
 * `format` would be two groups sharing one boolean.
 */
export function createTunedeckRegistry(tabs: readonly TunedeckTab[]): TunedeckRegistry {
  const tabsById = new Map<string, TunedeckTab>()
  const groupsById = new Map<string, TunedeckGroup>()

  // Frozen first, indexed second, so that every way of reaching a tab hands
  // back the same immutable object. Indexing the arguments and freezing copies
  // would give `tabs[0]` and `tabById(id)` different objects, one of which the
  // caller could still append a group to.
  const ordered = Object.freeze(
    tabs.map((tab) => Object.freeze({ ...tab, groups: Object.freeze([...tab.groups]) }))
  )

  for (const tab of ordered) {
    if (!tab.id.trim()) throw new RangeError('tunedeck tab has no id')
    if (tabsById.has(tab.id)) throw new RangeError(`duplicate tunedeck tab id: ${tab.id}`)
    if (tab.groups.length === 0) throw new RangeError(`tunedeck tab has no groups: ${tab.id}`)
    tabsById.set(tab.id, tab)

    for (const group of tab.groups) {
      if (!group.id.trim()) throw new RangeError('tunedeck group has no id')
      if (groupsById.has(group.id)) throw new RangeError(`duplicate tunedeck group id: ${group.id}`)
      groupsById.set(group.id, group)
    }
  }

  return {
    tabs: ordered,
    tabById: (id) => tabsById.get(id),
    groupById: (id) => groupsById.get(id)
  }
}

/**
 * The selected tab, given whatever was persisted.
 *
 * Persisted ids outlive the code that named them: a tab renamed or removed in a
 * later build leaves a stored id pointing at nothing, and a deck that honoured
 * it would open on a blank panel with no tab highlighted and no way back except
 * clearing settings. Falling forward to the first tab is the only behaviour
 * that cannot strand someone.
 */
export function resolveTabId(registry: TunedeckRegistry, stored: unknown): string {
  if (typeof stored === 'string' && registry.tabById(stored) !== undefined) return stored
  return registry.tabs[0]?.id ?? ''
}

/**
 * The open group within a tab, given whatever was persisted for it.
 *
 * Defaults to the tab's first group rather than to nothing, because "strict
 * accordion" and "everything shut" look identical on arrival — a tab that opens
 * onto four collapsed headings has answered no question at all. Every tab
 * therefore always has exactly one group open, which is also what makes the
 * chevron the only affordance needed: clicking the open one does nothing rather
 * than closing it.
 */
export function resolveGroupId(tab: TunedeckTab, stored: unknown): string {
  if (typeof stored === 'string' && tab.groups.some((group) => group.id === stored)) return stored
  return tab.groups[0]?.id ?? ''
}
