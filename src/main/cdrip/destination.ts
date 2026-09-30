import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { RipDestinationProbe, RipDestinationResult, RipDestinationRoot } from '@shared/cdrip'
import { relateRoots, toRelPath } from '../db/paths'

/**
 * Decide whether a chosen folder is a legal rip destination.
 *
 * Lives in main because it stats the folder, and `src/shared` does not import
 * Node — the renderer will call this over IPC from the rip pane, not by bundling `fs`.
 * Path maths (outside a root, parent of a root) run before any I/O so a missing
 * folder that is also the parent of a root reports `outside-roots`, which is
 * the reason the operator can act on (add it as a root), not `not-writable`.
 *
 * Cross-device is the ingest invariant: the encoder writes a `.part` next to the
 * final name and `rename`s it into place. A destination on another volume makes
 * that rename a copy, and a crash mid-copy leaves a half file in a watched root.
 */
export function validateRipDestination(
  absDir: string,
  roots: readonly RipDestinationRoot[],
  probe: RipDestinationProbe = hostProbe
): RipDestinationResult {
  if (!isAbsolute(absDir)) return { ok: false, reason: 'outside-roots' }

  const match = matchingRoot(absDir, roots)
  if (!match) return { ok: false, reason: 'outside-roots' }

  if (!probe.isDirectory(absDir)) return { ok: false, reason: 'not-writable' }
  if (!probe.isWritable(absDir)) return { ok: false, reason: 'not-writable' }

  const destDev = probe.deviceId(absDir)
  const rootDev = probe.deviceId(match.path)
  if (destDev == null || rootDev == null) return { ok: false, reason: 'not-writable' }
  if (destDev !== rootDev) return { ok: false, reason: 'cross-device' }

  const relDir = match.same ? '' : toRelPath(match.path, absDir)
  if (relDir == null && !match.same) return { ok: false, reason: 'outside-roots' }

  return { ok: true, rootId: match.id, relDir: relDir ?? '' }
}

function matchingRoot(
  absDir: string,
  roots: readonly RipDestinationRoot[]
): { id: number; path: string; same: boolean } | null {
  let best: { id: number; path: string; same: boolean; length: number } | null = null
  for (const root of roots) {
    const relation = relateRoots(root.path, absDir)
    if (relation !== 'same' && relation !== 'inside') continue
    const length = root.path.length
    if (best && length <= best.length) continue
    best = { id: root.id, path: root.path, same: relation === 'same', length }
  }
  return best
}

const hostProbe: RipDestinationProbe = {
  isDirectory(absPath) {
    try {
      return statSync(absPath).isDirectory()
    } catch {
      return false
    }
  },
  isWritable(absPath) {
    try {
      accessSync(absPath, constants.W_OK)
      return true
    } catch {
      return false
    }
  },
  deviceId(absPath) {
    try {
      return statSync(absPath).dev
    } catch {
      return null
    }
  }
}
