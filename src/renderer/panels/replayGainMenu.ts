import type { ContextMenuItem } from '@nuxt/ui'
import { measureOutcomeMessage, type ReplayGainScope } from '@renderer/replaygain/measureModel'
import { useReplayGainStore } from '@renderer/stores/replayGain'

/**
 * The "Measure ReplayGain" context-menu entry — **W25-7** (RG-7).
 *
 * A forced re-measure of what the menu is about: a track, a track selection, an
 * album or an album selection, whatever their ReplayGain already says. It is the
 * explicit request D37 asks for, so it measures tagged and already-measured
 * tracks too — and still writes nothing to a file: the result lands in the
 * database, and reaches the file only by being staged and reviewed.
 *
 * Albums go to main as album ids, never as the tracks a view happened to show,
 * so main expands each to its whole album and Decision C's album-whole rule can
 * still hold when the result is staged.
 *
 * A composable because the toast has to be resolved during component setup; the
 * returned builder is what a menu calls each time it opens.
 */
export function useMeasureReplayGainMenu(): (
  scope: () => Promise<ReplayGainScope>
) => ContextMenuItem {
  const toast = useToast()
  const replayGain = useReplayGainStore()

  async function measure(scope: () => Promise<ReplayGainScope>): Promise<void> {
    try {
      const outcome = await replayGain.measureSelection(await scope())
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

  return (scope) => ({
    label: 'Measure ReplayGain',
    icon: 'i-tabler-wave-sine',
    onSelect: () => void measure(scope)
  })
}
