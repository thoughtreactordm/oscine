import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { SqlitePlayHistoryService } from '../../../src/main/history/service'
import { AgentReadStore } from '../../../src/main/library/agentReads'
import { SqlitePlaylistService } from '../../../src/main/library/playlists/service'
import { LibraryStore } from '../../../src/main/library/store'
import { createAgentMcpServer, type AgentToolDeps } from '../../../src/main/mcp'
import { createJournalEntities } from '../../../src/main/mcp/journal/entities'
import { createAgentJournal, type AgentJournal } from '../../../src/main/mcp/journal/journal'
import { createQueryHost, type QueryHost } from '../../../src/main/mcp/query/host'
import { TagStore } from '../../../src/main/tags/store'
import { NO_LIBRARY_CHANGES } from '../../../src/main/library/changes'
import { SqliteStatsService } from '../../../src/main/stats/service'
import { bundleQueryWorker, type QueryProcessHarness } from './queryProcess'

/**
 * The W24-4 read tools end to end — an SDK client over an in-memory transport,
 * against a fixture library on the real schema and the real services.
 *
 * The fixture plants one case per `find_issues` check next to a near miss, so a
 * check that over-matches fails as surely as one that misses.
 */

const MUSIC_PATH = '/home/someone/secret-music-root'
const ARCHIVE_PATH = 'C:/Users/someone/secret-archive'
const FILLERS = 120
const SEPT = Date.UTC(2026, 8, 10, 12)
const AUG = Date.UTC(2026, 7, 10, 12)

interface Fixture {
  ids: Record<string, number>
  albums: Record<string, number>
  playlistId: number
}

