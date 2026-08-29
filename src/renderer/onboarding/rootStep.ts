/**
 * First-run root step: at most one folder, and indexing starts as soon as it
 * exists (D-ONB-2, D-ONB-3).
 *
 * `addRoot` already kicks off a scan on the main side; calling `scanRoot`
 * joins that in-flight promise rather than starting a second one. We still
 * call it — that is the renderer contract — and we do not await it, because
 * Next must not wait for indexing. The Scan step only visualizes this; it
 * does not start it.
 */

import type { LibraryRoot } from '@shared/library'

export function hasOnboardingRoot(roots: readonly Pick<LibraryRoot, 'id'>[]): boolean {
  return roots.length > 0
}

export interface PickOnboardingRootDeps {
  roots: readonly LibraryRoot[]
  addRoot: () => Promise<LibraryRoot | null>
  scanRoot: (rootId: number) => Promise<unknown>
}

/**
 * Opens the folder picker, or returns the root already in the library.
 *
 * Re-running from Settings must not duplicate a folder: if one exists we
 * return it and do not open the dialog, and we do not start another scan.
 * A cancelled dialog is `null` and is not an error.
 */
export async function pickOnboardingRoot(
  deps: PickOnboardingRootDeps
): Promise<LibraryRoot | null> {
  const existing = deps.roots[0]
  if (existing) return existing

  const root = await deps.addRoot()
  if (root === null) return null

  // Fire and forget: a real library takes minutes, and the operator is meant
  // to walk the rest of the wizard while this runs. A rejection is already
  // logged on the main side; swallowing here keeps Next unblocked.
  void deps.scanRoot(root.id).catch(() => {})
  return root
}
