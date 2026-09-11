import { describe, expect, it } from 'vitest'
import { readSidecarLyrics, type SidecarFs } from '../../../../src/main/library/lyrics/sidecar'

/**
 * A fake filesystem over a flat map of absolute path → bytes. `readdir` lists a
 * directory's immediate children; `stat`/`readFile` reject for absent paths, the
 * way `node:fs` does, so the reader's degrade-to-null behaviour is exercised for
 * real rather than mocked away.
 */
function fakeFs(files: Record<string, Buffer | string>): SidecarFs {
  const bytes = new Map<string, Buffer>()
  for (const [path, value] of Object.entries(files)) {
    bytes.set(path, typeof value === 'string' ? Buffer.from(value, 'utf-8') : value)
  }
  const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))
  const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
  return {
    readdir: async (dir) => {
      const names = [...bytes.keys()].filter((p) => dirOf(p) === dir).map(nameOf)
      if (names.length === 0) throw new Error('ENOENT')
      return names
    },
    stat: async (path) => {
      const buf = bytes.get(path)
      if (!buf) throw new Error('ENOENT')
      return { size: buf.length }
    },
    readFile: async (path) => {
      const buf = bytes.get(path)
      if (!buf) throw new Error('ENOENT')
      return buf
    }
  }
}

const AUDIO = '/music/Album/Track.flac'

describe('readSidecarLyrics', () => {
  it('finds and parses the exact-case sidecar beside the audio file', async () => {
    const fs = fakeFs({ '/music/Album/Track.lrc': '[00:01.00]hello' })
    const doc = await readSidecarLyrics(AUDIO, fs)
    expect(doc?.synced).toBe(true)
    expect(doc?.source).toBe('sidecar')
    expect(doc?.lines[0]?.text).toBe('hello')
  })

  it('returns null when there is no sidecar', async () => {
    const fs = fakeFs({ '/music/Album/Other.lrc': '[00:01.00]nope' })
    expect(await readSidecarLyrics(AUDIO, fs)).toBeNull()
  })

  it('resolves a case-mismatched extension via the directory scan', async () => {
    // A `Track.LRC` written on Windows must still resolve on case-sensitive Linux.
    const fs = fakeFs({ '/music/Album/Track.LRC': '[00:03.00]cased' })
    const doc = await readSidecarLyrics(AUDIO, fs)
    expect(doc?.lines[0]?.text).toBe('cased')
  })

  it('decodes a non-UTF-8 sidecar as latin-1 rather than returning mojibake', async () => {
    // 0xE9 is 'é' in latin-1 but an invalid lone UTF-8 lead byte.
    const raw = Buffer.concat([Buffer.from('[00:01.00]caf'), Buffer.from([0xe9])])
    const fs = fakeFs({ '/music/Album/Track.lrc': raw })
    const doc = await readSidecarLyrics(AUDIO, fs)
    expect(doc?.lines[0]?.text).toBe('café')
  })

  it('refuses an implausibly large file rather than slurping it', async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024, 0x41) // 2 MiB of 'A'
    const fs = fakeFs({ '/music/Album/Track.lrc': huge })
    expect(await readSidecarLyrics(AUDIO, fs)).toBeNull()
  })

  it('derives the sidecar path from the audio path — never a stored second copy', async () => {
    // The reader is handed only the audio path and must look beside it, swapping
    // the extension. Proof: the sidecar sitting at exactly that derived path is
    // the one it reads, and a same-stem file with a different extension is not.
    const fs = fakeFs({
      '/music/Album/Track.lrc': '[00:01.00]derived',
      '/music/Album/Track.txt': 'not lyrics'
    })
    const doc = await readSidecarLyrics(AUDIO, fs)
    expect(doc?.lines[0]?.text).toBe('derived')
  })
})
