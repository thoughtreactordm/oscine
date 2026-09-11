import { promises as nodeFs } from 'node:fs'
import nodePath from 'node:path'
import { parseLrc, type LyricsDocument } from '@shared/lyrics'

/**
 * Tier 1 of the resolution chain: a sidecar `.lrc` beside the audio file.
 *
 * First among the tiers because the operator put it there deliberately, so it
 * must beat anything the app found on its own (embedded tags, the network).
 *
 * ## The path invariant applies
 *
 * The caller passes an *already-resolved* absolute audio path — the one
 * `store.resolveTrackPath` rejoined from `tracks.rel_path` and its root. The
 * sidecar path is derived from it here, on read, and **never stored**: there is
 * no second copy of the path anywhere, which is the whole point of deriving it.
 */

/**
 * A `.lrc` is kilobytes. This ceiling refuses anything implausible rather than
 * slurping a multi-megabyte file that merely happens to share the basename — a
 * misplaced download, say — into memory as though it were lyrics.
 */
const MAX_SIDECAR_BYTES = 256 * 1024

/**
 * Filesystem seam. Defaults to `node:fs`; tests inject a fake so the resolver
 * runs without touching disk. The three operations are exactly what sidecar
 * resolution needs and no more.
 */
export interface SidecarFs {
  readdir: (dir: string) => Promise<string[]>
  stat: (absPath: string) => Promise<{ size: number }>
  readFile: (absPath: string) => Promise<Buffer>
}

const defaultFs: SidecarFs = {
  readdir: (dir) => nodeFs.readdir(dir),
  stat: async (absPath) => ({ size: (await nodeFs.stat(absPath)).size }),
  readFile: (absPath) => nodeFs.readFile(absPath)
}

/**
 * Resolve and parse the sidecar `.lrc` for an audio file, or `null` when there
 * is none (or it is implausibly large, or unreadable).
 *
 * Search order is **exact-case first, then a case-insensitive directory match**.
 * Linux is case-sensitive, so a `Track.LRC` written on Windows beside a
 * `Track.flac` is a real file that must still resolve — but the exact-case probe
 * comes first so the common case costs one `stat`, not a directory listing.
 */
export async function readSidecarLyrics(
  audioAbsPath: string,
  fs: SidecarFs = defaultFs
): Promise<LyricsDocument | null> {
  const dir = nodePath.dirname(audioAbsPath)
  const ext = nodePath.extname(audioAbsPath)
  const targetName = `${nodePath.basename(audioAbsPath, ext)}.lrc`

  const exact = await readAt(nodePath.join(dir, targetName), fs)
  if (exact !== null) return exact

  // Case-insensitive fallback. Only the directory the audio file lives in is
  // scanned, and only when the exact name was absent.
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  const wanted = targetName.toLowerCase()
  const match = entries.find((name) => name !== targetName && name.toLowerCase() === wanted)
  if (match === undefined) return null
  return readAt(nodePath.join(dir, match), fs)
}

/**
 * Read one candidate path. Returns `null` — never throws — when the file is
 * absent, too large, or unreadable, so a missing or junk sidecar degrades to
 * the next tier rather than taking out the pane.
 */
async function readAt(absPath: string, fs: SidecarFs): Promise<LyricsDocument | null> {
  let size: number
  try {
    size = (await fs.stat(absPath)).size
  } catch {
    return null
  }
  if (size > MAX_SIDECAR_BYTES) return null

  let bytes: Buffer
  try {
    bytes = await fs.readFile(absPath)
  } catch {
    return null
  }
  return parseLrc(decodeText(bytes), 'sidecar')
}

/**
 * Decode as UTF-8, falling back to latin-1 on invalid UTF-8.
 *
 * Old `.lrc` files are frequently not UTF-8, and returning mojibake would be
 * worse than a wrong-but-legible latin-1 read. A fatal `TextDecoder` is the
 * detector: it throws on an invalid sequence rather than silently substituting
 * U+FFFD, which is exactly the signal we want. A leading BOM is stripped by the
 * decoder and again by `parseLrc`, so either path is safe.
 */
function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}
