import { onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { windowControls } from '@renderer/ipc'
import { useShellStore } from '@renderer/stores/shell'
import { useZenStore } from '@renderer/stores/zen'

/**
 * The frame half of Zen mode — the navigation and the window subscription the
 * store deliberately does without.
 *
 * Mounted once in `AppShell`, alongside `useGlobalShortcuts` and
 * `useIdleAutoShow`, for the reason they are: it watches the mode and the route
 * from outside any one tab and moves between them, so it cannot live under a view
 * a tab change unmounts.
 *
 * Entering Zen goes to Now Playing — the stage is the whole point of the mode.
 * Leaving it returns to `shell.returnView`, the last view that was not Now
 * Playing, exactly as a queue playing through does (G2): the operator dropped
 * into Zen from somewhere, and that somewhere is where they come back to. The
 * fullscreen subscription is what lets F11 or Esc stand the mode down — leaving
 * fullscreen leaves Zen, so the window and the flag cannot drift.
 */
export function useZenMode(): void {
  const router = useRouter()
  const shell = useShellStore()
  const zen = useZenStore()

  let stopFullScreenListener: (() => void) | null = null

  onMounted(() => {
    stopFullScreenListener = windowControls.onFullScreenChange((fullscreen) => {
      zen.syncFullScreen(fullscreen)
    })
  })

  onUnmounted(() => stopFullScreenListener?.())

  watch(
    () => zen.active,
    (active) => {
      if (active) {
        void router.push({ name: 'now-playing' })
      } else if (shell.activeTab === 'now-playing') {
        void router.push({ name: shell.returnView })
      }
    }
  )
}
