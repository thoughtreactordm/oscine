import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import {
  M3U8_EXTENSION,
  renderM3u8,
  suggestedFileName,
  withM3u8Extension,
  type M3uTrack
} from '../../../src/main/library/playlists/m3u8'
import { SqlitePlaylistService } from '../../../src/main/library/playlists/service'
import { PlaylistStore } from '../../../src/main/library/playlists/store'
import { isOscineError } from '../../../src/shared/errors'

/**
 * D12's export, and the reason it is a card of its own: the format is four
 * lines of string building and the paths are the entire problem.
 *
 * The renderer is driven under both path flavours from whichever machine runs
 * the suite, because a Windows separator bug is invisible on Linux and a POSIX
 * one is invisible on Windows — a test that only proves the host's flavour
 * proves the half of the invariant that was never in danger.
 */

function track(overrides: Partial<M3uTrack> = {}): M3uTrack {
  return {
    absPath: '/srv/music/Artist/Album/01.flac',
    durationSec: 210,
    artist: 'Artist',
    title: 'Song',
    ...overrides
  }
}

describe('renderM3u8', () => {
  it('writes the header, one EXTINF and one location per entry, and a trailing newline', () => {
    const text = renderM3u8(
      [
        track({ absPath: '/srv/music/a.flac', title: 'First', durationSec: 210 }),
        track({ absPath: '/srv/music/b.flac', title: 'Second', durationSec: 61.4 })
      ],
      { destination: '/srv/music/mix.m3u8', pathStyle: 'relative', path: posix }
    )

    expect(text).toBe(
      [
        '#EXTM3U',
        '#EXTINF:210,Artist - First',
        'a.flac',
        '#EXTINF:61,Artist - Second',
        'b.flac',
        ''
      ].join('\n')
    )
  })

  it('emits an empty playlist as a bare header rather than an empty file', () => {
    expect(
      renderM3u8([], { destination: '/srv/music/mix.m3u8', pathStyle: 'absolute', path: posix })
    ).toBe('#EXTM3U\n')
  })

  it('rounds fractional seconds and marks an unknown duration as -1', () => {
    const text = renderM3u8(
      [
        track({ durationSec: 249.6, title: 'Rounded' }),
        track({ durationSec: null, title: 'Unknown' }),
        track({ durationSec: 0.2, title: 'Tiny' })
      ],
      { destination: '/srv/music/mix.m3u8', pathStyle: 'absolute', path: posix }
    )

    expect(text).toContain('#EXTINF:250,Artist - Rounded')
    expect(text).toContain('#EXTINF:-1,Artist - Unknown')
    expect(text).toContain('#EXTINF:0,Artist - Tiny')
  })

  it('drops the artist half when there is no artist, and falls back to the filename', () => {
    const text = renderM3u8(
      [
        track({ artist: null, title: 'Untitled Instrumental' }),
        track({ absPath: '/srv/music/unknown-42.flac', artist: null, title: '   ' })
      ],
      { destination: '/srv/music/mix.m3u8', pathStyle: 'absolute', path: posix }
    )

    expect(text).toContain('#EXTINF:210,Untitled Instrumental\n')
    expect(text).toContain('#EXTINF:210,unknown-42.flac\n')
  })

  /**
   * The one case where a tag can do structural damage: a newline inside it
   * would close the record and let the rest be read as a location.
   */
  it('folds line breaks out of a tag so an entry cannot be injected', () => {
    const text = renderM3u8(
      [track({ artist: 'Evil\n/etc/passwd\n#EXTINF:1', title: 'Song\rTwo' })],
      { destination: '/srv/music/mix.m3u8', pathStyle: 'absolute', path: posix }
    )

    expect(text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXTINF:210,Evil /etc/passwd #EXTINF:1 - Song Two',
      '/srv/music/Artist/Album/01.flac',
      ''
    ])
  })

  describe('locations under posix', () => {
    const options = { pathStyle: 'relative', path: posix } as const

    it('addresses a track below the destination without a leading separator', () => {
      const text = renderM3u8([track({ absPath: '/srv/music/Rock/a.flac' })], {
        ...options,
        destination: '/srv/music/mix.m3u8'
      })
      expect(text).toContain('\nRock/a.flac\n')
    })

    it('climbs out of the destination folder when the track is above it', () => {
      const text = renderM3u8([track({ absPath: '/srv/music/Rock/a.flac' })], {
        ...options,
        destination: '/home/mike/playlists/mix.m3u8'
      })
      expect(text).toContain('\n../../../srv/music/Rock/a.flac\n')
    })

    it('emits the rejoined absolute path verbatim in the absolute style', () => {
      const text = renderM3u8([track({ absPath: '/srv/music/Rock/a.flac' })], {
        destination: '/home/mike/playlists/mix.m3u8',
        pathStyle: 'absolute',
        path: posix
      })
      expect(text).toContain('\n/srv/music/Rock/a.flac\n')
    })
  })

  describe('locations under win32', () => {
    it('separates a relative path with backslashes, never the stored slash', () => {
      const text = renderM3u8([track({ absPath: 'C:\\Music\\Rock\\a.flac' })], {
        destination: 'C:\\Music\\mix.m3u8',
        pathStyle: 'relative',
        path: win32
      })

      expect(text).toContain('\nRock\\a.flac\n')
      expect(text).not.toContain('Rock/a.flac')
    })

    it('separates an absolute path with backslashes too', () => {
      const text = renderM3u8([track({ absPath: 'C:\\Music\\Rock\\a.flac' })], {
        destination: 'D:\\Playlists\\mix.m3u8',
        pathStyle: 'absolute',
        path: win32
      })

      expect(text).toContain('\nC:\\Music\\Rock\\a.flac\n')
    })

    /**
     * There is no relative form across volumes, and `path.relative` says so by
     * handing back the absolute path. Emitting a climbing path here would name
     * a file on the wrong drive.
     */
    it('falls back to the absolute path when the track is on another volume', () => {
      const text = renderM3u8([track({ absPath: 'E:\\Archive\\a.flac' })], {
        destination: 'C:\\Users\\mike\\mix.m3u8',
        pathStyle: 'relative',
        path: win32
      })

      expect(text).toContain('\nE:\\Archive\\a.flac\n')
    })

    it('climbs with backslashes when the track is above the destination', () => {
      const text = renderM3u8([track({ absPath: 'C:\\Music\\Rock\\a.flac' })], {
        destination: 'C:\\Users\\mike\\Playlists\\mix.m3u8',
        pathStyle: 'relative',
        path: win32
      })

      expect(text).toContain('\n..\\..\\..\\Music\\Rock\\a.flac\n')
    })
  })
})

