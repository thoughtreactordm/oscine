import { describe, expect, it } from 'vitest'
import {
  clampPaneSize,
  draggedPaneSize,
  paneCeiling
} from '../../../src/renderer/shell/paneResizer'
import { SIDEBAR_PANE } from '../../../src/renderer/shell/shellLayout'
import {
  createTunedeckRegistry,
  isGroupOpen,
  resolveTabId,
  TUNEDECK_GROUPS_KEY,
  TUNEDECK_OPEN_KEY,
  TUNEDECK_PANE,
  TUNEDECK_TAB_KEY,
  type TunedeckGroup,
  type TunedeckTab
} from '../../../src/renderer/panels/tunedeck/tunedeckPanes'
import { settingsInScope } from '../../../src/shared/settings'

/**
 * The registry's rules, the tab and group resolvers, and the deck's bounds —
 * the parts of W7-1 that can be wrong without a DOM.
 *
 * Nothing here imports a `.vue` file, and it cannot: Vitest runs under plain
 * Node with no Vue plugin. That constraint is why `tunedeckPanes.ts` and
 * `panes.ts` are two files rather than one, and holding the split from the test
 * side is what stops them being merged back later.
 */

/** A group whose component is a stand-in — the registry never renders one. */
function group(id: string, title = id): TunedeckGroup {
  return { id, title, icon: 'i-tabler-circle', component: {} }
}

function tab(id: string, groups: readonly TunedeckGroup[] = [group(`${id}-only`)]): TunedeckTab {
  return { id, title: id, icon: 'i-tabler-circle', groups }
}

describe('the tab registry', () => {
  it('keeps the order it was given', () => {
    // The deck shows them left to right, so the list is the arrangement. A
    // registry that sorted by id would be inventing one.
    const registry = createTunedeckRegistry([tab('artist'), tab('track'), tab('playing')])
    expect(registry.tabs.map((entry) => entry.id)).toEqual(['artist', 'track', 'playing'])
  })

  it('finds a tab and a group by id', () => {
    const registry = createTunedeckRegistry([tab('track', [group('format'), group('decode')])])
    expect(registry.tabById('track')?.groups).toHaveLength(2)
    expect(registry.groupById('decode')?.title).toBe('decode')
    expect(registry.tabById('nexus')).toBeUndefined()
    expect(registry.groupById('nexus')).toBeUndefined()
  })

  it('refuses two tabs with the same id', () => {
    expect(() => createTunedeckRegistry([tab('track'), tab('track')])).toThrow(
      /duplicate tunedeck tab id: track/
    )
  })

  it('refuses two groups with the same id even in different tabs', () => {
    // Group ids key one flat persisted record of what is open. Scoping the
    // uniqueness check to a tab would let two tabs share one boolean, which
    // surfaces later as opening a group in one tab opening it in the other.
    expect(() =>
      createTunedeckRegistry([tab('track', [group('format')]), tab('related', [group('format')])])
    ).toThrow(/duplicate tunedeck group id: format/)
  })

  it('refuses a tab with no groups', () => {
    // A heading that opens onto nothing. This is the check that would have
    // caught an "arrives in M7" placeholder tab shipping empty.
    expect(() => createTunedeckRegistry([tab('artist', [])])).toThrow(
      /tunedeck tab has no groups: artist/
    )
  })

  it('refuses a tab or a group with no id', () => {
    expect(() => createTunedeckRegistry([tab('  ')])).toThrow(/tunedeck tab has no id/)
    expect(() => createTunedeckRegistry([tab('track', [group('  ')])])).toThrow(
      /tunedeck group has no id/
    )
  })

  it('carries a group s header action through, callable', () => {
    // The freeze in `createTunedeckRegistry` is shallow on purpose. A copy that
    // spread the action into a new object would hand the header two functions
    // closed over nothing, and the button would render and do nothing — the
    // failure this catches is silent in the app.
    let cleared = 0
    const trail: TunedeckGroup = {
      ...group('trail'),
      action: {
        label: 'Clear the trail',
        icon: 'i-tabler-eraser',
        available: () => true,
        run: () => {
          cleared += 1
        }
      }
    }
    const found = createTunedeckRegistry([tab('playing', [trail])]).groupById('trail')
    expect(found?.action?.label).toBe('Clear the trail')
    expect(found?.action?.available()).toBe(true)
    found?.action?.run()
    expect(cleared).toBe(1)
  })

  it('leaves a group with no action without one', () => {
    // Seven of the eight headers draw no button at all, and the shell decides
    // that by asking `action?.available()`. An action defaulted to a no-op
    // would put a dead control on every one of them.
    expect(createTunedeckRegistry([tab('track')]).groupById('track-only')?.action).toBeUndefined()
  })

  it('does not hand out a list the caller can add to', () => {
    // The seam is `panes.ts`. A registry that could be appended to at runtime
    // would be a second way in, and the one that survives a bundler dropping a
    // side-effect import is the static list.
    const registry = createTunedeckRegistry([tab('track')])
    expect(() => (registry.tabs as TunedeckTab[]).push(tab('related'))).toThrow()
    expect(() => (registry.tabs[0]!.groups as TunedeckGroup[]).push(group('extra'))).toThrow()
  })

  it('accepts an empty deck', () => {
    expect(createTunedeckRegistry([]).tabs).toEqual([])
  })
})

