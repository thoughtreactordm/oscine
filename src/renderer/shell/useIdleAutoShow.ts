import { onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NOW_PLAYING_IDLE_AUTOSHOW_KEY, type NowPlayingIdleInterval } from '@shared/settings'
import { armedIntervalMs, idleStep } from '@renderer/shell/idleAutoShow'
import { useSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'

/**
 * Interaction events that count as in-app activity and push the idle deadline
 * out. Passive listeners that do nothing but stamp a timestamp, so the flood
 * one `pointermove` makes never reaches a timer — see `idleStep`.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const

/**
 * G4: after a chosen span of no in-app interaction while music plays, bring the
 * frame to Now Playing.
 *
 * Mounted once in `AppShell`, beside `useGlobalShortcuts`. The arming rule is
 * the pure `armedIntervalMs`; this wires the transport, the route and the
 * settings cascade to it and carries the countdown on one self-rescheduling
 * timeout. Reaching Now Playing — by the auto-show or by hand — disarms it,
 * because the gate then reads `onNowPlaying`, so there is no re-fire to guard
 * and no loop to break.
 */
export function useIdleAutoShow(): void {
  const router = useRouter()
  const settings = useSettings()
  const playback = usePlaybackStore()
  const shell = useShellStore()

  let timer: ReturnType<typeof setTimeout> | null = null
  let intervalMs = 0
  let lastActivity = 0
  let listening = false

  function markActivity(): void {
    lastActivity = Date.now()
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function tick(): void {
    const step = idleStep(Date.now() - lastActivity, intervalMs)
    if (!step.reveal) {
      timer = setTimeout(tick, step.nextDelayMs)
      return
    }
    timer = null
    // The reactive gate below disarms on a pause or a hand-navigation to Now
    // Playing, but a watcher flush is a tick away; re-read the transport and
    // route so a change in that gap cannot pull the frame onto a stopped deck.
    if (playback.isPlaying && shell.activeTab !== 'now-playing') {
      void router.push({ name: 'now-playing' })
    }
  }

  function listen(on: boolean): void {
    if (on === listening) return
    for (const type of ACTIVITY_EVENTS) {
      if (on) window.addEventListener(type, markActivity, { passive: true })
      else window.removeEventListener(type, markActivity)
    }
    listening = on
  }

  watch(
    () =>
      armedIntervalMs({
        interval: settings.get<NowPlayingIdleInterval>(NOW_PLAYING_IDLE_AUTOSHOW_KEY),
        playing: playback.isPlaying,
        onNowPlaying: shell.activeTab === 'now-playing'
      }),
    (ms) => {
      stopTimer()
      listen(ms > 0)
      if (ms === 0) return
      intervalMs = ms
      lastActivity = Date.now()
      timer = setTimeout(tick, ms)
    },
    { immediate: true }
  )

  onUnmounted(() => {
    stopTimer()
    listen(false)
  })
}
