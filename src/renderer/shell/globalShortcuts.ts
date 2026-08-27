/**
 * The decision half of the app's global keyboard shortcuts — D27, grown into the
 * fixed default set G6 ships for 1.0.
 *
 * Still a pure function of a plain chord, so the whole keymap is testable without
 * a `window`, a `KeyboardEvent` or the DOM lib: `useGlobalShortcuts` reads those
 * off the event and hands the answer here. That split is the seam D27 promises
 * W8 — when the remappable keyboard subsystem lands it replaces the *bindings*,
 * the `SHORTCUTS` table below, not the dispatch that reads it or the DOM handler
 * that feeds it.
 *
 * The set is deliberately not rebindable in 1.0 (G6). One table is the whole of
 * it, and it is the single source both the dispatcher and the Help reference read
 * from — so the shortcuts the app obeys and the shortcuts the About > Keyboard
 * shortcuts modal prints cannot drift.
 */

/** How far one seek keystroke moves, in seconds. Named so the doc can quote it. */
export const SEEK_STEP_SECONDS = 5

/** How far one volume keystroke moves, as a fraction of the 0–1 range. */
export const VOLUME_STEP = 0.05

/**
 * What a keystroke resolves to — an intent, not a store call. The dispatcher in
 * `useGlobalShortcuts` is the one place that knows about Pinia and the router;
 * everything here is decidable under the node test config.
 */
export type ShortcutAction =
  | { readonly kind: 'palette'; readonly action: 'toggle' | 'close' | 'search' }
  | { readonly kind: 'transport'; readonly action: 'playPause' | 'next' | 'previous' }
  | { readonly kind: 'seek'; readonly deltaSeconds: number }
  | { readonly kind: 'volume'; readonly delta: number }
  | { readonly kind: 'navigate'; readonly tabIndex: number }

export interface ShortcutChord {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /**
   * A text control has focus. The first guard, and it stands every shortcut
   * down: nothing may steal a keystroke from someone naming a playlist, not even
   * Ctrl+K — the palette's own input closes through the modal, not through here.
   */
  readonly editable: boolean
  /**
   * A button, link or other control that treats Space as activation has focus.
   * Only Space consults it: firing play/pause *and* clicking the focused button
   * off one press is the double-action every space-to-play player has to avoid,
   * and the fix is to leave Space to the control. Every other binding carries a
   * modifier the control ignores, so none of them need this.
   */
  readonly interactive: boolean
}

/** The two categories the Help reference groups the set under. */
export type ShortcutCategory = 'Playback' | 'Navigation'

export interface ShortcutSpec {
  /** Stable id — the handle W8 will hang a rebinding off. */
  readonly id: string
  readonly category: ShortcutCategory
  /** The human sentence the Help reference prints. */
  readonly description: string
  /**
   * The keycaps the Help reference draws, in order. `Mod` is resolved to Ctrl or
   * ⌘ at render time — the only platform-variable token, kept symbolic so this
   * module stays free of `navigator`.
   */
  readonly keys: readonly string[]
  /** The action this chord produces, or `null` when it is not this binding. */
  match(chord: ShortcutChord): ShortcutAction | null
}

/** Ctrl or ⌘, and nothing else held. */
function justMod(chord: ShortcutChord): boolean {
  return (chord.ctrlKey || chord.metaKey) && !chord.shiftKey && !chord.altKey
}

/** Shift alone — the seek modifier, chosen so it never collides with Mod. */
function justShift(chord: ShortcutChord): boolean {
  return chord.shiftKey && !chord.ctrlKey && !chord.metaKey && !chord.altKey
}

/** No modifier at all — the bare keys, Space and Escape. */
function bare(chord: ShortcutChord): boolean {
  return !chord.ctrlKey && !chord.metaKey && !chord.shiftKey && !chord.altKey
}

/** The 0-based tab a Mod+digit names, or `null` for anything but 1–9. */
function tabIndexForKey(key: string): number | null {
  if (key.length === 1 && key >= '1' && key <= '9') {
    return key.charCodeAt(0) - '1'.charCodeAt(0)
  }
  return null
}

