import { describe, expect, it } from 'vitest'
import { createViewSettings, VIEW_STORAGE_PREFIX } from '../../../src/renderer/settings/viewStore'
import {
  createScrollMemory,
  createShellLayout,
  tabDirection,
  MAX_REMEMBERED_SCROLLS,
  SHELL_PANE_SIZES_KEY,
  SIDEBAR_PANE,
  SOURCES_ARTISTS_PANE
} from '../../../src/renderer/shell/shellLayout'
import { viewSettingsFixture } from '../settings/fixture'

/**
 * The layout is one record in the view store now, so these build a real store
 * over a memory area rather than a bespoke wrapper. What the store validates —
 * that a size is a positive whole number of pixels, that an unknown pane key
 * survives — is tested against the descriptor in `tests/shared/viewSettings`;
 * what is left here is the part only a pane spec can answer.
 */
function shellLayout(paneSizes?: Record<string, unknown>) {
  const fixture = viewSettingsFixture(
    paneSizes === undefined ? {} : { [SHELL_PANE_SIZES_KEY]: paneSizes }
  )
  return { ...fixture, layout: createShellLayout({ settings: fixture.settings }) }
}

function storedSizes(storage: { read(key: string): string | null }): unknown {
  const raw = storage.read(VIEW_STORAGE_PREFIX + SHELL_PANE_SIZES_KEY)
  return raw === null ? null : (JSON.parse(raw) as { value: unknown }).value
}

describe('reading a stored layout', () => {
  it('starts from the defaults when there is nothing stored', () => {
    expect(shellLayout().layout.sizeOf(SIDEBAR_PANE)).toBe(SIDEBAR_PANE.defaultSize)
  })

  it('starts from the defaults when what is stored is not an entry at all', () => {
    const fixture = viewSettingsFixture()
    fixture.storage.write(VIEW_STORAGE_PREFIX + SHELL_PANE_SIZES_KEY, '{ not json')
    const layout = createShellLayout({ settings: fixture.settings })
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(320)
  })

  it('restores a size a previous session dragged', () => {
    expect(shellLayout({ 'shell.sidebar': 412 }).layout.sizeOf(SIDEBAR_PANE)).toBe(412)
  })

  it('holds a stored size inside the pane s bounds at the point of use', () => {
    // Bounds are not applied on read, because the container is not measured
    // then. A layout written by a build with a wider ceiling must still be safe.
    const { layout } = shellLayout({ 'shell.sidebar': 900 })
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(480)
    // On the narrowest allowed window (640), the body's 360 reserve leaves the
    // sidebar 280 — below its own 480 ceiling, so the container is what bites.
    expect(layout.sizeOf(SIDEBAR_PANE, 640)).toBe(280)
  })
})

describe('writing a layout', () => {
  it('persists a clamped size', () => {
    const { layout, storage } = shellLayout()
    layout.setSize(SIDEBAR_PANE, 9000)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(480)
    expect(storedSizes(storage)).toEqual({ 'shell.sidebar': 480 })
  })

  it('does not write when the clamped size has not changed', () => {
    // A drag emits on every pointermove, and the last several of one that ran
    // past the ceiling all resolve to the same number.
    const { layout, storage } = shellLayout()
    layout.setSize(SIDEBAR_PANE, 700)
    layout.setSize(SIDEBAR_PANE, 800)
    layout.setSize(SIDEBAR_PANE, 900)
    expect(storage.writes).toBe(1)
  })

  it('forgets a size on reset rather than storing the default', () => {
    const { layout, storage } = shellLayout()
    layout.setSize(SIDEBAR_PANE, 400)
    layout.resetSize(SIDEBAR_PANE)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(320)
    expect(storedSizes(storage)).toEqual({})
  })

  it('keeps panes apart', () => {
    const { layout } = shellLayout()
    layout.setSize(SIDEBAR_PANE, 400)
    layout.setSize(SOURCES_ARTISTS_PANE, 200)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(400)
    expect(layout.sizeOf(SOURCES_ARTISTS_PANE)).toBe(200)
  })

  it('reads and writes through one binding', () => {
    const { layout } = shellLayout()
    const size = layout.paneSize(SIDEBAR_PANE)
    expect(size.value).toBe(320)
    size.value = 420
    expect(size.value).toBe(420)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(420)
  })

  it('works with no storage at all', () => {
    // Which is what a docked pane in a test harness gets, and what the layout
    // degrades to when `browserViewStorage` finds storage unavailable.
    const layout = createShellLayout({ settings: createViewSettings({ debounceMs: 0 }) })
    layout.setSize(SIDEBAR_PANE, 400)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(400)
  })
})

describe('scroll memory', () => {
  it('gives back nothing for a list it has not seen', () => {
    expect(createScrollMemory().recall('library:all')).toBe(0)
  })

  it('remembers where a list was left, rounded and never negative', () => {
    const memory = createScrollMemory()
    memory.remember('library:all', 1204.7)
    memory.remember('playlist:3', -40)
    expect(memory.recall('library:all')).toBe(1205)
    expect(memory.recall('playlist:3')).toBe(0)
  })

  it('ignores an empty key rather than storing one', () => {
    const memory = createScrollMemory()
    memory.remember('', 400)
    expect(memory.size).toBe(0)
  })

  it('forgets a list on request', () => {
    const memory = createScrollMemory()
    memory.remember('playlist:3', 900)
    memory.forget('playlist:3')
    expect(memory.recall('playlist:3')).toBe(0)
  })

  it('is bounded, because browse predicates are not', () => {
    const memory = createScrollMemory(3)
    memory.remember('a', 1)
    memory.remember('b', 2)
    memory.remember('c', 3)
    memory.remember('d', 4)
    expect(memory.size).toBe(3)
    expect(memory.recall('a')).toBe(0)
    expect(memory.recall('d')).toBe(4)
  })

  it('evicts the least recently left, not the first seen', () => {
    // The list most likely to be reopened is the one most recently closed, so a
    // first-in-first-out cache would evict exactly the wrong entry.
    const memory = createScrollMemory(3)
    memory.remember('a', 1)
    memory.remember('b', 2)
    memory.remember('c', 3)
    memory.remember('a', 10)
    memory.remember('d', 4)
    expect(memory.recall('a')).toBe(10)
    expect(memory.recall('b')).toBe(0)
  })

  it('defaults to a ceiling rather than growing without one', () => {
    const memory = createScrollMemory()
    for (let index = 0; index < MAX_REMEMBERED_SCROLLS * 2; index++) {
      memory.remember(`library:${index}`, index)
    }
    expect(memory.size).toBe(MAX_REMEMBERED_SCROLLS)
  })
})

describe('the direction the tab row moved', () => {
  it('is forward for a tab to the right and back for one to the left', () => {
    expect(tabDirection(0, 2)).toBe('forward')
    expect(tabDirection(2, 0)).toBe('back')
  })

  it('is none for the first tab of the session', () => {
    expect(tabDirection(-1, 0)).toBe('none')
  })

  it('is none for a route that is not a tab', () => {
    expect(tabDirection(1, -1)).toBe('none')
  })

  it('is none for the tab already showing', () => {
    expect(tabDirection(1, 1)).toBe('none')
  })
})