describe('the deck s view settings', () => {
  it('registers every key the deck stores', () => {
    // `createViewSettings` throws `unknown view setting` for a key with no
    // descriptor, and it throws inside a Pinia store setup — which surfaces as
    // the entire app failing to mount, with the real cause only visible in the
    // renderer console. Nothing else in the suite reaches the registry through
    // the deck, so without this the two halves can be added separately and the
    // first launch is a blank window.
    const registered = new Set(settingsInScope('view').map((entry) => entry.key))
    for (const key of [TUNEDECK_OPEN_KEY, TUNEDECK_TAB_KEY, TUNEDECK_GROUPS_KEY]) {
      expect(registered).toContain(key)
    }
  })
})

describe('resolving what was persisted', () => {
  const registry = createTunedeckRegistry([
    tab('artist'),
    tab('track', [group('format'), group('decode')])
  ])

  it('honours a stored tab id that still exists', () => {
    expect(resolveTabId(registry, 'track')).toBe('track')
  })

  it('falls forward when a stored tab id no longer names anything', () => {
    // Settings outlive the build that wrote them. A deck that honoured a
    // retired id would open on a blank panel with no tab lit and no way back
    // except clearing settings.
    expect(resolveTabId(registry, 'nexus')).toBe('artist')
  })

  it('falls forward on anything that is not a string', () => {
    for (const stored of [undefined, null, 42, {}, []]) {
      expect(resolveTabId(registry, stored)).toBe('artist')
    }
  })

  it('reveals every group in a tab until one is shut', () => {
    // The deck's arrival state, and the thing a record of *open* groups could
    // not express: nothing has been persisted, and everything shows.
    for (const entry of registry.tabs) {
      for (const candidate of entry.groups) {
        expect(isGroupOpen({}, candidate.id)).toBe(true)
      }
    }
  })

  it('honours a group that was shut, and only that group', () => {
    expect(isGroupOpen({ format: false }, 'format')).toBe(false)
    expect(isGroupOpen({ format: false }, 'decode')).toBe(true)
    expect(isGroupOpen({ format: true }, 'format')).toBe(true)
  })

  it('reveals a group the stored record has never heard of', () => {
    // The reason the record holds what is shut. A group added in a later build
    // is absent from every record written before it existed, and the operator
    // who has collapsed something else must not be the one who never sees it.
    expect(isGroupOpen({ format: false }, 'relations')).toBe(true)
  })

  it('reveals everything on anything that is not a record of booleans', () => {
    // `view.tunedeckGroups` is read straight off storage. The strings are not
    // hypothetical: that is the shape the one-open-group build wrote, and it is
    // one downgrade away from being written again.
    for (const stored of [undefined, null, 42, [], 'format', { format: 'decode' }]) {
      expect(isGroupOpen(stored, 'format')).toBe(true)
    }
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
