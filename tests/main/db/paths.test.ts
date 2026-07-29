import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPathHelpers } from '../../../src/main/db/paths'

const windows = createPathHelpers(win32)
const linux = createPathHelpers(posix)

const WIN_ROOT = 'C:\\Users\\Michael\\Music'
const LINUX_ROOT = '/srv/music'

describe('toRelPath', () => {
  it('normalises a Windows path to POSIX separators', () => {
    expect(windows.toRelPath(WIN_ROOT, `${WIN_ROOT}\\Boards of Canada\\Geogaddi\\03.flac`)).toBe(
      'Boards of Canada/Geogaddi/03.flac'
    )
  })

  it('leaves a Linux path in POSIX form', () => {
    expect(linux.toRelPath(LINUX_ROOT, `${LINUX_ROOT}/Boards of Canada/Geogaddi/03.flac`)).toBe(
      'Boards of Canada/Geogaddi/03.flac'
    )
  })

  it('accepts forward slashes in a Windows path', () => {
    // Windows treats both separators as equivalent, and paths arriving from
    // Electron dialogs or drag-and-drop are not consistently backslashed.
    expect(windows.toRelPath('C:/Users/Michael/Music', 'C:/Users/Michael/Music/a/b.mp3')).toBe(
      'a/b.mp3'
    )
  })

  it('tolerates a trailing separator on the root', () => {
    expect(windows.toRelPath(`${WIN_ROOT}\\`, `${WIN_ROOT}\\a.mp3`)).toBe('a.mp3')
    expect(linux.toRelPath(`${LINUX_ROOT}/`, `${LINUX_ROOT}/a.mp3`)).toBe('a.mp3')
  })

  it('matches a Windows root case-insensitively', () => {
    expect(windows.toRelPath(WIN_ROOT, 'c:\\users\\michael\\music\\a.mp3')).toBe('a.mp3')
  })

  it('keeps a Linux root case-sensitive', () => {
    // The mirror of the case above: on ext4 these are genuinely different
    // directories, so treating them as one would index the wrong tree.
    expect(linux.toRelPath(LINUX_ROOT, '/SRV/Music/a.mp3')).toBeNull()
  })

  it('rejects a path outside the root', () => {
    expect(windows.toRelPath(WIN_ROOT, 'C:\\Windows\\System32\\config\\SAM')).toBeNull()
    expect(linux.toRelPath(LINUX_ROOT, '/etc/passwd')).toBeNull()
  })

  it('rejects a sibling directory sharing the root prefix', () => {
    // A naive startsWith would accept this one.
    expect(linux.toRelPath(LINUX_ROOT, '/srv/music-backup/a.mp3')).toBeNull()
    expect(windows.toRelPath(WIN_ROOT, 'C:\\Users\\Michael\\Music Archive\\a.mp3')).toBeNull()
  })

  it('rejects the root itself, which is not a track', () => {
    expect(windows.toRelPath(WIN_ROOT, WIN_ROOT)).toBeNull()
    expect(linux.toRelPath(LINUX_ROOT, LINUX_ROOT)).toBeNull()
  })

  it('rejects a different drive', () => {
    expect(windows.toRelPath(WIN_ROOT, 'D:\\Music\\a.mp3')).toBeNull()
  })

  it('rejects relative input', () => {
    expect(windows.toRelPath('Music', 'Music\\a.mp3')).toBeNull()
    expect(linux.toRelPath(LINUX_ROOT, 'a.mp3')).toBeNull()
  })
})