function seed(opened: OpenDatabaseResult, playlists: SqlitePlaylistService): Promise<Fixture> {
  const { db } = opened
  const root = (label: string, path: string): number =>
    Number(
      db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, 1)').run(label, path)
        .lastInsertRowid
    )
  const music = root('Music', MUSIC_PATH)
  const archive = root('Archive', ARCHIVE_PATH)

  const artistIds = new Map<string, number>()
  const artist = (name: string): number => {
    let id = artistIds.get(name)
    if (id === undefined) {
      id = Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
      artistIds.set(name, id)
    }
    return id
  }
  const albums: Record<string, number> = {}
  const album = (title: string, albumArtist: string, year: number | null): number => {
    albums[title] = Number(
      db
        .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)')
        .run(title, artist(albumArtist), year).lastInsertRowid
    )
    return albums[title]!
  }
  const insert = db.prepare(
    `INSERT INTO tracks (root_id, rel_path, mtime, size, duration_ms, codec, title, artist_id,
                         album_id, track_no, genre, tag_album_artist, tag_year, play_count)
     VALUES (@root, @path, 1, 1000, @durationMs, @codec, @title, @artistId, @albumId, @trackNo,
             @genre, @tagAlbumArtist, @tagYear, @playCount)`
  )
  const ids: Record<string, number> = {}
  const track = (
    key: string,
    fields: {
      title: string
      artist: string
      album?: number
      tagAlbumArtist?: 0 | 1 | null
      tagYear?: number | null
      durationMs?: number
      genre?: string | null
      root?: number
      codec?: string
      playCount?: number
    }
  ): void => {
    ids[key] = Number(
      insert.run({
        root: fields.root ?? music,
        path: `${fields.artist}/${key}.flac`,
        durationMs: fields.durationMs ?? 180_000,
        codec: fields.codec ?? 'flac',
        title: fields.title,
        artistId: artist(fields.artist),
        albumId: fields.album ?? null,
        trackNo: 1,
        genre: fields.genre ?? null,
        tagAlbumArtist: fields.tagAlbumArtist === undefined ? 1 : fields.tagAlbumArtist,
        tagYear: fields.tagYear ?? null,
        playCount: fields.playCount ?? 0
      }).lastInsertRowid
    )
  }

  // Clean: nothing to report.
  const clean = album('Clean Record', 'Solo', 2001)
  track('clean1', { title: 'One', artist: 'Solo', album: clean, tagYear: 2001, genre: 'Rock' })
  track('clean2', { title: 'Two', artist: 'Solo', album: clean, tagYear: 2001, playCount: 7 })
  // Planted year mismatch, and its near miss: an untagged year is not a disagreement.
  const split = album('Split Years', 'Solo', 1999)
  track('split1', { title: 'Three', artist: 'Solo', album: split, tagYear: 1999 })
  track('split2', { title: 'Four', artist: 'Solo', album: split, tagYear: 2003 })
  const near = album('Near Years', 'Solo', 2005)
  track('near1', { title: 'Five', artist: 'Solo', album: near, tagYear: 2005 })
  track('near2', { title: 'Six', artist: 'Solo', album: near, tagYear: null })
  // Planted missing album artist (grouped under the performer), and two near
  // misses: a file not re-read since 028, and one a correction has fixed.
  const comp = album('Compilation', 'Guest', null)
  track('comp1', { title: 'Seven', artist: 'Guest', album: comp, tagAlbumArtist: 0 })
  const unknown = album('Unknown Scan', 'Solo', null)
  track('unknown1', { title: 'Eight', artist: 'Solo', album: unknown, tagAlbumArtist: null })
  const fixed = album('Fixed By Correction', 'Guest', null)
  track('fixed1', { title: 'Nine', artist: 'Guest', album: fixed, tagAlbumArtist: 0 })
  db.prepare(
    "INSERT INTO track_overrides (track_id, album_artist_name, updated_at) VALUES (?, 'Someone', 1)"
  ).run(ids.fixed1)
  // Genre corrected: the effective value is the correction's.
  db.prepare("INSERT INTO track_overrides (track_id, genre, updated_at) VALUES (?, 'Jazz', 1)").run(
    ids.clean1
  )
  // Planted duplicate (case and punctuation differ, 1.5 s apart), and its near
  // miss: the same song a minute longer is a different recording.
  track('dup1', { title: 'Hello, World!', artist: 'Solo', durationMs: 200_000 })
  track('dup2', { title: 'hello world', artist: 'Solo', durationMs: 201_500 })
  track('dup3', { title: 'Hello World', artist: 'Solo', durationMs: 260_000 })
  // Planted artist variants, and the near miss: a missing word is a different name.
  track('v1', { title: 'Halo', artist: 'Beyoncé' })
  track('v2', { title: 'Single Ladies', artist: 'Beyonce' })
  track('v3', { title: 'Thunderstruck', artist: 'AC/DC' })
  track('v4', { title: 'Back in Black', artist: 'ac-dc' })
  track('v5', { title: 'Help', artist: 'The Beatles' })
  track('v6', { title: 'Yesterday', artist: 'Beatles' })
  // Enough rows in one root to page.
  for (let n = 1; n <= FILLERS; n++) {
    track(`filler${n}`, {
      title: `Filler ${String(n).padStart(3, '0')}`,
      artist: 'Filler',
      root: archive,
      codec: 'mp3',
      durationMs: 60_000 + n * 10_000
    })
  }

  // Listening: three in September for clean1, one for split1, five in August.
  const listen = db.prepare(
    `INSERT INTO listens (track_id, started_at, ms_listened, duration_ms, title, artist_name,
                          album_title, album_artist_name)
     VALUES (?, ?, 180000, 180000, ?, 'Solo', ?, 'Solo')`
  )
  for (let n = 0; n < 3; n++) listen.run(ids.clean1, SEPT + n * 60_000, 'One', 'Clean Record')
  listen.run(ids.split1, SEPT + 10 * 60_000, 'Three', 'Split Years')
  for (let n = 0; n < 5; n++) listen.run(ids.split1, AUG + n * 60_000, 'Three', 'Split Years')
  const history = db.prepare('INSERT INTO play_history (track_id, played_at) VALUES (?, ?)')
  history.run(ids.split1, SEPT)
  history.run(ids.clean1, SEPT + 1000)

  const tag = Number(
    db.prepare("INSERT INTO tags (key, label, created_at) VALUES ('live', 'Live', 1)").run()
      .lastInsertRowid
  )
  db.prepare(
    "INSERT INTO track_tags (track_id, tag_id, source, created_at) VALUES (?, ?, 'user', 1)"
  ).run(ids.clean2, tag)

  return (async () => {
    const playlist = await playlists.create('Road')
    await playlists.addTracks({
      playlistId: playlist.id,
      trackIds: [ids.clean1!, ids.split1!, ids.clean1!],
      insertion: { at: 'end' }
    })
    return { ids, albums, playlistId: playlist.id }
  })()
}

