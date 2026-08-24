import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Whether the command palette is open — and nothing else.
 *
 * A store rather than component state because three islands touch it and none
 * may know the others: `useGlobalShortcuts` toggles it from a window listener,
 * `AppTitleBar` opens it from a button, and `CommandPalette` reads it to draw.
 * The same reasoning as `NewPlaylistModal`'s store — the frame mounts the modal
 * once, and the gesture that opens it comes from somewhere the modal is not.
 *
 * Deliberately thin: what the palette *does* lives in `paletteSearch` and the
 * component, not here. This is open/closed and the two ways to change it.
 */
export const usePaletteStore = defineStore('palette', () => {
  const open = ref(false)

  function openPalette(): void {
    open.value = true
  }

  function close(): void {
    open.value = false
  }

  function toggle(): void {
    open.value = !open.value
  }

  return { open, openPalette, close, toggle }
})
