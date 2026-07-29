import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { toRelPath } from '../db/paths'

/**
 * The recursive walk that turns a folder into candidate track files.
 *
 * Deliberately Electron-free and generator-shaped. Generator-shaped because a
 * 100k-track library must not be materialised as an array before the first row
 * is written — the caller pulls files, writes a batch, and yields to the event
 * loop between batches. An array-returning walk would spend minutes producing
 * nothing and then commit everything at once.
 */

/** Card scope, verbatim. Lower-case, with the leading dot. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.wav'
]

/**
 * Directories that are never music and are expensive or forbidden to enter.
 *
 * Compared lower-case. Windows offers no portable way to read the hidden and
 * system attributes through `fs.Stats`, so the dot-prefix rule below does not
 * cover its system folders and they have to be named. `@eadir` and `#recycle`
 * are Synology's; a NAS share is a normal place to keep a music library.
 */
const SYSTEM_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '$recycle.bin',
  'system volume information',
  '$windows.~bt',
  '$windows.~ws',
  'lost+found',
  '@eadir',
  '#recycle'
])

export interface AudioFile {
  absPath: string
  /** POSIX-normalised and relative to the root, ready for `tracks.rel_path`. */
  relPath: string
  size: number
  /** Epoch milliseconds, truncated to an integer for the INTEGER column. */
  mtime: number
}

/** Reports a path the walk could not use. Never fatal — the walk continues. */
export type WalkErrorHandler = (context: string, error: unknown) => void

export function hasSupportedExtension(name: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extname(name).toLowerCase())
}

/**
 * Whether to refuse to descend into a directory.
 *
 * The dot-prefix rule covers `.git`, `.Trash` and friends on every platform at
 * once. It is a convention rather than a guarantee, but the failure mode is
 * benign in both directions: a hidden folder of music is not indexed, and a
 * visible junk folder costs one wasted traversal.
 */
export function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SYSTEM_DIRECTORY_NAMES.has(name.toLowerCase())
}

/** Filename without its extension — the display title for an untagged file. */
export function fileStem(pathOrName: string): string {
  const name = pathOrName.split(/[\\/]/).pop() ?? pathOrName
  const ext = extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

/**
 * Every supported audio file below `rootPath`, depth-first.
 *
 * `onError` sees anything unreadable — a permission-denied directory, a file
 * that vanished mid-walk — and the walk carries on. One unreadable folder must
 * not cost the other 99,000 files.
 */
export async function* walkAudioFiles(
  rootPath: string,
  onError: WalkErrorHandler = () => {}
): AsyncGenerator<AudioFile> {
  yield* walkDirectory(rootPath, rootPath, new Set<string>(), onError)
}

/** Walks one subtree while retaining paths relative to the registered root. */
export async function* walkAudioFilesFrom(
  rootPath: string,
  startPath: string,
  onError: WalkErrorHandler = () => {}
): AsyncGenerator<AudioFile> {
  yield* walkDirectory(rootPath, startPath, new Set<string>(), onError)
}

/**
 * Enumerates watch targets. There is one native handle per directory, never
 * per track, which keeps Linux inotify consumption proportional to the folder
 * tree rather than the size of the music collection.
 */
export async function listLibraryDirectories(
  rootPath: string,
  onError: WalkErrorHandler = () => {}
): Promise<string[]> {
  const directories: string[] = []
  await collectDirectories(rootPath, new Set<string>(), directories, onError)
  return directories
}

async function collectDirectories(
  dirPath: string,
  visited: Set<string>,
  directories: string[],
  onError: WalkErrorHandler
): Promise<void> {
  let realDirPath: string
  try {
    realDirPath = await realpath(dirPath)
  } catch (error) {
    onError(dirPath, error)
    return
  }
  if (visited.has(realDirPath)) return
  visited.add(realDirPath)

  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch (error) {
    onError(dirPath, error)
    return
  }
  directories.push(dirPath)

  for (const entry of entries) {
    if (isSkippedDirectory(entry.name)) continue
    const childPath = join(dirPath, entry.name)
    let isDirectory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = (await stat(childPath)).isDirectory()
      } catch (error) {
        onError(childPath, error)
        continue
      }
    }
    if (isDirectory) {
      await collectDirectories(childPath, visited, directories, onError)
    }
  }
}

async function* walkDirectory(
  rootPath: string,
  dirPath: string,
  visited: Set<string>,
  onError: WalkErrorHandler
): AsyncGenerator<AudioFile> {
  // Symlinks are resolved rather than refused: pointing a root at a folder of
  // links into the real collection is a normal Linux arrangement. That makes
  // cycles reachable, so identity is tracked by real path — without this, a
  // directory linking to its own ancestor is an infinite scan, which presents
  // as a hang rather than as an error.
  let realDirPath: string
  try {
    realDirPath = await realpath(dirPath)
  } catch (error) {
    onError(dirPath, error)
    return
  }
  if (visited.has(realDirPath)) return
  visited.add(realDirPath)

  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch (error) {
    onError(dirPath, error)
    return
  }

  for (const entry of entries) {
    const childPath = join(dirPath, entry.name)

    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()

    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(childPath)
        isDirectory = target.isDirectory()
        isFile = target.isFile()
      } catch (error) {
        // A dangling link. Common in synced folders; not worth failing over.
        onError(childPath, error)
        continue
      }
    }

    if (isDirectory) {
      if (isSkippedDirectory(entry.name)) continue
      yield* walkDirectory(rootPath, childPath, visited, onError)
      continue
    }

    // Sockets, FIFOs and device nodes are neither, and `stat` on some of them
    // blocks. Skipping anything that is not a plain file is the safe default.
    if (!isFile) continue

    // Hidden files by the same convention as directories. This is also what
    // discards macOS AppleDouble siblings (`._Track.mp3`), which carry a
    // supported extension and no audio.
    if (entry.name.startsWith('.')) continue
    if (!hasSupportedExtension(entry.name)) continue

    const relPath = toRelPath(rootPath, childPath)
    if (relPath === null) {
      // Only reachable if a link resolved outside the root. Storing it would
      // put a path in `rel_path` that `toAbsPath` will later refuse to rejoin.
      onError(childPath, new Error('resolves outside its library root'))
      continue
    }

    try {
      const info = await stat(childPath)
      yield {
        absPath: childPath,
        relPath,
        size: info.size,
        mtime: Math.floor(info.mtimeMs)
      }
    } catch (error) {
      onError(childPath, error)
    }
  }
}