describe('W24-4 structured read tools', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let fixture: Fixture
  let server: McpServer
  let client: Client
  let harness: QueryProcessHarness
  let queryHost: QueryHost
  let journal: AgentJournal

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-read-tools-'))
    opened = openDatabase(join(dir, 'library.db'))
    // W24-5: query_library runs in the real query process, on this fixture.
    harness = await bundleQueryWorker()
    queryHost = createQueryHost({ spawn: harness.spawn(join(dir, 'library.db')) })
    const { db } = opened
    const playlists = new SqlitePlaylistService({ db, pickExportFile: async () => null })
    fixture = await seed(opened, playlists)

    const store = new LibraryStore(db)
    const reads = new AgentReadStore(db)
    const noWrites = async (): Promise<never> => {
      throw new Error('no correction writes in the read-tool suite')
    }
    journal = createAgentJournal({
      db,
      changes: NO_LIBRARY_CHANGES,
      entities: createJournalEntities({
        db,
        playlists,
        tags: new TagStore(db),
        library: {
          setOverrides: noWrites,
          clearOverrides: noWrites,
          setTagOverrides: noWrites,
          revertTagOverrides: noWrites
        }
      })
    })
    const deps: AgentToolDeps = {
      library: {
        overview: async () => store.libraryOverview(),
        findTracks: async (query) => reads.findTracks(query),
        getAgentTracks: async (ids, fields) => reads.getTracks(ids, fields),
        findAlbums: async (query) => reads.findAlbums(query),
        findArtists: async (query) => reads.findArtists(query),
        issueSummary: async () => reads.issueSummary(),
        findIssues: async (check) => reads.issues(check)
      },
      playlists,
      stats: new SqliteStatsService({ db }),
      history: new SqlitePlayHistoryService({ db }),
      query: queryHost,
      journal
    }
    server = createAgentMcpServer(deps, '0.0.0-test')
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    client = new Client({ name: 'vitest', version: '0' })
    await client.connect(clientSide)
  })

  afterAll(async () => {
    await client.close()
    await server.close()
    queryHost.close()
    harness.dispose()
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function call(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
    return result.structuredContent as Record<string, unknown>
  }

  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    return JSON.stringify(result.content)
  }

  const id = (key: string): number => fixture.ids[key]!

  describe('find_tracks', () => {
    it('pages a root to the end with its cursor, and total counts every match', async () => {
      const seen: number[] = []
      let cursor: string | undefined
      const pageSizes: number[] = []
      do {
        const page = await call('find_tracks', {
          root: 'archive',
          limit: 50,
          ...(cursor ? { cursor } : {})
        })
        expect(page.total).toBe(FILLERS)
        const tracks = page.tracks as { id: number }[]
        pageSizes.push(tracks.length)
        seen.push(...tracks.map((track) => track.id))
        cursor = (page.nextCursor as string | null) ?? undefined
      } while (cursor)
      expect(pageSizes).toEqual([50, 50, 20])
      expect(new Set(seen).size).toBe(FILLERS)
    })

    it('refuses a page over the cap and a cursor it did not issue', async () => {
      expect(await callError('find_tracks', { limit: 501 })).toMatch(/limit|500/i)
      expect(await callError('find_tracks', { cursor: 'bm90LWEtY3Vyc29y' })).toMatch(/cursor/)
      expect(await callError('find_tracks', { notAFilter: true })).toBeTruthy()
    })

    it('defaults to 50 rows and returns only the fields asked for', async () => {
      const page = await call('find_tracks', {})
      expect((page.tracks as unknown[]).length).toBe(50)
      const one = await call('find_tracks', {
        title: { equals: 'two' },
        fields: ['root', 'path', 'playCount', 'userTags', 'lastPlayedAt']
      })
      expect(one.tracks).toEqual([
        {
          id: id('clean2'),
          root: 'Music',
          path: 'Solo/clean2.flac',
          playCount: 7,
          userTags: ['Live'],
          lastPlayedAt: null
        }
      ])
    })

    it('filters on effective values, ranges and presence', async () => {
      const ids = async (args: Record<string, unknown>): Promise<number[]> =>
        ((await call('find_tracks', { ...args, limit: 500 })).tracks as { id: number }[]).map(
          (track) => track.id
        )
      // The correction wins over the file's genre.
      expect(await ids({ genre: { equals: 'jazz' } })).toEqual([id('clean1')])
      expect(await ids({ genre: { equals: 'rock' } })).toEqual([])
      expect(await ids({ root: 'Music', missing: ['albumArtist'] })).toEqual([id('comp1')])
      expect(await ids({ albumId: fixture.albums['Clean Record'], present: ['genre'] })).toEqual([
        id('clean1')
      ])
      expect(await ids({ playCountMin: 5 })).toEqual([id('clean2')])
      expect(await ids({ codecs: ['mp3'], durationSecMax: 80 })).toEqual([
        id('filler1'),
        id('filler2')
      ])
      expect(await ids({ yearMin: 2000, yearMax: 2002 })).toEqual([id('clean1'), id('clean2')])
      expect(await ids({ artist: { contains: 'beyonc' } })).toEqual([id('v1'), id('v2')])
      expect(await ids({ title: { contains: '%' } })).toEqual([])
      expect(await ids({ userTag: 'live' })).toEqual([id('clean2')])
      expect(await ids({ hasCorrections: true })).toEqual([id('clean1'), id('fixed1')])
    })

    it('sorts by play count when asked', async () => {
      const page = await call('find_tracks', { sort: 'mostPlayed', limit: 1 })
      expect((page.tracks as { id: number }[])[0]!.id).toBe(id('clean2'))
    })
  })

  it('get_tracks returns tracks in the order asked and names the missing ids', async () => {
    const result = await call('get_tracks', {
      ids: [id('split1'), 999_999, id('clean1')],
      fields: ['title', 'genre']
    })
    expect(result).toEqual({
      tracks: [
        { id: id('split1'), title: 'Three', genre: null },
        { id: id('clean1'), title: 'One', genre: 'Jazz' }
      ],
      missing: [999_999]
    })
    expect(
      await callError('get_tracks', { ids: Array.from({ length: 501 }, (_, n) => n + 1) })
    ).toBeTruthy()
  })

  it('list_albums and list_artists filter and page', async () => {
    const solo = await call('list_albums', { albumArtist: { equals: 'solo' }, limit: 2 })
    expect(solo.total).toBe(4)
    expect((solo.albums as { title: string }[]).map((album) => album.title)).toEqual([
      'Clean Record',
      'Near Years'
    ])
    const rest = await call('list_albums', {
      albumArtist: { equals: 'solo' },
      limit: 2,
      cursor: solo.nextCursor
    })
    expect((rest.albums as { title: string }[]).map((album) => album.title)).toEqual([
      'Split Years',
      'Unknown Scan'
    ])
    expect(rest.nextCursor).toBeNull()
    expect((solo.albums as { tracks: number; year: number }[])[0]).toMatchObject({
      tracks: 2,
      year: 2001
    })

    const artists = await call('list_artists', { name: { contains: 'beatles' } })
    expect(artists.artists).toEqual([
      expect.objectContaining({ name: 'Beatles', tracks: 1 }),
      expect.objectContaining({ name: 'The Beatles', tracks: 1 })
    ])
  })

  it('list_playlists and get_playlist carry entry ids, a repeated track twice', async () => {
    const lists = await call('list_playlists')
    expect(lists.playlists).toEqual([
      expect.objectContaining({ id: fixture.playlistId, name: 'Road', entries: 3 })
    ])
    const first = await call('get_playlist', {
      playlistId: fixture.playlistId,
      fields: ['title'],
      limit: 2
    })
    const entries = first.entries as { entryId: number; track: { id: number; title: string } }[]
    expect(entries.map((entry) => entry.track.title)).toEqual(['One', 'Three'])
    const second = await call('get_playlist', {
      playlistId: fixture.playlistId,
      fields: ['title'],
      cursor: first.nextCursor
    })
    const last = second.entries as typeof entries
    expect(last.map((entry) => entry.track.id)).toEqual([id('clean1')])
    expect(new Set([...entries, ...last].map((entry) => entry.entryId)).size).toBe(3)
    expect(second.nextCursor).toBeNull()
    expect(await callError('get_playlist', { playlistId: 424242 })).toMatch(/list_playlists/)
  })

  it('answers "what did I play most last month" from top_listened', async () => {
    const top = await call('top_listened', {
      dimension: 'track',
      from: '2026-09-01',
      to: '2026-09-30'
    })
    expect(top.rows).toEqual([
      expect.objectContaining({ rank: 1, label: 'One', listens: 3, trackId: id('clean1') }),
      expect.objectContaining({ rank: 2, label: 'Three', listens: 1, trackId: id('split1') })
    ])
    const allTime = await call('top_listened', { dimension: 'track', limit: 1 })
    expect(allTime.rows).toEqual([expect.objectContaining({ label: 'Three', listens: 6 })])
    expect(allTime.nextCursor).not.toBeNull()
    expect(
      await callError('top_listened', { dimension: 'track', from: '2026-09-30', to: '2026-09-01' })
    ).toMatch(/before/)
    expect(await callError('top_listened', { dimension: 'track', from: 'last month' })).toMatch(
      /ISO/
    )

    const summary = await call('listening_summary', { from: '2026-09-01', to: '2026-09-30' })
    expect(summary).toMatchObject({ listens: 4, minutesListened: 12, tracks: 2 })
    const recent = await call('recent_plays', { limit: 5 })
    expect((recent.plays as { track: { id: number } }[]).map((play) => play.track.id)).toEqual([
      id('clean1'),
      id('split1')
    ])
  })

  it('list_tag_fields lists the registry with kinds and formats', async () => {
    const result = await call('list_tag_fields')
    const fields = result.fields as { key: string; kind: string; editable: boolean }[]
    expect(fields.find((field) => field.key === 'albumArtist')).toMatchObject({
      kind: 'text',
      editable: true
    })
    expect(fields.find((field) => field.key === 'bpm')).toMatchObject({ kind: 'int' })
    expect(fields.find((field) => field.key === 'replayGainTrackGain')).toMatchObject({
      editable: false,
      formats: []
    })
    expect(result.writableFormats).toEqual(['flac', 'mp3', 'vorbis', 'opus', 'aac'])
  })

  describe('find_issues', () => {
    it('summarises every check and counts the tracks it cannot judge', async () => {
      expect(await call('find_issues')).toEqual({
        groups: { missingAlbumArtist: 1, yearMismatch: 1, duplicates: 1, artistVariants: 2 },
        tracksNotRescanned: 1
      })
    })

    it('answers "which albums are missing album artist", not the near misses', async () => {
      const result = await call('find_issues', { check: 'missingAlbumArtist' })
      expect(result.groups).toEqual([
        {
          albumId: fixture.albums.Compilation,
          album: 'Compilation',
          shownUnder: 'Guest',
          tracksMissing: 1,
          trackIds: [id('comp1')]
        }
      ])
    })

    it('finds the album whose years disagree, not the one with an untagged year', async () => {
      const result = await call('find_issues', { check: 'yearMismatch' })
      expect(result.groups).toEqual([
        {
          albumId: fixture.albums['Split Years'],
          album: 'Split Years',
          albumArtist: 'Solo',
          shownYear: 1999,
          years: [
            { year: 1999, tracks: 1 },
            { year: 2003, tracks: 1 }
          ]
        }
      ])
    })

    it('groups the duplicate pair and leaves the longer recording out', async () => {
      const result = await call('find_issues', { check: 'duplicates' })
      const groups = result.groups as { tracks: { id: number; root: string }[] }[]
      expect(groups).toHaveLength(1)
      expect(groups[0]!.tracks.map((track) => track.id)).toEqual([id('dup1'), id('dup2')])
      expect(groups[0]!.tracks[0]!.root).toBe('Music')
    })

    it('groups spellings of one artist, not a name missing a word', async () => {
      const result = await call('find_issues', { check: 'artistVariants', limit: 1 })
      expect(result.total).toBe(2)
      const first = result.groups as { variants: { name: string }[] }[]
      const next = await call('find_issues', {
        check: 'artistVariants',
        cursor: result.nextCursor
      })
      expect(next.nextCursor).toBeNull()
      const names = [...first, ...(next.groups as typeof first)].map((group) =>
        group.variants.map((variant) => variant.name)
      )
      expect(names).toEqual([
        ['AC/DC', 'ac-dc'],
        ['Beyoncé', 'Beyonce']
      ])
    })
  })

  it('query_library returns capped rows and refuses what it must, as tool errors', async () => {
    const page = await call('query_library', { sql: 'SELECT id, title FROM mcp_tracks', limit: 5 })
    expect(page).toMatchObject({ columns: ['id', 'title'], rowCount: 5, truncated: true })
    const refused = await client.callTool({
      name: 'query_library',
      arguments: { sql: 'SELECT * FROM settings' }
    })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('not-authorized')
    const views = await call('describe_views', { view: 'mcp_tracks' })
    expect((views.views as { name: string }[]).map((view) => view.name)).toEqual(['mcp_tracks'])
  })

  /**
   * D36.3: no absolute path crosses the boundary. Every listed tool must have an
   * entry here, so a new tool cannot skip the check by being forgotten.
   */
  it('never returns an absolute path from any tool', async () => {
    const calls: Record<string, Record<string, unknown>[]> = {
      library_overview: [{}],
      find_tracks: [{ fields: [...ALL_FIELDS], limit: 500 }],
      get_tracks: [{ ids: Object.values(fixture.ids).slice(0, 500), fields: [...ALL_FIELDS] }],
      list_albums: [{ limit: 500 }],
      list_artists: [{ limit: 500 }],
      list_playlists: [{}],
      get_playlist: [{ playlistId: fixture.playlistId, fields: [...ALL_FIELDS] }],
      top_listened: [{ dimension: 'track' }, { dimension: 'album' }, { dimension: 'artist' }],
      listening_summary: [{}],
      recent_plays: [{}],
      list_tag_fields: [{}],
      find_issues: [
        {},
        { check: 'missingAlbumArtist' },
        { check: 'yearMismatch' },
        { check: 'duplicates' },
        { check: 'artistVariants' }
      ],
      describe_views: [{}],
      begin_changeset: [{ description: 'Path check' }],
      list_changesets: [{}],
      revert_changeset: [
        {
          changesetId: journal.openChangeset({
            clientName: null,
            description: null,
            origin: 'explicit'
          })
        }
      ],
      query_library: [
        { sql: 'SELECT * FROM mcp_tracks', limit: 1000 },
        { sql: 'SELECT * FROM mcp_albums', limit: 1000 },
        { sql: 'SELECT * FROM mcp_artists', limit: 1000 },
        { sql: 'SELECT * FROM mcp_playlists', limit: 1000 },
        { sql: 'SELECT * FROM mcp_playlist_entries', limit: 1000 },
        { sql: 'SELECT * FROM mcp_listens', limit: 1000 },
        { sql: 'SELECT * FROM mcp_track_tags', limit: 1000 }
      ]
    }
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(calls).sort())
    for (const [name, argsList] of Object.entries(calls)) {
      for (const args of argsList) {
        const result = await client.callTool({ name, arguments: args })
        expect(result.isError, name).toBeFalsy()
        const text = JSON.stringify(result)
        expect(text, name).not.toContain('secret-music-root')
        expect(text, name).not.toContain('secret-archive')
        expect(text, name).not.toContain('/home/')
        expect(text, name).not.toMatch(/[A-Za-z]:[\\/]/)
      }
    }
  })
})

const ALL_FIELDS = [
  'title',
  'artist',
  'album',
  'albumArtist',
  'albumId',
  'artistId',
  'trackNo',
  'discNo',
  'year',
  'genre',
  'durationSec',
  'codec',
  'sampleRateHz',
  'bitDepth',
  'channels',
  'bytes',
  'playCount',
  'lastPlayedAt',
  'favorite',
  'hasCorrections',
  'root',
  'path',
  'userTags'
] as const
