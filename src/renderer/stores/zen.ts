import { defineStore } from 'pinia'
import { ref } from 'vue'
import { windowControls } from '@renderer/ipc'

/**
 * Zen / Kiosk mode — a minimal, fullscreen Now Playing display for TVs and
 * secondary monitors.
 *
 * A single transient flag, deliberately *not* a durable setting: Zen is a mode
 * you switch on for a session, not a preference that should reboot a machine
 * into a chromeless window. It resets to off on every launch.
 *
 * The store owns two things only — the flag, and the one window side effect Zen
 * has (fullscreen). It does *not* navigate: routing is the frame's job, so
 * `useZenMode` (mounted in `AppShell`) watches this flag and moves between Now
 * Playing and the view the operator came from. Keeping the store router-free is
 * what lets it be read from anywhere — the title bar, the palette, a shortcut —
 * without any of them needing a live component instance.
 *
 * While Zen is on the frame drops the title bar, the tab row and the persistent
 * transport bar, and promotes the Now Playing stage to the whole window. It does
 * this by *overriding* those regions, not by flipping their own settings — the
 * operator's tab-bar and color-mode preferences are untouched and return exactly
 * as they were on the way out.
 */
export const useZenStore = defineStore('zen', () => {
  const active = ref(false)

  function enter(): void {
    if (active.value) return
    active.value = true
    void windowControls.setFullScreen(true)
  }

  function exit(): void {
    if (!active.value) return
    active.value = false
    void windowControls.setFullScreen(false)
  }

  function toggle(): void {
    if (active.value) exit()
    else enter()
  }

  /**
   * Reconcile with the window when fullscreen changes out from under us — F11 or
   * Esc dropping fullscreen while Zen is on. Leaving fullscreen leaves Zen, so
   * the two can never disagree; entering it by some other route does not turn Zen
   * on, because Zen is more than fullscreen. Only the flag is touched here — the
   * window already reports the state this is reacting to.
   */
  function syncFullScreen(fullscreen: boolean): void {
    if (!fullscreen && active.value) active.value = false
  }

  return { active, enter, exit, toggle, syncFullScreen }
})
