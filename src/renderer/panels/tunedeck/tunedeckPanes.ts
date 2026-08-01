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
 * One pane, as the deck needs to know it.
 *
 * Deliberately four fields and no slot for behaviour. A pane that needed the
 * shell to do something for it would be a pane the shell has to know about,
 * and the acceptance criterion for this card is that adding one touches no file
 * that arranges panes. Everything a pane does, it does inside its own component
 * against its own stores.
 */
export interface TunedeckPane {
  /** Stable across builds: it will key a stored arrangement once there is one. */
  readonly id: string
  /** The section heading, and the accessible name of the section. */
  readonly title: string
  /** An icon name, resolved by the icon component rather than by this module. */
  readonly icon: string
  readonly component: Component
}

export interface TunedeckRegistry {
  /** In the order the deck stacks them. */
  readonly panes: readonly TunedeckPane[]
  byId(id: string): TunedeckPane | undefined
}

/**
 * The pane list, checked once.
 *
 * Throws rather than dropping a bad entry, and throws at import time because
 * that is when the list is built. A duplicate id is not a condition the app can
 * be in — it is two files disagreeing about who owns a name, and the failure it
 * would otherwise cause arrives much later, as a pane whose stored state
 * belongs to a different pane. Loud and immediate is the cheaper of the two.
 */
export function createTunedeckRegistry(panes: readonly TunedeckPane[]): TunedeckRegistry {
  const byId = new Map<string, TunedeckPane>()
  for (const pane of panes) {
    if (!pane.id.trim()) throw new RangeError('tunedeck pane has no id')
    if (byId.has(pane.id)) throw new RangeError(`duplicate tunedeck pane id: ${pane.id}`)
    byId.set(pane.id, pane)
  }

  const ordered = Object.freeze([...panes])
  return {
    panes: ordered,
    byId: (id) => byId.get(id)
  }
}
