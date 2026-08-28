import { computed, type ComputedRef } from 'vue'
import { useSettings } from '@renderer/settings'
import { useShellStore } from '@renderer/stores/shell'
import { useZenStore } from '@renderer/stores/zen'
import { NOW_PLAYING_STAGE_TRANSPORT_KEY } from '@shared/settings'

/**
 * Whether the Now Playing stage is carrying the transport itself rather than the
 * bar below it.
 *
 * True in Zen mode (always — the frame has dropped the bar's whole row), and true
 * on the Now Playing view when the operator has merged the player into it
 * (`interface.nowPlayingStageTransport`). The frame reads this to drop the
 * transport row and unmount the bar; `StageView` reads the same computed to draw
 * the controls in its place — one source of truth, so the two can never disagree
 * about where the transport is and leave the window with two copies or none.
 *
 * Scoped to the Now Playing route on purpose: the bar is every other view's only
 * transport, so the merge hides it there and nowhere else.
 */
export function useStageTransport(): ComputedRef<boolean> {
  const settings = useSettings()
  const shell = useShellStore()
  const zen = useZenStore()
  return computed(
    () =>
      zen.active ||
      (settings.get<boolean>(NOW_PLAYING_STAGE_TRANSPORT_KEY) && shell.activeTab === 'now-playing')
  )
}
