import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fileStem,
  hasSupportedExtension,
  isSkippedDirectory,
  walkAudioFiles
} from '../../../src/main/library/walk'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oscine-walk-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Creates a file and any parent directories, relative to the temp root. */
function touch(relPath: string, contents = 'x'): string {
  const abs = join(root, ...relPath.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
  return abs
}

async function collect(from: string = root): Promise<string[]> {
  const found: string[] = []
  for await (const file of walkAudioFiles(from)) found.push(file.relPath)
  return found.sort()
}

describe('hasSupportedExtension', () => {
  it('accepts every format the card lists', () => {
    for (const ext of ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'wav']) {
      expect(hasSupportedExtension(`Track.${ext}`)).toBe(true)
    }
  })

  it('ignores case, because Windows filenames routinely shout', () => {
    expect(hasSupportedExtension('TRACK.FLAC')).toBe(true)
    expect(hasSupportedExtension('Track.Mp3')).toBe(true)
  })

  it('rejects the things that live alongside music', () => {
    for (const name of ['cover.jpg', 'album.cue', 'notes.txt', 'folder.jpg', 'playlist.m3u']) {
      expect(hasSupportedExtension(name)).toBe(false)
    }
  })

  it('rejects a name that merely contains an extension', () => {
    expect(hasSupportedExtension('mp3')).toBe(false)
    expect(hasSupportedExtension('my.flac.bak')).toBe(false)
  })
})

describe('isSkippedDirectory', () => {
  it('skips dot directories on every platform', () => {
    expect(isSkippedDirectory('.git')).toBe(true)
    expect(isSkippedDirectory('.Trash-1000')).toBe(true)
  })

  it('skips the Windows and NAS system folders that carry no attribute we can read', () => {
    expect(isSkippedDirectory('$RECYCLE.BIN')).toBe(true)
    expect(isSkippedDirectory('System Volume Information')).toBe(true)
    expect(isSkippedDirectory('@eaDir')).toBe(true)
  })

  it('keeps ordinary music folders', () => {
    expect(isSkippedDirectory('Boards of Canada')).toBe(false)
    expect(isSkippedDirectory('Sigur Rós')).toBe(false)
  })
})

describe('fileStem', () => {
  it('drops the extension', () => {
    expect(fileStem('03 - Julie and Candy.flac')).toBe('03 - Julie and Candy')
  })

  it('takes only the final segment, under either separator', () => {
    expect(fileStem('Artist/Album/03.mp3')).toBe('03')
    expect(fileStem('Artist\\Album\\03.mp3')).toBe('03')
  })

  it('leaves an extensionless name alone', () => {
    expect(fileStem('README')).toBe('README')
  })
})

describe('walkAudioFiles', () => {
  it('finds supported files at every depth', async () => {
    touch('a.mp3')
    touch('Artist/b.flac')
    touch('Artist/Album/c.ogg')
    touch('Artist/Album/Disc 2/d.opus')

    expect(await collect()).toEqual([
      'Artist/Album/Disc 2/d.opus',
      'Artist/Album/c.ogg',
      'Artist/b.flac',
      'a.mp3'
    ])
  })

  it('always stores POSIX separators, whatever the host', async () => {
    touch('Artist/Album/c.ogg')
    const [relPath] = await collect()
    expect(relPath).toBe('Artist/Album/c.ogg')
    expect(relPath).not.toContain('\\')
  })

  it('leaves unsupported files out', async () => {
    touch('cover.jpg')
    touch('album.cue')
    touch('Artist/notes.txt')
    touch('Artist/keep.flac')

    expect(await collect()).toEqual(['Artist/keep.flac'])
  })

  it('does not descend into hidden or system directories', async () => {
    touch('.hidden/skipped.mp3')
    touch('$RECYCLE.BIN/skipped.mp3')
    touch('System Volume Information/skipped.mp3')
    touch('Artist/kept.mp3')

    expect(await collect()).toEqual(['Artist/kept.mp3'])
  })

  it('skips hidden files, including macOS AppleDouble siblings', async () => {
    // `._Track.mp3` carries a supported extension and no audio; parsing every
    // one of them is wasted work on any library that has visited a Mac.
    touch('._Track.mp3')
    touch('Track.mp3')

    expect(await collect()).toEqual(['Track.mp3'])
  })

  it('reports size and mtime for the incremental rescan M3 will need', async () => {
    touch('a.mp3', 'twelve bytes')

    const found = []
    for await (const file of walkAudioFiles(root)) found.push(file)

    expect(found).toHaveLength(1)
    expect(found[0].size).toBe('twelve bytes'.length)
    expect(found[0].mtime).toBeGreaterThan(0)
    expect(Number.isInteger(found[0].mtime)).toBe(true)
  })

  it('yields nothing for a folder with no music, rather than failing', async () => {
    touch('Artist/cover.jpg')
    expect(await collect()).toEqual([])
  })

  it('reports an unreadable directory without abandoning the walk', async () => {
    touch('Artist/kept.mp3')
    const missing = join(root, 'gone')

    const seen: string[] = []
    const errors: string[] = []
    for await (const file of walkAudioFiles(missing, (context) => errors.push(context))) {
      seen.push(file.relPath)
    }

    expect(seen).toEqual([])
    expect(errors).toEqual([missing])
  })
})

/**
 * Symlinks are followed, so a music root can be a folder of links into the real
 * collection — an ordinary Linux arrangement. Following them is what makes a
 * cycle reachable, and a cycle would otherwise be an unbounded scan.
 */
describe('walkAudioFiles and symlinks', () => {
  /** Returns false when the platform refuses to create the link. */
  function trySymlink(target: string, linkPath: string, type: 'dir' | 'file'): boolean {
    try {
      symlinkSync(target, linkPath, type)
      return true
    } catch {
      // Windows needs Developer Mode or elevation for symlinks. Skipping is
      // honest; asserting a pass we did not verify would not be.
      return false
    }
  }

  it('follows a linked directory', async ({ skip }) => {
    const real = mkdtempSync(join(tmpdir(), 'oscine-walk-target-'))
    try {
      writeFileSync(join(real, 'linked.flac'), 'x')
      touch('Artist/direct.mp3')
      if (!trySymlink(real, join(root, 'Linked'), 'dir')) skip()

      expect(await collect()).toEqual(['Artist/direct.mp3', 'Linked/linked.flac'])
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('terminates on a directory cycle instead of scanning forever', async ({ skip }) => {
    touch('Artist/a.mp3')
    if (!trySymlink(root, join(root, 'Artist', 'loop'), 'dir')) skip()

    // The assertion that matters is that this returns at all.
    expect(await collect()).toEqual(['Artist/a.mp3'])
  })

  it('ignores a dangling link without failing the walk', async ({ skip }) => {
    touch('Artist/a.mp3')
    if (!trySymlink(join(root, 'nowhere.mp3'), join(root, 'broken.mp3'), 'file')) skip()

    const errors: string[] = []
    const seen: string[] = []
    for await (const file of walkAudioFiles(root, (context) => errors.push(context))) {
      seen.push(file.relPath)
    }

    expect(seen).toEqual(['Artist/a.mp3'])
    expect(errors).toEqual([join(root, 'broken.mp3')])
  })
})