describe('suggestedFileName', () => {
  it('keeps a plain name and adds the extension', () => {
    expect(suggestedFileName('Road trip')).toBe(`Road trip${M3U8_EXTENSION}`)
  })

  it('keeps non-ASCII names intact', () => {
    expect(suggestedFileName('Björk — 日本語 ♥')).toBe(`Björk — 日本語 ♥${M3U8_EXTENSION}`)
  })

  it('replaces characters neither platform will accept in a filename', () => {
    expect(suggestedFileName('AC/DC B-sides')).toBe(`AC_DC B-sides${M3U8_EXTENSION}`)
    expect(suggestedFileName('a\\b:c*d?e"f<g>h|i')).toBe(`a_b_c_d_e_f_g_h_i${M3U8_EXTENSION}`)
  })

  it('strips the trailing dots and spaces Windows refuses', () => {
    expect(suggestedFileName('Mix... ')).toBe(`Mix${M3U8_EXTENSION}`)
  })

  it('escapes a reserved Windows device name', () => {
    expect(suggestedFileName('CON')).toBe(`_CON${M3U8_EXTENSION}`)
    expect(suggestedFileName('com1')).toBe(`_com1${M3U8_EXTENSION}`)
  })

  it('falls back rather than suggesting a bare extension', () => {
    expect(suggestedFileName('///')).toBe(`___${M3U8_EXTENSION}`)
    expect(suggestedFileName('. .')).toBe(`playlist${M3U8_EXTENSION}`)
  })

  it('clips a long name by code point, leaving no half surrogate behind', () => {
    const suggested = suggestedFileName('🎵'.repeat(200))
    expect([...suggested].length).toBe(100 + M3U8_EXTENSION.length)
    expect(suggested.includes('\uFFFD')).toBe(false)
  })
})

