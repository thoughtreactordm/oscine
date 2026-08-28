import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { resolveShortcut, type ShortcutAction } from '@renderer/shell/globalShortcuts'
import { shellTabs } from '@renderer/shell/routes'
import { usePaletteStore } from '@renderer/stores/palette'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useZenStore } from '@renderer/stores/zen'

/**
 * Controls that treat Space (or the pointer) as activation, so Space stands down
 * on them rather than firing play/pause underneath a click the user meant. The
 * text controls are handled by `isEditableTarget`; this is the actionable rest.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]'
].join(',')

/**
 * Whether an event's target is a text control, so every shortcut can stand down.
 *
 * The DOM half of the guard, kept out of `globalShortcuts.ts` so that module
 * stays free of the DOM lib and testable under the node config. `contenteditable`
 * counts, as do the three form elements that take a keystroke — including
 * `<input type="range">`, which is why the seek and volume sliders keep their own
 * arrow keys instead of the transport eating them.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Whether an actionable control has focus — the Space guard's DOM half. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest(INTERACTIVE_SELECTOR) !== null
}

/**
 * The app's global keyboard handler — one listener, and by D27 its only one.
 *
 * Mounted once in `AppShell`. It is a single registration seam, not a subsystem:
 * one `keydown` listener, one keymap (`globalShortcuts.ts`), the stores and
 * router it drives. When W8 builds the remappable keyboard subsystem this is the
 * first thing it absorbs — which is why the decision lives in a pure table it can
 * lift out, and why there is deliberately no second raw listener in the renderer.
 *
 * The dispatch is the seam's other side: it maps an intent to a store call and
 * decides whether the key was claimed. A claim swallows the browser default —
 * Space scrolling, Ctrl+F's find, an arrow moving a caret — so the shortcut is
 * the whole of what the keystroke does; a miss (Escape with nothing to close, a
 * tab index past the last tab) leaves the key alone.
 */
export function useGlobalShortcuts(): void {
  const palette = usePaletteStore()
  const playback = usePlaybackStore()
  const zen = useZenStore()
  const router = useRouter()

  /** Runs an action and reports whether it claimed the key. */
  function dispatch(action: ShortcutAction): boolean {
    switch (action.kind) {
      case 'palette':
        if (action.action === 'toggle') {
          palette.toggle()
          return true
        }
        if (action.action === 'search') {
          palette.openPalette()
          return true
        }
        // Only claim Escape when there is something to close, so it is left for
        // whatever else might want it when the palette is not showing.
        if (!palette.open) return false
        palette.close()
        return true
      case 'transport':
        if (action.action === 'playPause') void playback.toggle()
        else if (action.action === 'next') void playback.next()
        else void playback.previous()
        return true
      case 'seek':
        playback.seek(playback.currentTime + action.deltaSeconds)
        return true
      case 'volume':
        playback.setVolume(playback.volume + action.delta)
        return true
      case 'navigate': {
        const tab = shellTabs[action.tabIndex]
        // A digit past the last tab is not this app's shortcut; leave it be.
        if (!tab) return false
        void router.push({ name: tab.name })
        return true
      }
      case 'zen':
        zen.toggle()
        return true
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    const action = resolveShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      editable: isEditableTarget(event.target),
      interactive: isInteractiveTarget(event.target)
    })
    if (!action) return
    if (dispatch(action)) event.preventDefault()
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))
}
