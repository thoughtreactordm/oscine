import { describe, expect, it } from 'vitest'
import { paletteShortcut, type ShortcutChord } from '../../../src/renderer/shell/globalShortcuts'

/**
 * The one global shortcut's decision, D27. Every case here is behaviour the
 * composable can only wire, not decide: the guard that keeps Ctrl+K from
 * stealing a keystroke mid-type is the whole reason this is a pure function.
 */

function chord(over: Partial<ShortcutChord>): ShortcutChord {
  return { key: '', ctrlKey: false, metaKey: false, editable: false, ...over }
}

describe('paletteShortcut', () => {
  it('toggles on Ctrl+K and Cmd+K', () => {
    expect(paletteShortcut(chord({ key: 'k', ctrlKey: true }))).toBe('toggle')
    expect(paletteShortcut(chord({ key: 'k', metaKey: true }))).toBe('toggle')
  })

  it('is case-insensitive on the key', () => {
    // A held Shift, or Caps, still opens the palette.
    expect(paletteShortcut(chord({ key: 'K', metaKey: true }))).toBe('toggle')
  })

  it('needs a modifier — a bare k is typing', () => {
    expect(paletteShortcut(chord({ key: 'k' }))).toBeNull()
  })

  it('closes on Escape', () => {
    expect(paletteShortcut(chord({ key: 'Escape' }))).toBe('close')
  })

  it('does not fire while a text control is focused', () => {
    // The guard. Ctrl+K in a rename field must not open the palette, and Escape
    // there belongs to the field — the palette closes through the modal instead.
    expect(paletteShortcut(chord({ key: 'k', metaKey: true, editable: true }))).toBeNull()
    expect(paletteShortcut(chord({ key: 'Escape', editable: true }))).toBeNull()
  })

  it('ignores every other key', () => {
    expect(paletteShortcut(chord({ key: 'a', ctrlKey: true }))).toBeNull()
    expect(paletteShortcut(chord({ key: 'Enter' }))).toBeNull()
  })
})
