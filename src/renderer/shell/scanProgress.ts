/**
 * How a live scan is written in the chrome.
 *
 * `useLibraryRootsStore().scan` is the one source of truth (the onboarding
 * scan step, the title-bar chip, and the Library sidebar all read it). These
 * helpers are the wording so those three surfaces cannot drift: a basename
 * here, counts as "found · indexed", and "Reading folders…" when the walker
 * has not named a file yet. `currentFile` is already a basename — main never
 * sends a path.
 *
 * No `@renderer` alias: tests import this under the node config, which maps
 * `@shared` only.
 */

import type { ScanProgress } from '@shared/library'

export function scanCountsLabel(scan: Pick<ScanProgress, 'filesSeen' | 'tracksIndexed'>): string {
  return `${scan.filesSeen.toLocaleString()} found · ${scan.tracksIndexed.toLocaleString()} indexed`
}

export function scanFileLabel(scan: Pick<ScanProgress, 'currentFile'>): string {
  return scan.currentFile ?? 'Reading folders…'
}

/** Compact title-bar chip. Tracks indexed is the number the operator is waiting on. */
export function indexingChipLabel(scan: Pick<ScanProgress, 'tracksIndexed'>): string {
  return `Indexing · ${scan.tracksIndexed.toLocaleString()}`
}

export function indexingChipDetail(scan: ScanProgress): string {
  return `${scanCountsLabel(scan)}. ${scanFileLabel(scan)}`
}
