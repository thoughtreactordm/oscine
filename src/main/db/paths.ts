import nodePath, { posix, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'

/**
 * Conversion between absolute filesystem paths and the POSIX-normalised
 * `tracks.rel_path` stored in the database.
 *
 * Design section 4 calls this "the single most important detail for
 * Windows/Linux portability", and D11's export bundle is what makes it matter: a
 * `rel_path` written on Windows has to resolve against a Linux root months
 * later. That only holds if the stored form is separator-neutral, which is why
 * storage is always POSIX and rejoining is always per-platform.
 *
 * `toAbsPath` is also a security boundary. W2-2 wires it into
 * `resolveTrackPath`, which feeds the `oscine://` protocol handler — if a
 * crafted `rel_path` could escape its root, the renderer would gain the
 * arbitrary-file-read primitive that `src/shared`'s pathless `Track` exists to
 * deny it.
 */
/**
 * How a candidate folder sits relative to one already in the library.
 *
 * Only `'unrelated'` is safe to add. The other three all end with the same file
 * indexed under two roots — two `tracks` rows, two ids, and a track that appears
 * twice in every list. The UNIQUE constraint on `roots.path` catches none of
 * them: `'same'` escapes it whenever the two strings differ only by case or a
 * trailing separator, and the nesting cases are distinct paths by any measure.
 */
export type RootRelation = 'same' | 'inside' | 'contains' | 'unrelated'

export interface PathHelpers {
  /**
   * Absolute path to the stored form, relative to `rootPath`.
   *
   * Returns `null` when either argument is not absolute, or when `absPath` is
   * not strictly inside `rootPath` — a root is not a track, so the root itself
   * is rejected too.
   */
  toRelPath(rootPath: string, absPath: string): string | null
  /**
   * Stored form back to an absolute path, using this platform's separator.
   *
   * Returns `null` for anything that does not land strictly inside `rootPath`,
   * including absolute inputs and `..` traversal.
   */
  toAbsPath(rootPath: string, relPath: string): string | null
  /** How `candidate` relates to the already-registered root `existing`. */
  relateRoots(existing: string, candidate: string): RootRelation
}

/**
 * Whether `candidate` sits strictly below `root` under this path flavour.
 *
 * `relative` already applies the right comparison rules per flavour — notably
 * case-insensitivity and drive letters on win32 — so containment is expressed in
 * terms of what it returns rather than by comparing strings.
 */
function isStrictlyInside(impl: PlatformPath, root: string, candidate: string): boolean {
  const rel = impl.relative(root, candidate)
  if (rel === '') return false // the root itself
  if (rel === '..' || rel.startsWith(`..${impl.sep}`)) return false // above the root
  return !impl.isAbsolute(rel) // a different drive or share
}

/**
 * Builds helpers bound to one path flavour.
 *
 * Exported so tests can drive win32 and posix semantics on a single machine.
 * Production code should use the host-bound `toRelPath` / `toAbsPath` below.
 */
export function createPathHelpers(impl: PlatformPath): PathHelpers {
  function toRelPath(rootPath: string, absPath: string): string | null {
    if (!impl.isAbsolute(rootPath) || !impl.isAbsolute(absPath)) return null

    const root = impl.normalize(rootPath)
    const abs = impl.normalize(absPath)
    if (!isStrictlyInside(impl, root, abs)) return null

    // The only place a platform separator becomes a stored '/'.
    return impl.relative(root, abs).split(impl.sep).join('/')
  }

  function toAbsPath(rootPath: string, relPath: string): string | null {
    if (!impl.isAbsolute(rootPath) || relPath === '') return null

    // Absolute under *either* flavour: `join` would otherwise honour a stored
    // '/etc/passwd' or 'C:\Windows' as a root of its own on the matching
    // platform. Neither is a legal rel_path, so reject both everywhere.
    if (posix.isAbsolute(relPath) || win32.isAbsolute(relPath)) return null

    // Split on '/' only, never on '\'. Backslash is a legal character in a
    // Linux filename, and treating it as a separator here would silently
    // resolve `a\b.flac` to the wrong file. Traversal is caught by the
    // containment check below instead, which holds under both flavours.
    const segments = relPath.split('/').filter((segment) => segment !== '' && segment !== '.')
    if (segments.length === 0) return null

    const root = impl.normalize(rootPath)
    const abs = impl.join(root, ...segments)

    // The authoritative guard. `join` has already collapsed any '..' — including
    // a backslash-separated one that only means traversal on Windows — so this
    // sees the real destination rather than the requested one.
    return isStrictlyInside(impl, root, abs) ? abs : null
  }

  function relateRoots(existing: string, candidate: string): RootRelation {
    if (!impl.isAbsolute(existing) || !impl.isAbsolute(candidate)) return 'unrelated'

    const a = impl.normalize(existing)
    const b = impl.normalize(candidate)

    // `relative` returning empty is the same-folder test, and it is the reason
    // this is not a string comparison: under win32 it also folds case and
    // trailing separators, so `C:\Music`, `c:\music\` and `C:\Music` all agree.
    if (impl.relative(a, b) === '') return 'same'
    if (isStrictlyInside(impl, a, b)) return 'inside'
    if (isStrictlyInside(impl, b, a)) return 'contains'
    return 'unrelated'
  }

  return { toRelPath, toAbsPath, relateRoots }
}

const host = createPathHelpers(nodePath)

/** Host-platform binding of {@link PathHelpers.toRelPath}. */
export const toRelPath = host.toRelPath

/** Host-platform binding of {@link PathHelpers.toAbsPath}. */
export const toAbsPath = host.toAbsPath

/** Host-platform binding of {@link PathHelpers.relateRoots}. */
export const relateRoots = host.relateRoots
