import { onMounted, onUnmounted } from 'vue'
import { paletteShortcut } from '@renderer/shell/globalShortcuts'
import { usePaletteStore } from '@renderer/stores/palette'

/**
 * Whether an event's target is a text control, so the shortcut can stand down.
 *
 * The DOM half of the guard, kept out of `globalShortcuts.ts` so that module
 * stays free of the DOM lib and testable under the node config. `contenteditable`
 * counts, as do the three form elements that take a keystroke.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * The app's first global keyboard handler — minimal, and by D27 its only one.
 *
 * Mounted once in `AppShell`. It is a single registration seam, not a subsystem:
 * one `keydown` listener, one mapping (`globalShortcuts.ts`), one store it drives.
 * When W8 builds the remappable keyboard subsystem this is the first thing it
 * absorbs — which is why the decision lives in a pure function it can lift out,
 * and why there is deliberately no second raw listener anywhere in the renderer.
 */
export function useGlobalShortcuts(): void {
  const palette = usePaletteStore()

  function onKeydown(event: KeyboardEvent): void {
    const action = paletteShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      editable: isEditableTarget(event.target)
    })

    if (action === 'toggle') {
      event.preventDefault()
      palette.toggle()
    } else if (action === 'close' && palette.open) {
      // Only claim Escape when there is something to close, so it is left for
      // whatever else might want it when the palette is not showing.
      event.preventDefault()
      palette.close()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))
}
