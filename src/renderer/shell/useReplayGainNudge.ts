import { onMounted, onUnmounted } from 'vue'
import { library } from '@renderer/ipc'
import { measureOutcomeMessage } from '@renderer/replaygain/measureModel'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { useReplayGainStore } from '@renderer/stores/replayGain'

/**
 * How long after a root's `done` the scan counts as settled.
 *
 * "Rescan all" walks the roots one after another, and each emits its own
 * `done`. Waiting a moment, and only nudging once no scan is running, makes
 * that one toast for the whole sweep rather than one per folder.
 */
const SETTLE_MS = 1_500

/**
 * D37 Decision A's nudge: when a scan leaves untagged tracks, say so once, with
 * a Measure action, and do nothing else. Non-modal by construction — a toast.
 *
 * Mounted by the frame, because the scan it reacts to can be started from any
 * tab. Whether to speak is `nudgeFor`'s call (suppressed while a job runs,
 * while the gate is off, and for a count already announced this session).
 */
export function useReplayGainNudge(): void {
  const toast = useToast()
  const roots = useLibraryRootsStore()
  const replayGain = useReplayGainStore()

  let stopScan: (() => void) | null = null
  let settle: ReturnType<typeof setTimeout> | null = null

  async function measure(): Promise<void> {
    try {
      const outcome = await replayGain.measure()
      toast.add({
        title: measureOutcomeMessage(outcome),
        icon: 'i-tabler-wave-sine',
        color: 'primary'
      })
    } catch (error) {
      toast.add({
        title: 'ReplayGain could not be measured',
        description: (error as Error).message,
        icon: 'i-tabler-alert-triangle',
        color: 'error'
      })
    }
  }

  async function check(): Promise<void> {
    settle = null
    if (roots.scan) return
    const nudge = await replayGain.nudgeAfterScan()
    if (!nudge) return
    toast.add({
      title: nudge.message,
      description: 'Measuring decodes each one in the background. It never writes to your files.',
      icon: 'i-tabler-wave-sine',
      color: 'neutral',
      duration: 12_000,
      actions: [
        {
          label: 'Measure',
          icon: 'i-tabler-player-play',
          color: 'primary',
          variant: 'subtle',
          onClick: () => void measure()
        }
      ]
    })
  }

  onMounted(() => {
    stopScan = library.onScanProgress((progress) => {
      if (settle) clearTimeout(settle)
      settle = progress.done ? setTimeout(() => void check(), SETTLE_MS) : null
    })
  })

  onUnmounted(() => {
    stopScan?.()
    stopScan = null
    if (settle) clearTimeout(settle)
    settle = null
  })
}
