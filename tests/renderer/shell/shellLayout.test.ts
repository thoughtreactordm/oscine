import { describe, expect, it } from 'vitest'
import {
  createScrollMemory,
  createShellLayout,
  defaultShellLayout,
  normalizeShellLayout,
  tabDirection,
  MAX_REMEMBERED_SCROLLS,
  SIDEBAR_PANE,
  SOURCES_ARTISTS_PANE,
  type ShellLayoutStorage
} from '../../../src/renderer/shell/shellLayout'

function memoryStorage(
  initial: string | null = null
): ShellLayoutStorage & { value: string | null; writes: number } {
  return {
    value: initial,
    writes: 0,
    read() {
      return this.value
    },
    write(value: string) {
      this.value = value
      this.writes += 1
    }
  }
}

describe('reading a stored layout', () => {
  it('starts from the defaults when there is nothing stored', () => {
    const layout = createShellLayout({ storage: memoryStorage() })
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(SIDEBAR_PANE.defaultSize)
  })

  it('starts from the defaults when what is stored is not JSON', () => {
    const layout = createShellLayout({ storage: memoryStorage('{ not json') })
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(320)
  })

  it('restores a size a previous session dragged', () => {
    const layout = createShellLayout({
      storage: memoryStorage(JSON.stringify({ paneSizes: { 'shell.sidebar': 412 } }))
    })
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(412)
  })

  it('holds a stored size inside the pane s bounds at the point of use', () => {
    // Bounds are not applied on read, because the container is not measured
    // then. A layout written by a build with a wider ceiling must still be safe.
    const layout = createShellLayout({
      storage: memoryStorage(JSON.stringify({ paneSizes: { 'shell.sidebar': 900 } }))
    })
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(480)
    expect(layout.sizeOf(SIDEBAR_PANE, 940)).toBe(460)
  })

  it('drops sizes that are not usable numbers', () => {
    const layout = normalizeShellLayout({
      paneSizes: { a: 'wide', b: Number.NaN, c: -20, d: 0, e: 300 }
    })
    expect(layout.paneSizes).toEqual({ e: 300 })
  })

  it('keeps a pane it has never heard of', () => {
    // A pane a newer build owns. Running the older binary once should not
    // silently discard the size the newer one stored.
    const layout = normalizeShellLayout({ paneSizes: { 'deck.queue': 260 } })
    expect(layout.paneSizes['deck.queue']).toBe(260)
  })

  it('survives a stored value of the wrong shape entirely', () => {
    expect(normalizeShellLayout(null)).toEqual(defaultShellLayout())
    expect(normalizeShellLayout([1, 2, 3])).toEqual(defaultShellLayout())
    expect(normalizeShellLayout({ paneSizes: 'wide' })).toEqual(defaultShellLayout())
  })
})

describe('writing a layout', () => {
  it('persists a clamped size', () => {
    const storage = memoryStorage()
    const layout = createShellLayout({ storage })
    layout.setSize(SIDEBAR_PANE, 9000)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(480)
    expect(JSON.parse(storage.value ?? '{}')).toEqual({ paneSizes: { 'shell.sidebar': 480 } })
  })

  it('does not write when the clamped size has not changed', () => {
    // A drag emits on every pointermove, and the last several of one that ran
    // past the ceiling all resolve to the same number.
    const storage = memoryStorage()
    const layout = createShellLayout({ storage })
    layout.setSize(SIDEBAR_PANE, 700)
    layout.setSize(SIDEBAR_PANE, 800)
    layout.setSize(SIDEBAR_PANE, 900)
    expect(storage.writes).toBe(1)
  })

  it('forgets a size on reset rather than storing the default', () => {
    const storage = memoryStorage()
    const layout = createShellLayout({ storage })
    layout.setSize(SIDEBAR_PANE, 400)
    layout.resetSize(SIDEBAR_PANE)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(320)
    expect(JSON.parse(storage.value ?? '{}')).toEqual({ paneSizes: {} })
  })

  it('keeps panes apart', () => {
    const layout = createShellLayout({ storage: memoryStorage() })
    layout.setSize(SIDEBAR_PANE, 400)
    layout.setSize(SOURCES_ARTISTS_PANE, 200)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(400)
    expect(layout.sizeOf(SOURCES_ARTISTS_PANE)).toBe(200)
  })

  it('reads and writes through one binding', () => {
    const layout = createShellLayout({ storage: memoryStorage() })
    const size = layout.paneSize(SIDEBAR_PANE)
    expect(size.value).toBe(320)
    size.value = 420
    expect(size.value).toBe(420)
    expect(layout.sizeOf(SIDEBAR_PANE)).toBe(420)
  })

  it('works with no storage at all', () => {
    // Which is what a docked pane in a test harness gets, and what the layout
    // degrades to when `browserShellLayoutStorage` finds storage unavailable.
    const layout = createShellLayout()
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
