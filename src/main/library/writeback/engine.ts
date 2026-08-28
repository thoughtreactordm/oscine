import { randomBytes } from 'node:crypto'
import { copyFile, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { File as TagFile } from 'node-taglib-sharp'
import { splitGenres } from '@shared/genre'
import type { WritebackFailureCode } from '@shared/tagWriteback'
import { readTrackTags, type MetadataReader, type TrackTags } from '../metadata'
import {
  applyWritableTags,
  resolveCodecWriter,
  type WritableTags,
  type WritebackCodec
} from './writer'

/**
 * The atomic tag-write engine — **W16-3**, design authority `oscine-tag-writeback`
 * → "The write engine" + "Atomic write + backup + rollback". Owns **R6
 * (tag-write corruption)**, the one Oscine operation that can destroy an
 * operator's file. Main-process only (the renderer never touches the filesystem).
 *
 * ## Atomicity — never mutate the original in place
 *
 * D7's "atomic-write handling" precondition, discharged literally:
 *
 *   1. Copy the original to a temp sibling in the **same directory**, so the
 *      later rename stays on one filesystem and is therefore atomic.
 *   2. Apply the tags to the *copy* — the container library rewrites the tag
 *      region of the temp, never the original, and never a byte of audio.
 *   3. `fsync` the temp so its bytes are on disk before it becomes the original.
 *   4. Move the original aside to a backup sibling, then atomic-`rename` the temp
 *      into its place. The backup is a same-directory rename — metadata moves, so
 *      a large FLAC is never copied a second time — and the untouched original
 *      survives there byte-identical until the verify clears or restores it.
 *   5. Re-read the file and verify the tags read back as intended. On any mismatch
 *      or read failure, rename the backup back over the write so the file is left
 *      byte-identical, and report the file failed; on success, drop the backup.
 *
 * The backup-and-rollback in steps 4–5 is the recoverability half of R6's
 * mitigation (**W16-4**). Any failure *before* the original is moved aside removes
 * the temp and returns the original byte-identical — the copy-then-swap shape gives
 * that for free. Once the swap has happened a failed verify is no longer a dead
 * end: the preserved backup is rolled back over the bad write, so a *post*-rename
 * failure is recoverable too. This engine reports a per-file outcome and never
 * throws for a per-file problem, so one file's failure cannot abort a batch.
 *
 * Cross-platform throughout: paths go through `node:path`, the temp sibling keeps
 * the original extension so the container is detected the same way, and the one
 * durability step the platforms disagree on (a directory `fsync`) is best-effort.
 */

/**
 * Why a write did not complete. Each maps to a distinct per-file report line.
 *
 * Sourced from `@shared/tagWriteback` so the engine's codes and the review's
 * renderer-safe {@link WritebackFailureCode} are one union, not two that drift.
 */
export type WriteFailureCode = WritebackFailureCode

/** The result of writing one file: a success with its codec, or a typed failure. */
export type WriteOutcome =
  | { readonly ok: true; readonly codec: WritebackCodec; readonly path: string }
  | {
      readonly ok: false
      readonly code: WriteFailureCode
      readonly reason: string
      readonly path: string
    }

/**
 * Injectable seams, defaulting to the real container and reader.
 *
 * `applyTags` is the container write (default: node-taglib-sharp on the temp
 * copy); `read` is the verification read (default: the same `readTrackTags` the
 * diff mints `current` from, so the write is verified through the exact reader
 * the app will re-scan it with). Both are injected for the same reason the differ
 * injects its reader: the atomic mechanics can then be exercised without a real
 * audio file or a native tag library.
 */
export interface WriteEngineDeps {
  readonly applyTags?: (tempPath: string, desired: WritableTags) => void
  readonly read?: MetadataReader
}

/** The default container write: open the temp copy, set the fields, save, close. */
function applyViaTaglib(tempPath: string, desired: WritableTags): void {
  const file = TagFile.createFromPath(tempPath)
  try {
    applyWritableTags(file, desired)
    file.save()
  } finally {
    file.dispose()
  }
}

/**
 * A hidden temp/backup sibling of `absPath`, keeping its extension.
 *
 * Same directory so the rename is same-filesystem and atomic; a random suffix so
 * two concurrent flushes of one file cannot collide on the name; the original
 * extension retained so the container library detects the format from the temp
 * exactly as it would from the original. `role` distinguishes the staging copy
 * (`tmp`) from the original-preserving backup (`bak`); both carry the shared
 * `oscine-wb-` infix so a crash-orphaned sibling is recognisable and the
 * atomicity tests can assert none was left behind.
 */
function hiddenSibling(absPath: string, role: 'tmp' | 'bak'): string {
  const ext = extname(absPath)
  const base = basename(absPath, ext)
  return join(
    dirname(absPath),
    `.${base}.oscine-wb-${role}-${randomBytes(6).toString('hex')}${ext}`
  )
}

/** `fsync` a path's data to disk, then close the handle. */
async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Best-effort `fsync` of a directory so the rename itself is durable.
 *
 * POSIX makes a directory `fsync` the way to persist a rename; Windows has no
 * equivalent and rejects a directory handle here. Swallowing that is not a
 * platform branch — it is one uniform attempt that degrades to a no-op wherever
 * the OS declines it, the rename having already flushed the file data above.
 */
async function bestEffortDirSync(dir: string): Promise<void> {
  try {
    const handle = await open(dir)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync unsupported on this platform; the file data is already durable.
  }
}

/** Remove a temp file, ignoring the case where it is already gone. */
async function safeUnlink(path: string): Promise<void> {
  await unlink(path).catch(() => {})
}

/**
 * Roll the preserved original back over a failed write, byte-identical.
 *
 * `backup` holds the original file moved aside before the swap; renaming it over
 * `absPath` atomically replaces the bad write with the untouched original, then a
 * best-effort directory `fsync` makes that restoration durable. A failure here is
 * the one case the engine cannot paper over — it leaves the backup on disk under
 * its recognisable name rather than deleting the only good copy, and the caller
 * still reports the file failed.
 */
async function rollback(backup: string, absPath: string): Promise<void> {
  try {
    await rename(backup, absPath)
    await bestEffortDirSync(dirname(absPath))
  } catch {
    // Restore failed; the original survives at `backup` for manual recovery.
  }
}

/** A string tag trimmed to the reader's rule: whitespace-only reads back as absent. */
function normText(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Whether the file now holds the desired tags, or the first field that does not.
 *
 * Verifies through `after` — a fresh read from the production reader — so a pass
 * means a re-scan would see exactly the merged state, not merely that the
 * container library agrees with itself. Genre is compared as the frame the app
 * derives (`splitGenres` of the first value), because that, not the raw bytes, is
 * what the write is trying to make true; a label that cannot survive the join and
 * re-split (one containing a `;`, `/` or `,`) surfaces here as a mismatch rather
 * than as silent drift, which is the honest result for the one write that can
 * corrupt.
 */
function verify(after: TrackTags, desired: WritableTags): string | null {
  const scalar: ReadonlyArray<[string, string | number | null, string | number | null]> = [
    ['title', after.title, normText(desired.title)],
    ['artist', after.artist, normText(desired.artist)],
    ['album', after.album, normText(desired.album)],
    ['year', after.year, desired.year],
    ['track', after.trackNo, desired.trackNo],
    ['disc', after.discNo, desired.discNo]
  ]
  for (const [field, got, want] of scalar) {
    if (got !== want) {
      return `${field}: expected ${JSON.stringify(want)} but file holds ${JSON.stringify(got)}`
    }
  }

  const gotGenres = splitGenres(after.genre)
  const wantGenres = desired.genres
  const genreMatch =
    gotGenres.length === wantGenres.length &&
    gotGenres.every((g, i) => g.key === wantGenres[i].key && g.genre === wantGenres[i].label)
  if (!genreMatch) {
    const shown = gotGenres.map((g) => g.genre)
    const target = wantGenres.map((g) => g.label)
    return `genres: expected ${JSON.stringify(target)} but file holds ${JSON.stringify(shown)}`
  }

  return null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Writes `desired` into the file at `absPath`, atomically, and verifies it.
 *
 * Returns a per-file {@link WriteOutcome} and never throws for a per-file
 * problem, so a batch caller (W16-6) can report each file and keep going. Refuses
 * a format outside the v1 codec set before touching the file. Whether the write
 * fails before the swap or fails verify after it, the file is left byte-identical
 * to its pre-flush state — the pre-swap failures never touch it, the post-swap
 * ones roll the preserved backup back over it.
 */
export async function writeTags(
  absPath: string,
  desired: WritableTags,
  deps: WriteEngineDeps = {}
): Promise<WriteOutcome> {
  const writer = resolveCodecWriter(absPath)
  if (writer === null) {
    return {
      ok: false,
      code: 'unsupported-format',
      reason: `refusing ${extname(absPath) || '(no extension)'}: not a v1 write-back codec`,
      path: absPath
    }
  }

  const apply = deps.applyTags ?? applyViaTaglib
  const read = deps.read ?? readTrackTags
  const temp = hiddenSibling(absPath, 'tmp')
  const backup = hiddenSibling(absPath, 'bak')

  // Stage the write on a temp copy. Any failure here leaves the original intact.
  try {
    await copyFile(absPath, temp)
    apply(temp, desired)
    await fsyncPath(temp)
  } catch (error) {
    await safeUnlink(temp)
    return { ok: false, code: 'write-failed', reason: message(error), path: absPath }
  }

  // Move the original aside so a bad write stays recoverable, then swap the staged
  // copy into its place. Both are same-directory renames — metadata moves, never a
  // second full copy — so a large FLAC is not doubled on disk. A failure moving the
  // original aside leaves it exactly where it was.
  try {
    await rename(absPath, backup)
  } catch (error) {
    await safeUnlink(temp)
    return { ok: false, code: 'write-failed', reason: message(error), path: absPath }
  }
  try {
    await rename(temp, absPath)
  } catch (error) {
    // The swap failed with the original already moved aside; put it back.
    await rollback(backup, absPath)
    await safeUnlink(temp)
    return { ok: false, code: 'write-failed', reason: message(error), path: absPath }
  }
  await bestEffortDirSync(dirname(absPath))

  // Read-back verify. On any mismatch or read failure the write is unsound, so roll
  // the preserved original back over it — leaving the file byte-identical to its
  // pre-flush state — and report the file failed without aborting the batch.
  let mismatch: string | null
  try {
    mismatch = verify(await read(absPath), desired)
  } catch (error) {
    await rollback(backup, absPath)
    return { ok: false, code: 'verify-failed', reason: message(error), path: absPath }
  }
  if (mismatch !== null) {
    await rollback(backup, absPath)
    return { ok: false, code: 'verify-failed', reason: mismatch, path: absPath }
  }

  // The write stands; drop the now-superfluous backup.
  await safeUnlink(backup)
  return { ok: true, codec: writer.codec, path: absPath }
}
