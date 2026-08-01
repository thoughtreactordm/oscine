import { describe, expect, it } from 'vitest'
import {
  clampPaneSize,
  draggedPaneSize,
  paneCeiling
} from '../../../src/renderer/shell/paneResizer'
import { SIDEBAR_PANE } from '../../../src/renderer/shell/shellLayout'
import {
  createTunedeckRegistry,
  TUNEDECK_PANE,
  type TunedeckPane
} from '../../../src/renderer/panels/tunedeck/tunedeckPanes'

/**
 * The registry's rules and the deck's bounds — the two parts of W7-1 that can
 * be wrong without a DOM.
 *
 * Nothing here imports a `.vue` file, and it cannot: Vitest runs under plain
 * Node with no Vue plugin. That constraint is why `tunedeckPanes.ts` and
 * `panes.ts` are two files rather than one, and holding the split from the test
 * side is what stops them being merged back later.
 */

/** A pane whose component is a stand-in — the registry never renders one. */
function pane(id: string, title = id): TunedeckPane {
  return { id, title, icon: 'i-tabler-circle', component: {} }
}

describe('the pane registry', () => {
  it('keeps the order it was given', () => {
    // The deck stacks them top to bottom, so the list is the arrangement. A
    // registry that sorted by id would be inventing one.
    const registry = createTunedeckRegistry([pane('queue'), pane('signal'), pane('history')])
    expect(registry.panes.map((entry) => entry.id)).toEqual(['queue', 'signal', 'history'])
  })

  it('finds a pane by id', () => {
    const registry = createTunedeckRegistry([pane('queue'), pane('signal')])
    expect(registry.byId('signal')?.title).toBe('signal')
    expect(registry.byId('nexus')).toBeUndefined()
  })

  it('refuses two panes with the same id', () => {
    // Two files disagreeing about who owns a name. Left alone it surfaces much
    // later, as one pane's stored arrangement applied to the other.
    expect(() => createTunedeckRegistry([pane('queue'), pane('queue', 'Up next')])).toThrow(
      /duplicate tunedeck pane id: queue/
    )
  })

  it('refuses a pane with no id', () => {
    expect(() => createTunedeckRegistry([pane('  ')])).toThrow(/no id/)
  })

  it('does not hand out a list the caller can add to', () => {
    // The seam is `panes.ts`. A registry that could be appended to at runtime
    // would be a second way in, and the one that survives a bundler dropping a
    // side-effect import is the static list.
    const registry = createTunedeckRegistry([pane('queue')])
    expect(() => (registry.panes as TunedeckPane[]).push(pane('signal'))).toThrow()
  })

  it('accepts an empty deck', () => {
    expect(createTunedeckRegistry([]).panes).toEqual([])
  })
})

describe('the deck s width', () => {
  it('opens at a width that is a companion rather than a second body', () => {
    expect(TUNEDECK_PANE.defaultSize).toBe(380)
    expect(clampPaneSize(TUNEDECK_PANE, TUNEDECK_PANE.defaultSize, 1600)).toBe(380)
  })

  it('is clamped to its stated bounds whatever the drag asks for', () => {
    expect(clampPaneSize(TUNEDECK_PANE, 40, 1600)).toBe(280)
    expect(clampPaneSize(TUNEDECK_PANE, 4000, 1600)).toBe(640)
  })

  it('leaves the sidebar and the body their minimums on a wide window', () => {
    // 1600 less the deck's ceiling is 960, which is the sidebar's 240 and the
    // body's 480 with room to spare.
    expect(paneCeiling(TUNEDECK_PANE, 1600)).toBe(640)
    expect(1600 - paneCeiling(TUNEDECK_PANE, 1600)).toBeGreaterThanOrEqual(SIDEBAR_PANE.min + 480)
  })

  it('counts the two hairline handles, so a pushed pane is never thinner than a dragged one', () => {
    // Where the reserve actually bites. On the 1261px row this was measured
    // against, a reserve of 720 stopped the deck at 541 and left the sidebar at
    // 238 — two pixels below the minimum its own handle refuses to cross, which
    // would make "pushed by the deck" a way round "dragged by the operator".
    const row = 1261
    const deck = paneCeiling(TUNEDECK_PANE, row)
    expect(deck).toBe(539)
    // Two hairlines: sidebar-to-body, and body-to-deck.
    expect(row - deck - 2 - 480).toBe(SIDEBAR_PANE.min)
  })

  it('gives way to the reserve before it gives way to its own minimum', () => {
    // The window's `minWidth` is 940, which cannot hold all three panes at their
    // minimums. `paneCeiling` breaks the reserve rather than the deck, and the
    // sidebar — which has no CSS minimum of its own — absorbs it. A deck below
    // 280 would be a column of clipped headings.
    expect(paneCeiling(TUNEDECK_PANE, 940)).toBe(280)
    expect(clampPaneSize(TUNEDECK_PANE, 600, 940)).toBe(280)
  })

  it('grows when the drag moves left, unlike every other pane in the frame', () => {
    // `side: 'after'` is the whole difference. Getting it backwards is a deck
    // that shrinks when you pull it open, and nothing else in the app would
    // have caught it: the other two panes sit before their handles.
    const drag = { startSize: 380, startPosition: 1000, containerPx: 1600 }
    expect(draggedPaneSize(TUNEDECK_PANE, { ...drag, position: 900 })).toBe(480)
    expect(draggedPaneSize(TUNEDECK_PANE, { ...drag, position: 1100 })).toBe(280)
  })

  it('does not collide with the frame s own pane keys', () => {
    // One flat record holds every pane's size. A key reused across two panes is
    // two panes sharing one number.
    expect(TUNEDECK_PANE.key).not.toBe(SIDEBAR_PANE.key)
    expect(TUNEDECK_PANE.key).toBe('tunedeck.deck')
  })
})