describe('toAbsPath', () => {
  it('rejoins with the platform separator', () => {
    expect(windows.toAbsPath(WIN_ROOT, 'Boards of Canada/Geogaddi/03.flac')).toBe(
      `${WIN_ROOT}\\Boards of Canada\\Geogaddi\\03.flac`
    )
    expect(linux.toAbsPath(LINUX_ROOT, 'Boards of Canada/Geogaddi/03.flac')).toBe(
      `${LINUX_ROOT}/Boards of Canada/Geogaddi/03.flac`
    )
  })

  it('rejects traversal above the root', () => {
    expect(windows.toAbsPath(WIN_ROOT, '../../../Windows/System32/config/SAM')).toBeNull()
    expect(linux.toAbsPath(LINUX_ROOT, '../../etc/passwd')).toBeNull()
  })

  it('rejects traversal that only escapes after normalisation', () => {
    // Lands back outside despite starting with a real-looking segment.
    expect(linux.toAbsPath(LINUX_ROOT, 'Artist/../../etc/passwd')).toBeNull()
    expect(windows.toAbsPath(WIN_ROOT, 'Artist/../../../Windows/win.ini')).toBeNull()
  })

  it('rejects backslash traversal on Windows', () => {
    // '\' is a separator on win32, so this escapes there even though it is a
    // single segment as far as the POSIX contract is concerned.
    expect(windows.toAbsPath(WIN_ROOT, '..\\..\\..\\Windows\\win.ini')).toBeNull()
  })

  it('treats a backslash as an ordinary character in a Linux filename', () => {
    // The mirror of the case above, and the reason splitting on '\' would be
    // wrong: this is a legal single file on ext4, not two directories.
    expect(linux.toAbsPath(LINUX_ROOT, 'AC\\DC.mp3')).toBe('/srv/music/AC\\DC.mp3')
  })

  it('rejects absolute input under either convention', () => {
    expect(linux.toAbsPath(LINUX_ROOT, '/etc/passwd')).toBeNull()
    expect(windows.toAbsPath(WIN_ROOT, 'C:\\Windows\\win.ini')).toBeNull()
    // A POSIX-rooted rel_path is not absolute to win32's isAbsolute alone,
    // hence checking both flavours regardless of host.
    expect(windows.toAbsPath(WIN_ROOT, '/Windows/win.ini')).toBeNull()
    expect(linux.toAbsPath(LINUX_ROOT, 'C:/Windows/win.ini')).toBeNull()
  })

  it('rejects a UNC path', () => {
    expect(windows.toAbsPath(WIN_ROOT, '\\\\attacker\\share\\payload.mp3')).toBeNull()
  })

  it('rejects empty and no-op input', () => {
    expect(windows.toAbsPath(WIN_ROOT, '')).toBeNull()
    expect(linux.toAbsPath(LINUX_ROOT, '.')).toBeNull()
    expect(linux.toAbsPath(LINUX_ROOT, './')).toBeNull()
  })
})

/**
 * What stops one file being indexed under two roots.
 *
 * `roots.path` is UNIQUE, but that constraint only catches byte-identical
 * strings — it misses every case below, and each of them ends with duplicate
 * `tracks` rows for the same file.
 */
describe('relateRoots', () => {
  it('recognises the identical folder', () => {
    expect(windows.relateRoots(WIN_ROOT, WIN_ROOT)).toBe('same')
    expect(linux.relateRoots(LINUX_ROOT, LINUX_ROOT)).toBe('same')
  })

  it('recognises the same Windows folder spelled differently', () => {
    // All three reach the same directory, and none is caught by UNIQUE(path).
    expect(windows.relateRoots(WIN_ROOT, 'c:\\users\\michael\\music')).toBe('same')
    expect(windows.relateRoots(WIN_ROOT, `${WIN_ROOT}\\`)).toBe('same')
    expect(windows.relateRoots(WIN_ROOT, 'C:/Users/Michael/Music')).toBe('same')
    expect(windows.relateRoots(WIN_ROOT, `${WIN_ROOT}\\Rock\\..`)).toBe('same')
  })

  it('keeps Linux case-sensitive', () => {
    expect(linux.relateRoots(LINUX_ROOT, '/SRV/MUSIC')).toBe('unrelated')
  })

  it('detects a candidate nested inside an existing root', () => {
    expect(windows.relateRoots(WIN_ROOT, `${WIN_ROOT}\\Boards of Canada`)).toBe('inside')
    expect(linux.relateRoots(LINUX_ROOT, '/srv/music/flac/albums')).toBe('inside')
  })

  it('detects a candidate that would swallow an existing root', () => {
    expect(windows.relateRoots(WIN_ROOT, 'C:\\Users\\Michael')).toBe('contains')
    expect(linux.relateRoots(LINUX_ROOT, '/srv')).toBe('contains')
  })

  it('leaves genuinely separate folders alone', () => {
    expect(windows.relateRoots(WIN_ROOT, 'D:\\Music')).toBe('unrelated')
    expect(linux.relateRoots(LINUX_ROOT, '/home/michael/music')).toBe('unrelated')
  })

  it('does not mistake a prefix-sharing sibling for containment', () => {
    // The bug a startsWith comparison would have: these are unrelated folders.
    expect(linux.relateRoots(LINUX_ROOT, '/srv/music-backup')).toBe('unrelated')
    expect(windows.relateRoots(WIN_ROOT, 'C:\\Users\\Michael\\Music Archive')).toBe('unrelated')
  })

  it('refuses to relate non-absolute input', () => {
    expect(linux.relateRoots(LINUX_ROOT, 'music')).toBe('unrelated')
    expect(windows.relateRoots('Music', WIN_ROOT)).toBe('unrelated')
  })
})

