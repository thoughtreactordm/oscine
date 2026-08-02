import { useDisplayFormatStore } from '@renderer/stores/displayFormat'
import type { ReadoutFormats } from '@renderer/panels/tunedeck/signalReadout'

/**
 * Sizes and durations as the operator writes them everywhere else.
 *
 * A plain object of the store's own functions rather than the store: they read
 * `settings.get` on each call, so the reactivity survives being passed by
 * reference and a change to `view.fileSizeFormat` reflows the readout along
 * with the track list. See `createDisplayFormats`.
 *
 * Extracted from `SignalPane` when that pane became the Track tab's three
 * groups. Three copies of four lines would have been fine; three copies of the
 * paragraph above, drifting, would not.
 */
export function useSignalFormats(): ReadoutFormats {
  const display = useDisplayFormatStore()
  return {
    duration: (seconds: number | null) => display.duration(seconds),
    size: (bytes: number | null) => display.fileSize(bytes)
  }
}
