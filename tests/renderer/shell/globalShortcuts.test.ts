import { describe, expect, it } from 'vitest'
import {
  resolveShortcut,
  SEEK_STEP_SECONDS,
  SHORTCUTS,
  VOLUME_STEP,
  type ShortcutChord
} from '../../../src/renderer/shell/globalShortcuts'

/**
 * The fixed 1.0 keymap's decision, G6 (D27's seam grown up). Every case here is
 * behaviour the composable can only wire, not decide: the guards that keep a
 * shortcut from stealing a keystroke mid-type — or Space off a focused button —
 * are the whole reason this is a pure function.
 */

function chord(over: Partial<ShortcutChord>): ShortcutChord {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    editable: false,
    interactive: false,
    ...over
  }
}

describe('resolveShortcut — palette', () => {
  it('toggles on Ctrl+K and Cmd+K', () => {
    expect(resolveShortcut(chord({ key: 'k', ctrlKey: true }))).toEqual({
      kind: 'palette',
      action: 'toggle'
    })
    expect(resolveShortcut(chord({ key: 'k', metaKey: true }))).toEqual({
      kind: 'palette',
      action: 'toggle'
    })
  })

  it('is case-insensitive on the key', () => {
    // A held Shift, or Caps, still opens the palette — but Shift is not a fresh
    // modifier here, it is the same K arriving capitalised.
    expect(resolveShortcut(chord({ key: 'K', metaKey: true }))).toEqual({
      kind: 'palette',
      action: 'toggle'
    })
  })

  it('needs a modifier — a bare k is typing', () => {
    expect(resolveShortcut(chord({ key: 'k' }))).toBeNull()
  })

  it('focuses search on Ctrl+F / Cmd+F', () => {
    expect(resolveShortcut(chord({ key: 'f', ctrlKey: true }))).toEqual({
      kind: 'palette',
      action: 'search'
    })
    expect(resolveShortcut(chord({ key: 'f', metaKey: true }))).toEqual({
      kind: 'palette',
      action: 'search'
    })
  })

  it('closes on Escape', () => {
    expect(resolveShortcut(chord({ key: 'Escape' }))).toEqual({ kind: 'palette', action: 'close' })
  })

  it('does not fire while a text control is focused', () => {
    // The guard. Ctrl+K in a rename field must not open the palette, Space must
    // not toggle playback, and Escape there belongs to the field.
    expect(resolveShortcut(chord({ key: 'k', metaKey: true, editable: true }))).toBeNull()
    expect(resolveShortcut(chord({ key: 'Escape', editable: true }))).toBeNull()
    expect(resolveShortcut(chord({ key: ' ', editable: true }))).toBeNull()
  })
})

describe('resolveShortcut — playback', () => {
  it('plays / pauses on a bare Space', () => {
    expect(resolveShortcut(chord({ key: ' ' }))).toEqual({
      kind: 'transport',
      action: 'playPause'
    })
  })

  it('leaves Space to a focused control', () => {
    // A focused button gets its own Space; play/pause stands down so one press is
    // not two actions.
    expect(resolveShortcut(chord({ key: ' ', interactive: true }))).toBeNull()
  })

  it('does not treat a modified Space as play/pause', () => {
    expect(resolveShortcut(chord({ key: ' ', ctrlKey: true }))).toBeNull()
    expect(resolveShortcut(chord({ key: ' ', shiftKey: true }))).toBeNull()
  })

  it('skips track on Ctrl/Cmd + arrows', () => {
    expect(resolveShortcut(chord({ key: 'ArrowRight', ctrlKey: true }))).toEqual({
      kind: 'transport',
      action: 'next'
    })
    expect(resolveShortcut(chord({ key: 'ArrowLeft', metaKey: true }))).toEqual({
      kind: 'transport',
      action: 'previous'
    })
  })

  it('seeks on Shift + arrows, by the named step', () => {
    expect(resolveShortcut(chord({ key: 'ArrowRight', shiftKey: true }))).toEqual({
      kind: 'seek',
      deltaSeconds: SEEK_STEP_SECONDS
    })
    expect(resolveShortcut(chord({ key: 'ArrowLeft', shiftKey: true }))).toEqual({
      kind: 'seek',
      deltaSeconds: -SEEK_STEP_SECONDS
    })
  })

  it('adjusts volume on Ctrl/Cmd + up/down, by the named step', () => {
    expect(resolveShortcut(chord({ key: 'ArrowUp', ctrlKey: true }))).toEqual({
      kind: 'volume',
      delta: VOLUME_STEP
    })
    expect(resolveShortcut(chord({ key: 'ArrowDown', ctrlKey: true }))).toEqual({
      kind: 'volume',
      delta: -VOLUME_STEP
    })
  })

  it('keeps seek and skip on different modifiers so neither shadows the other', () => {
    // Shift+Left is a seek, Ctrl+Left is a skip; a chord holding both is neither.
    expect(resolveShortcut(chord({ key: 'ArrowLeft', shiftKey: true, ctrlKey: true }))).toBeNull()
  })
})