/**
 * The criterion with the longest fuse.
 *
 * D11 moves playlists between machines by `rel_path`, so a value written on one
 * platform has to resolve on the other. A regression here does not fail on the
 * machine that caused it — it fails on the other one, months later.
 */
describe('cross-platform round-trip', () => {
  const REL = 'Boards of Canada/Geogaddi/03 - Julie and Candy.flac'

  it('produces an identical stored form on both platforms', () => {
    const fromWindows = windows.toRelPath(WIN_ROOT, `${WIN_ROOT}\\${REL.split('/').join('\\')}`)
    const fromLinux = linux.toRelPath(LINUX_ROOT, `${LINUX_ROOT}/${REL}`)

    expect(fromWindows).toBe(REL)
    expect(fromLinux).toBe(REL)
    // The actual invariant: the database sees one value, not two.
    expect(fromWindows).toBe(fromLinux)
  })

  it('resolves a Windows-written rel_path against a Linux root', () => {
    const rel = windows.toRelPath(WIN_ROOT, `${WIN_ROOT}\\${REL.split('/').join('\\')}`)
    expect(rel).not.toBeNull()
    expect(linux.toAbsPath(LINUX_ROOT, rel!)).toBe(`${LINUX_ROOT}/${REL}`)
  })

  it('resolves a Linux-written rel_path against a Windows root', () => {
    const rel = linux.toRelPath(LINUX_ROOT, `${LINUX_ROOT}/${REL}`)
    expect(rel).not.toBeNull()
    expect(windows.toAbsPath(WIN_ROOT, rel!)).toBe(`${WIN_ROOT}\\${REL.split('/').join('\\')}`)
  })

  it('survives a round-trip back to the originating platform', () => {
    const rel = windows.toRelPath(WIN_ROOT, `${WIN_ROOT}\\${REL.split('/').join('\\')}`)!
    const onLinux = linux.toAbsPath(LINUX_ROOT, rel)!
    const backToRel = linux.toRelPath(LINUX_ROOT, onLinux)!
    const backOnWindows = windows.toAbsPath(WIN_ROOT, backToRel)

    expect(backToRel).toBe(rel)
    expect(backOnWindows).toBe(`${WIN_ROOT}\\${REL.split('/').join('\\')}`)
  })

  it('round-trips non-ASCII and spaces unchanged', () => {
    // Real libraries are full of these; a naive encode/decode step would show up
    // here first.
    const awkward = 'Sigur Rós/( )/03 - Samskeyti.flac'
    const abs = windows.toAbsPath(WIN_ROOT, awkward)!
    expect(windows.toRelPath(WIN_ROOT, abs)).toBe(awkward)
    expect(linux.toRelPath(LINUX_ROOT, linux.toAbsPath(LINUX_ROOT, awkward)!)).toBe(awkward)
  })
})