describe('withM3u8Extension', () => {
  it('appends the extension a GTK dialog does not', () => {
    expect(withM3u8Extension('/home/mike/Road trip')).toBe(`/home/mike/Road trip${M3U8_EXTENSION}`)
  })

  it('leaves an extension the operator typed alone', () => {
    expect(withM3u8Extension('/home/mike/mix.m3u')).toBe('/home/mike/mix.m3u')
    expect(withM3u8Extension('/home/mike/mix.m3u8')).toBe('/home/mike/mix.m3u8')
  })
})

describe('exporting a playlist', () => {
  let dir: string
  let db: Database.Database
  let store: PlaylistStore
  let musicRootId: number
  let now = 1_700_000_000_000

  function tick(): number {
    now += 1000
    return now
  }

  function addRoot(path: string, label: string): number {
    return Number(
      db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)').run(label, path, now)
        .lastInsertRowid
    )
  }

  function addArtist(name: string): number {
    return Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
  }

  function addTrack(options: {
    rootId?: number
    relPath: string
    title?: string | null
    artistId?: number | null
    durationMs?: number | null
  }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, duration_ms)
           VALUES (?, ?, 1, 100, ?, ?, ?)`
        )
        .run(
          options.rootId ?? musicRootId,
          options.relPath,
          options.title ?? null,
          options.artistId ?? null,
          options.durationMs ?? null
        ).lastInsertRowid
    )
  }

  /** The service, with the save dialog answered by a fixed path. */
  function serviceSaving(destination: string | null): {
    service: SqlitePlaylistService
    pickExportFile: ReturnType<typeof vi.fn>
  } {
    const pickExportFile = vi.fn(async () => destination)
    return {
      service: new SqlitePlaylistService({ db, now: tick, pickExportFile }),
      pickExportFile
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fermata-m3u8-'))
    db = openDatabase(join(dir, 'library.db')).db
    store = new PlaylistStore(db)
    // A real directory, so the export writes beside files that could exist.
    musicRootId = addRoot(join(dir, 'music'), 'Music')
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejoins every entry against its own root and reports what it wrote', async () => {
    const otherRootId = addRoot(join(dir, 'archive'), 'Archive')
    const bjork = addArtist('Björk')
    const playlistId = store.create('Mix', tick()).id
    const first = addTrack({
      relPath: 'Homogenic/01 Hunter.flac',
      title: 'Hunter',
      artistId: bjork,
      durationMs: 254_000
    })
    const second = addTrack({
      rootId: otherRootId,
      relPath: '日本語/02 曲.flac',
      title: '曲',
      artistId: addArtist('アーティスト'),
      durationMs: 61_400
    })
    // The same track twice: D12 makes that legal, so it has to survive export.
    store.addTracks(playlistId, [first, second, first], { at: 'end' }, tick())

    const destination = join(dir, 'Mix.m3u8')
    const { service, pickExportFile } = serviceSaving(destination)
    const result = await service.exportM3u8({ playlistId, pathStyle: 'absolute' })

    expect(pickExportFile).toHaveBeenCalledWith('Mix.m3u8')
    expect(result).toEqual({ fileName: 'Mix.m3u8', entryCount: 3, skippedCount: 0 })

    // Read as UTF-8 with no BOM, which is what `.m3u8` means.
    const text = readFileSync(destination, 'utf8')
    expect(text.startsWith('#EXTM3U\n')).toBe(true)
    expect(readFileSync(destination)[0]).not.toBe(0xef)
    expect(text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXTINF:254,Björk - Hunter',
      join(dir, 'music', 'Homogenic', '01 Hunter.flac'),
      '#EXTINF:61,アーティスト - 曲',
      join(dir, 'archive', '日本語', '02 曲.flac'),
      '#EXTINF:254,Björk - Hunter',
      join(dir, 'music', 'Homogenic', '01 Hunter.flac'),
      ''
    ])
  })

  it('addresses tracks relative to the destination file, not to their root', async () => {
    const playlistId = store.create('Mix', tick()).id
    const trackId = addTrack({ relPath: 'Rock/a.flac', title: 'A', durationMs: 1000 })
    store.addTracks(playlistId, [trackId], { at: 'end' }, tick())

    const destination = join(dir, 'music', 'Rock', 'Mix.m3u8')
    mkdirSync(join(dir, 'music', 'Rock'), { recursive: true })
    const { service } = serviceSaving(destination)
    await service.exportM3u8({ playlistId, pathStyle: 'relative' })

    expect(readFileSync(destination, 'utf8').split('\n')[2]).toBe('a.flac')
  })

  /**
   * A stored path is POSIX, and on Windows it must not stay that way. The host
   * separator is whatever this machine uses; the point is that the emitted path
   * is `join`'s and never the raw `rel_path`.
   */
  it('never emits the stored POSIX separator on a platform that does not use it', async () => {
    const playlistId = store.create('Mix', tick()).id
    const trackId = addTrack({ relPath: 'Rock/Live/a.flac', title: 'A' })
    store.addTracks(playlistId, [trackId], { at: 'end' }, tick())

    const destination = join(dir, 'Mix.m3u8')
    const { service } = serviceSaving(destination)
    await service.exportM3u8({ playlistId, pathStyle: 'absolute' })

    const location = readFileSync(destination, 'utf8').split('\n')[2]
    expect(location).toBe(join(dir, 'music', 'Rock', 'Live', 'a.flac'))
    expect(location.includes('Rock/Live')).toBe(process.platform !== 'win32')
  })

  it('leaves out an entry whose file no longer resolves, and counts it', async () => {
    const playlistId = store.create('Mix', tick()).id
    const good = addTrack({ relPath: 'Rock/a.flac', title: 'A' })
    // `..` in a stored path is the shape a corrupted row takes; `toAbsPath`
    // refuses it, and the export must not guess at what was meant.
    const escaping = addTrack({ relPath: '../outside.flac', title: 'Outside' })
    store.addTracks(playlistId, [good, escaping], { at: 'end' }, tick())

    const destination = join(dir, 'Mix.m3u8')
    const { service } = serviceSaving(destination)
    const result = await service.exportM3u8({ playlistId, pathStyle: 'absolute' })

    expect(result).toEqual({ fileName: 'Mix.m3u8', entryCount: 1, skippedCount: 1 })
    expect(readFileSync(destination, 'utf8')).not.toContain('outside.flac')
  })

  it('writes nothing and resolves null when the operator cancels', async () => {
    const playlistId = store.create('Mix', tick()).id
    const { service } = serviceSaving(null)

    await expect(service.exportM3u8({ playlistId, pathStyle: 'relative' })).resolves.toBeNull()
    expect(() => readFileSync(join(dir, 'Mix.m3u8'))).toThrow()
  })

  it('appends the extension to a name the dialog handed back bare', async () => {
    const playlistId = store.create('Mix', tick()).id
    const { service } = serviceSaving(join(dir, 'Road trip'))

    const result = await service.exportM3u8({ playlistId, pathStyle: 'relative' })

    expect(result?.fileName).toBe('Road trip.m3u8')
    expect(readFileSync(join(dir, 'Road trip.m3u8'), 'utf8')).toBe('#EXTM3U\n')
  })

  it('suggests a filename the platform will accept, from the playlist name', async () => {
    const playlistId = store.create('AC/DC B-sides', tick()).id
    const { service, pickExportFile } = serviceSaving(join(dir, 'out.m3u8'))

    await service.exportM3u8({ playlistId, pathStyle: 'relative' })

    expect(pickExportFile).toHaveBeenCalledWith('AC_DC B-sides.m3u8')
  })

  it('fails before the dialog opens when the playlist is gone', async () => {
    const { service, pickExportFile } = serviceSaving(join(dir, 'out.m3u8'))

    const failure = await service
      .exportM3u8({ playlistId: 9999, pathStyle: 'relative' })
      .catch((error: unknown) => error)

    expect(isOscineError(failure) && failure.code).toBe('not-found')
    expect(pickExportFile).not.toHaveBeenCalled()
  })

  it('reports an unwritable destination as an io error carrying no path', async () => {
    const playlistId = store.create('Mix', tick()).id
    // A directory that does not exist: the write fails, the message must not
    // say where.
    const { service } = serviceSaving(join(dir, 'nope', 'Mix.m3u8'))

    const failure = await service
      .exportM3u8({ playlistId, pathStyle: 'relative' })
      .catch((error: unknown) => error)

    expect(isOscineError(failure) && failure.code).toBe('io-error')
    expect(isOscineError(failure) && failure.message.includes(dir)).toBe(false)
  })
})