/**
 * The fixed 1.0 set (G6). Order is only a tie-break the keys never actually
 * reach — every `match` is exclusive on the key — so it is written in reading
 * order, the order the Help reference prints within each category.
 *
 * Mod is Ctrl on the two shipped platforms (Windows, Linux); `match` also honours
 * ⌘ so a macOS build behaves, and the doc label follows the platform.
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  {
    id: 'playPause',
    category: 'Playback',
    description: 'Play / Pause',
    keys: ['Space'],
    match: (chord) =>
      bare(chord) && chord.key === ' ' && !chord.interactive
        ? { kind: 'transport', action: 'playPause' }
        : null
  },
  {
    id: 'previous',
    category: 'Playback',
    description: 'Previous track',
    keys: ['Mod', '←'],
    match: (chord) =>
      justMod(chord) && chord.key === 'ArrowLeft' ? { kind: 'transport', action: 'previous' } : null
  },
  {
    id: 'next',
    category: 'Playback',
    description: 'Next track',
    keys: ['Mod', '→'],
    match: (chord) =>
      justMod(chord) && chord.key === 'ArrowRight' ? { kind: 'transport', action: 'next' } : null
  },
  {
    id: 'seekBackward',
    category: 'Playback',
    description: `Seek back ${SEEK_STEP_SECONDS}s`,
    keys: ['Shift', '←'],
    match: (chord) =>
      justShift(chord) && chord.key === 'ArrowLeft'
        ? { kind: 'seek', deltaSeconds: -SEEK_STEP_SECONDS }
        : null
  },
  {
    id: 'seekForward',
    category: 'Playback',
    description: `Seek forward ${SEEK_STEP_SECONDS}s`,
    keys: ['Shift', '→'],
    match: (chord) =>
      justShift(chord) && chord.key === 'ArrowRight'
        ? { kind: 'seek', deltaSeconds: SEEK_STEP_SECONDS }
        : null
  },
  {
    id: 'volumeUp',
    category: 'Playback',
    description: 'Volume up',
    keys: ['Mod', '↑'],
    match: (chord) =>
      justMod(chord) && chord.key === 'ArrowUp' ? { kind: 'volume', delta: VOLUME_STEP } : null
  },
  {
    id: 'volumeDown',
    category: 'Playback',
    description: 'Volume down',
    keys: ['Mod', '↓'],
    match: (chord) =>
      justMod(chord) && chord.key === 'ArrowDown' ? { kind: 'volume', delta: -VOLUME_STEP } : null
  },
  {
    id: 'navigateTab',
    category: 'Navigation',
    description: 'Jump to a tab',
    keys: ['Mod', '1 – 6'],
    match: (chord) => {
      if (!justMod(chord)) return null
      const tabIndex = tabIndexForKey(chord.key)
      return tabIndex === null ? null : { kind: 'navigate', tabIndex }
    }
  },
  {
    id: 'commandPalette',
    category: 'Navigation',
    description: 'Open the Command Palette',
    keys: ['Mod', 'K'],
    match: (chord) =>
      justMod(chord) && chord.key.toLowerCase() === 'k'
        ? { kind: 'palette', action: 'toggle' }
        : null
  },
  {
    id: 'focusSearch',
    category: 'Navigation',
    description: 'Focus search',
    keys: ['Mod', 'F'],
    match: (chord) =>
      justMod(chord) && chord.key.toLowerCase() === 'f'
        ? { kind: 'palette', action: 'search' }
        : null
  },
  {
    id: 'closePalette',
    category: 'Navigation',
    description: 'Close the palette',
    keys: ['Esc'],
    match: (chord) =>
      bare(chord) && chord.key === 'Escape' ? { kind: 'palette', action: 'close' } : null
  }
]

/**
 * What a keydown should do, or nothing.
 *
 * A text control focused stands the whole set down — the guard the palette
 * shortcut has always had, now covering every binding for the same reason. Past
 * that it is the first matching spec, and the specs are exclusive on the key, so
 * the set has no ordering to get wrong.
 */
export function resolveShortcut(chord: ShortcutChord): ShortcutAction | null {
  if (chord.editable) return null
  for (const spec of SHORTCUTS) {
    const action = spec.match(chord)
    if (action) return action
  }
  return null
}