describe('resolveShortcut — navigation', () => {
  it('maps Ctrl/Cmd + digit to a 0-based tab index', () => {
    expect(resolveShortcut(chord({ key: '1', ctrlKey: true }))).toEqual({
      kind: 'navigate',
      tabIndex: 0
    })
    expect(resolveShortcut(chord({ key: '6', metaKey: true }))).toEqual({
      kind: 'navigate',
      tabIndex: 5
    })
  })

  it('resolves any 1–9 digit and leaves the bound to the dispatcher', () => {
    // The table does not know how many tabs there are; a digit past the last one
    // resolves here and no-ops at dispatch. Nine is the ceiling a single key can
    // name.
    expect(resolveShortcut(chord({ key: '9', ctrlKey: true }))).toEqual({
      kind: 'navigate',
      tabIndex: 8
    })
    expect(resolveShortcut(chord({ key: '0', ctrlKey: true }))).toBeNull()
  })

  it('needs the modifier — a bare digit is typing', () => {
    expect(resolveShortcut(chord({ key: '1' }))).toBeNull()
    expect(resolveShortcut(chord({ key: '1', shiftKey: true }))).toBeNull()
  })
})

describe('resolveShortcut — zen mode', () => {
  it('toggles on a bare F11 — the fullscreen key', () => {
    expect(resolveShortcut(chord({ key: 'F11' }))).toEqual({ kind: 'zen', action: 'toggle' })
  })

  it('also toggles on Ctrl/Cmd + Shift + Z, case-insensitively', () => {
    expect(resolveShortcut(chord({ key: 'z', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'zen',
      action: 'toggle'
    })
    expect(resolveShortcut(chord({ key: 'Z', metaKey: true, shiftKey: true }))).toEqual({
      kind: 'zen',
      action: 'toggle'
    })
  })

  it('needs the Shift — Ctrl+Z alone is not Zen', () => {
    expect(resolveShortcut(chord({ key: 'z', ctrlKey: true }))).toBeNull()
  })

  it('stands down while a text control is focused', () => {
    expect(resolveShortcut(chord({ key: 'F11', editable: true }))).toBeNull()
  })
})

describe('resolveShortcut — misses', () => {
  it('ignores every unbound key', () => {
    expect(resolveShortcut(chord({ key: 'a', ctrlKey: true }))).toBeNull()
    expect(resolveShortcut(chord({ key: 'Enter' }))).toBeNull()
    expect(resolveShortcut(chord({ key: 'ArrowUp' }))).toBeNull()
  })
})

describe('SHORTCUTS table', () => {
  it('gives every binding a unique id, a description and at least one keycap', () => {
    const ids = SHORTCUTS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const spec of SHORTCUTS) {
      expect(spec.description.length).toBeGreaterThan(0)
      expect(spec.keys.length).toBeGreaterThan(0)
    }
  })

  it('covers each of G6’s named categories', () => {
    const categories = new Set(SHORTCUTS.map((spec) => spec.category))
    expect(categories).toEqual(new Set(['Playback', 'Navigation']))
  })
})
