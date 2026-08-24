/**
 * The decision half of the app's one global shortcut — D27.
 *
 * Kept as a pure function of a plain chord so it can be tested without a
 * `window`, a `KeyboardEvent` or the DOM lib: `useGlobalShortcuts` reads those
 * off the event and hands the answer here. That split is also the seam D27
 * promises W8 — when the remappable keyboard subsystem lands, it replaces the
 * binding, not this mapping.
 */

export type PaletteShortcut = 'toggle' | 'close'

export interface ShortcutChord {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  /**
   * Whether a text control has focus. The guard: the first global shortcut must
   * not steal a keystroke from someone typing a playlist name.
   */
  readonly editable: boolean
}

/**
 * What a keydown should do to the palette, or nothing.
 *
 * Ctrl/Cmd+K toggles; Escape closes. Both stand down while a text control has
 * focus — the palette's own input closes through the modal's dismissable layer,
 * not through this handler, so nothing is lost by the guard.
 */
export function paletteShortcut(chord: ShortcutChord): PaletteShortcut | null {
  if (chord.editable) return null
  if ((chord.ctrlKey || chord.metaKey) && chord.key.toLowerCase() === 'k') {
    return 'toggle'
  }
  if (chord.key === 'Escape') return 'close'
  return null
}
