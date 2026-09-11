import { access, rename, unlink } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import type { RipCollision } from '@shared/cdrip'
import { toRelPath } from '../db/paths'
import { reconcilePaths, type ScanDeps } from '../library/scanner'
import type { LibraryStore, RootRow } from '../library/store'

/**
 * The last twenty metres of a rip — **W18-6**.
 *
 * The encoder writes `<final>.<random>.part` next to the destination; this
 * module `rename`s it onto the final name (same-directory, therefore
 * same-device, therefore atomic — W18-4 refused a cross-device dest so this
 * cannot become a copy), then calls `reconcilePaths` with those paths so the
 * library indexes them even when `library.watcherEnabled` is off.
 *
 * Collision policy is applied here, before the encoder runs, so `skip` never
 * rips a byte and `suffix` picks a free sibling rather than looping at the
 * rename. Same discipline as W16's atomic write: never write the final name
 * in place.
 */

/** Cap on `{stem} (n)` so a full folder cannot hang the rip. */
export const MAX_RIP_COLLISION_SUFFIX = 999

export type RipDestResolver = (rootId: number, relPath: string) => string | null

/**
 * Decide the final dest for one track under the operator's collision policy.
 *
 * Returns `'skip'` without touching the filesystem. `overwrite` keeps the
 * existing path — the `.part` sibling is what will replace it. `suffix` walks
 * ` (2)` … ` (999)` and throws if every candidate is taken.
 */
export async function placeRipDest(params: {
  onCollision: RipCollision
  rootId: number
  relPath: string
  absPath: string
  resolvePath: RipDestResolver
}): Promise<'skip' | { relPath: string; absPath: string }> {
  const { onCollision, rootId, relPath, absPath, resolvePath } = params
  const taken = await pathExists(absPath)
  if (!taken) return { relPath, absPath }
  if (onCollision === 'skip') return 'skip'
  if (onCollision === 'overwrite') return { relPath, absPath }

  const ext = posix.extname(relPath)
  const stem = ext === '' ? relPath : relPath.slice(0, relPath.length - ext.length)
  for (let n = 2; n <= MAX_RIP_COLLISION_SUFFIX; n++) {
    const candidate = `${stem} (${n})${ext}`
    const abs = resolvePath(rootId, candidate)
    if (abs === null) continue
    if (!(await pathExists(abs))) return { relPath: candidate, absPath: abs }
  }
  throw new Error('collision suffix exhausted')
}

/**
 * Atomic handoff of a finished `.part` onto `finalAbs`.
 *
 * The part must already be a sibling of the destination — that is the
 * same-device guarantee. `replaceExisting` unlinks first so the rename is
 * portable (Windows will not replace).
 */
export async function commitRipPart(
  partPath: string,
  finalAbs: string,
  replaceExisting: boolean
): Promise<void> {
  if (resolve(dirname(partPath)) !== resolve(dirname(finalAbs))) {
    throw new Error('rip part is not a sibling of the destination')
  }
  if (replaceExisting) await removeQuietly(finalAbs)
  await rename(partPath, finalAbs)
}

/**
 * Index the files just renamed into `root`. Returns their track ids in
 * `absPaths` order.
 *
 * `reconcilePaths` is idempotent on unchanged files, so the watcher's later
 * pass of the same paths is a no-op rather than a second identity.
 */
export async function ingestRippedTracks(
  store: LibraryStore,
  root: Pick<RootRow, 'id' | 'path'>,
  absPaths: readonly string[],
  deps: ScanDeps
): Promise<number[]> {
  if (absPaths.length === 0) return []
  await reconcilePaths(store, root, absPaths, deps)

  const byRel = new Map(
    store.listTrackFiles(root.id).map((file) => [file.relPath, file.id] as const)
  )
  const ids: number[] = []
  for (const absPath of absPaths) {
    const relPath = toRelPath(root.path, absPath)
    if (relPath === null) continue
    const id = byRel.get(relPath)
    if (id !== undefined) ids.push(id)
  }
  return ids
}

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath)
    return true
  } catch {
    return false
  }
}

export async function removeQuietly(absPath: string): Promise<void> {
  try {
    await unlink(absPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
