import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { LibraryChanged } from '@shared/libraryChanges'
import type { TagFieldKey, TagFieldValue } from '@shared/tagFields'
import { openDatabase } from '../../../src/main/db'
import { createLibraryChangeNotifier } from '../../../src/main/library/changes'
import type { TrackTags } from '../../../src/main/library/metadata'
import { SqlitePlaylistService } from '../../../src/main/library/playlists/service'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'
import { LibraryStore } from '../../../src/main/library/store'
import { TagWritebackDiffer } from '../../../src/main/library/writeback/differ'
import { TagWritebackService, trackPathResolver } from '../../../src/main/library/writeback/service'
import { createAgentMcpServer } from '../../../src/main/mcp'
import { createJournalEntities } from '../../../src/main/mcp/journal/entities'
import { createAgentJournal, type AgentJournal } from '../../../src/main/mcp/journal/journal'
import { createAgentProvenance } from '../../../src/main/mcp/journal/provenance'
import { createOrganizeReads } from '../../../src/main/mcp/organize/reads'
import { createStageReads } from '../../../src/main/mcp/stage/reads'
import { TagStore } from '../../../src/main/tags/store'
import { overviewOnlyTools } from './fakeTools'

/**
 * The Stage corrections tools over a real client, the real schema and the real
 * override services — **W24-8**, `oscine-mcp` → D36.5/D36.6: grouped and
 * registry fields stage into the layers a manual edit uses and show in the
 * write-back preview, the registry is enforced, no tool reaches the flush, and
 * the review badges exactly the rows whose correction an agent left.
 */

const OVERVIEW = {
  trackCount: 0,
  albumCount: 0,
  artistCount: 0,
  totalDurationMs: 0,
  roots: []
} as never

function fileTags(over: Partial<TrackTags> = {}): TrackTags {
  return {
    title: 'File Title',
    artist: 'File Artist',
    album: 'File Album',
    albumArtist: 'Various',
    trackNo: 1,
    discNo: 1,
    year: 2001,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre: 'Rock',
    replayGain: null,
    lyrics: null,
    ...over
  }
}

