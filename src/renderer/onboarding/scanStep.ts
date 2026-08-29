/**
 * The scan step's view of `roots.scan`.
 *
 * It only reads. Indexing was kicked off when the folder was added (D-ONB-2);
 * this step visualizes whatever is already underway and never starts a scan.
 * Finish is skippable on the step declaration, so it is not gated on these
 * numbers.
 *
 * `scan === null` is both "not yet reporting" and "already finished". The
 * library's track count is the only honest extra signal without a second
 * scan-state source: a re-run with a library already present shows as ready,
 * a first-run still waiting on the first progress event says the work is in
 * the background.
 */

import type { ScanProgress } from '@shared/library'
import { scanCountsLabel, scanFileLabel } from '../shell/scanProgress'

export interface ScanStepView {
  readonly active: boolean
  readonly headline: string
  readonly counts: string | null
  readonly file: string | null
}

export function describeScanStep(scan: ScanProgress | null, trackCount: number): ScanStepView {
  if (scan) {
    return {
      active: true,
      headline: 'Indexing…',
      counts: scanCountsLabel(scan),
      file: scanFileLabel(scan)
    }
  }

  if (trackCount > 0) {
    const tracks = trackCount === 1 ? '1 track is' : `${trackCount.toLocaleString()} tracks are`
    return {
      active: false,
      headline: 'Your library is ready',
      counts: `${tracks} already in the library`,
      file: null
    }
  }

  return {
    active: false,
    headline: 'Indexing in the background',
    counts: null,
    file: null
  }
}

export function libraryTrackCount(roots: readonly { trackCount: number }[]): number {
  return roots.reduce((total, root) => total + root.trackCount, 0)
}