describe('stage tools', () => {
  let dir: string
  let db: Database.Database
  let events: LibraryChanged[]
  let library: SqliteLibraryService
  let writeback: TagWritebackService
  let journal: AgentJournal
  let tracks: number[]
  let wav: number
  let server: McpServer
  let client: Client

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-stage-tools-'))
    db = openDatabase(join(dir, 'library.db')).db
    events = []
    const changes = createLibraryChangeNotifier({ emit: (event) => events.push(event) })
    const musicRoot = join(dir, 'music')
    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', musicRoot, 1).lastInsertRowid
    )
    const files = [...Array.from({ length: 6 }, (_, i) => `album/t${i}.flac`), 'album/t6.wav']
    new LibraryStore(db).writeTracks(
      rootId,
      files.map((relPath, i) => ({
        file: { absPath: join(musicRoot, relPath), relPath, size: 1000, mtime: 1 },
        tags: fileTags({ title: `Track ${i}`, trackNo: i + 1 })
      }))
    )
    const ids = (
      db.prepare('SELECT id, rel_path AS relPath FROM tracks ORDER BY id').all() as Array<{
        id: number
        relPath: string
      }>
    ).map((row) => row.id)
    tracks = ids.slice(0, 6)
    wav = ids[6]!

    // The file never changes in this suite: what the scan saw is what is on disk.
    const readFile = async (): Promise<TrackTags> => fileTags()
    library = new SqliteLibraryService({
      db,
      changes,
      pickFolder: async () => null,
      onProgress: () => {},
      readMetadata: readFile
    })
    const playlists = new SqlitePlaylistService({ db, changes, pickExportFile: async () => null })
    const tags = new TagStore(db, changes)
    const entities = createJournalEntities({ db, playlists, tags, library })
    const provenance = createAgentProvenance({ db, entities })
    writeback = new TagWritebackService({
      differ: new TagWritebackDiffer(db, readFile, async () => new Map()),
      resolvePath: trackPathResolver(db),
      pendingTrackIds: () => library.pendingWritebackTrackIds(),
      provenance: (trackIds) => provenance.forTracks(trackIds)
    })
    journal = createAgentJournal({ db, changes, entities })
    server = createAgentMcpServer(
      {
        ...overviewOnlyTools(OVERVIEW),
        journal,
        organize: { playlists, tags, reads: createOrganizeReads(db) },
        stage: { library, writeback, reads: createStageReads(db) }
      },
      '0.0.0-test'
    )
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    client = new Client({ name: 'vitest-agent', version: '1' })
    await client.connect(clientSide)
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    return result.structuredContent as Record<string, unknown>
  }

  async function fail(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    return JSON.stringify(result.content)
  }

  const albumArtistOverride = (trackId: number): string | null =>
    (
      db
        .prepare('SELECT album_artist_name AS v FROM track_overrides WHERE track_id = ?')
        .get(trackId) as { v: string | null } | undefined
    )?.v ?? null

  const tagOverride = (trackId: number, field: string): TagFieldValue | null => {
    const row = db
      .prepare('SELECT value FROM track_tag_overrides WHERE track_id = ? AND field = ?')
      .get(trackId, field) as { value: string } | undefined
    return row === undefined ? null : (JSON.parse(row.value) as TagFieldValue)
  }

  const overrideState = (): string =>
    JSON.stringify([
      db.prepare('SELECT * FROM track_overrides ORDER BY track_id').all(),
      db.prepare('SELECT * FROM track_tag_overrides ORDER BY track_id, field').all()
    ])

  it('stages grouped and registry fields in one call, and both show in the preview', async () => {
    events.length = 0
    const done = await call('stage_tag_changes', {
      changes: [
        { trackIds: tracks, set: { albumArtist: 'Fixed Artist', conductor: 'Someone' } },
        { trackIds: tracks.slice(0, 2), set: { bpm: 120 } }
      ]
    })
    expect(done).toMatchObject({ dryRun: false, tracks: 6, notWritable: [] })
    expect(done.recorded).toBe(6 * 2 + 2)
    // One call, one event, however many rows moved (D36.9).
    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toBe('agent')

    expect(tracks.map(albumArtistOverride)).toEqual(Array(6).fill('Fixed Artist'))
    expect(tagOverride(tracks[0]!, 'conductor')).toBe('Someone')
    expect(tagOverride(tracks[1]!, 'bpm')).toBe(120)

    const preview = await writeback.preview(tracks)
    expect(preview).toHaveLength(6)
    expect(preview[0]!.albumArtist).toEqual({
      current: 'Various',
      proposed: 'Fixed Artist',
      changed: true
    })
    expect(preview[0]!.fields.conductor).toMatchObject({ proposed: 'Someone', changed: true })
    expect(preview[1]!.fields.bpm).toMatchObject({ proposed: 120, changed: true })
    expect(preview[5]!.fields.bpm).toBeUndefined()

    const listed = await call('list_staged', { changeset: 'current' })
    expect(listed.total).toBe(6)
    const first = (listed.rows as Array<{ trackId: number; fields: unknown[] }>)[0]!
    expect(first.trackId).toBe(tracks[0])
    expect(first.fields).toEqual(
      expect.arrayContaining([
        { field: 'albumArtist', current: 'Various', staged: 'Fixed Artist' },
        { field: 'conductor', current: null, staged: 'Someone' },
        { field: 'bpm', current: null, staged: 120 }
      ])
    )
  })

  it('a dry run writes nothing and says what it would stage', async () => {
    const before = overrideState()
    const plan = await call('stage_tag_changes', {
      changes: [{ trackIds: [...tracks, wav], set: { albumArtist: 'Fixed' } }],
      dryRun: true
    })
    expect(plan).toMatchObject({ dryRun: true, tracks: 7, notWritable: [wav] })
    expect(overrideState()).toBe(before)
    expect(await call('revert_staged', { trackIds: tracks, dryRun: true })).toMatchObject({
      reverting: 0
    })
  })

  it('enforces the registry: key, value type and format support', async () => {
    const before = overrideState()
    expect(
      await fail('stage_tag_changes', { changes: [{ trackIds: tracks, set: { mood: 'x' } }] })
    ).toMatch(/not a tag field/)
    expect(
      await fail('stage_tag_changes', { changes: [{ trackIds: tracks, set: { bpm: 'fast' } }] })
    ).toMatch(/bpm must be an integer/)
    expect(
      await fail('stage_tag_changes', { changes: [{ trackIds: tracks, set: { year: 'later' } }] })
    ).toMatch(/year must be an integer/)
    expect(
      await fail('stage_tag_changes', {
        changes: [{ trackIds: tracks, set: { replayGainTrackGain: -6 } }]
      })
    ).toMatch(/read-only|not a tag field/)
    expect(
      await fail('stage_tag_changes', {
        changes: [{ trackIds: [tracks[0], wav], set: { conductor: 'Someone' } }]
      })
    ).toMatch(new RegExp(`Tracks ${wav} are in a format write-back cannot write`))
    expect(
      await fail('stage_tag_changes', { changes: [{ trackIds: tracks, set: { title: null } }] })
    ).toMatch(/revert_staged/)
    expect(
      await fail('stage_tag_changes', { changes: [{ trackIds: [999_999], set: { title: 'x' } }] })
    ).toMatch(/not in the library/)
    expect(overrideState()).toBe(before)

    // A core field still stages on an unwritable file: it corrects the library.
    const done = await call('stage_tag_changes', {
      changes: [{ trackIds: [wav], set: { albumArtist: 'Fixed' } }]
    })
    expect(done.notWritable).toEqual([wav])
    expect(albumArtistOverride(wav)).toBe('Fixed')
  })

  it('caps a call at 500 distinct tracks and says how to split it', async () => {
    const many = Array.from({ length: 501 }, (_, i) => i + 1)
    expect(
      await fail('stage_tag_changes', { changes: [{ trackIds: many, set: { title: 'x' } }] })
    ).toMatch(/501 tracks is over the limit of 500 per call/)
    expect(await fail('revert_staged', { trackIds: many })).toMatch(/over the limit of 500/)
  })

  it('revert_staged drops the named fields, then everything, and journals it', async () => {
    await call('stage_tag_changes', {
      changes: [{ trackIds: tracks, set: { albumArtist: 'Fixed', conductor: 'Someone' } }]
    })
    const one = await call('revert_staged', { trackIds: tracks.slice(0, 2), fields: ['conductor'] })
    expect(one).toMatchObject({ reverting: 2, tracks: 2, byField: { conductor: 2 } })
    expect(tagOverride(tracks[0]!, 'conductor')).toBeNull()
    expect(albumArtistOverride(tracks[0]!)).toBe('Fixed')

    expect(await fail('revert_staged', { trackIds: tracks, fields: ['mood'] })).toMatch(
      /not a tag field/
    )

    const all = await call('revert_staged', { trackIds: tracks })
    expect(all).toMatchObject({ reverting: 6 + 4, byField: { albumArtist: 6, conductor: 4 } })
    expect(tracks.map(albumArtistOverride)).toEqual(Array(6).fill(null))
    expect(await writeback.preview(tracks)).toEqual([])
  })

  it('no tool reaches the flush', async () => {
    const apply = vi.spyOn(writeback, 'apply')
    const cancel = vi.spyOn(writeback, 'cancel')
    const { tools } = await client.listTools()
    // A plausible call to every tool there is, then the obvious misuse of each.
    const calls: Record<string, Record<string, unknown>> = {
      stage_tag_changes: { changes: [{ trackIds: tracks, set: { albumArtist: 'Fixed' } }] },
      list_staged: {},
      revert_staged: { trackIds: tracks },
      begin_changeset: { description: 'spy' },
      list_changesets: {},
      create_playlist: { name: 'spy' },
      add_user_tag: { trackIds: tracks, label: 'spy' }
    }
    for (const tool of tools) {
      await client.callTool({ name: tool.name, arguments: calls[tool.name] ?? {} })
      await client.callTool({ name: tool.name, arguments: { apply: true, write: true } })
    }
    await call('stage_tag_changes', calls.stage_tag_changes!)
    const changesetId = (await call('list_changesets', {})).changesets as Array<{ id: number }>
    await client.callTool({
      name: 'revert_changeset',
      arguments: { changesetId: changesetId[0]!.id }
    })
    expect(tools.map((tool) => tool.name)).not.toContain('apply_tag_writeback')
    expect(apply).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('badges the rows an agent staged, and not after the operator edits one', async () => {
    const staged = await call('stage_tag_changes', {
      changes: [{ trackIds: tracks.slice(0, 3), set: { albumArtist: 'Fixed', conductor: 'Agent' } }]
    })
    // The operator's own edits, outside any changeset: one on a fresh track,
    // and one over a field the agent staged.
    await library.setOverrides({ trackIds: [tracks[3]!], patch: { albumArtist: 'Mine' } })
    await library.setOverrides({ trackIds: [tracks[0]!], patch: { albumArtist: 'Mine' } })
    await library.setTagOverrides({
      trackIds: [tracks[0]!],
      patch: { conductor: 'Mine' } as Partial<Record<TagFieldKey, TagFieldValue>>
    })

    const byTrack = new Map((await writeback.previewPending()).map((row) => [row.trackId, row]))
    const changesetId = staged.changesetId as number
    expect(byTrack.get(tracks[1]!)!.agent).toEqual({
      fields: expect.arrayContaining(['albumArtist', 'conductor']),
      changesetIds: [changesetId]
    })
    expect(byTrack.get(tracks[1]!)!.agent!.fields).toHaveLength(2)
    // Every field the agent left was edited since: no badge.
    expect(byTrack.get(tracks[0]!)!.agent).toBeUndefined()
    // The operator's own edit was never an agent's.
    expect(byTrack.get(tracks[3]!)!.agent).toBeUndefined()

    // A reverted changeset is no one's badge either.
    await journal.revert(changesetId)
    const after = await writeback.previewPending()
    expect(after.some((row) => row.agent !== undefined)).toBe(false)
  })
})
