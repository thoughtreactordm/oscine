import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { LibraryChanged } from '@shared/libraryChanges'
import { openDatabase } from '../../../src/main/db'
import { createLibraryChangeNotifier } from '../../../src/main/library/changes'
import { SqlitePlaylistService } from '../../../src/main/library/playlists/service'
import {
  AGENT_SERVER_INSTRUCTIONS,
  applyAgentCapabilities,
  createAgentMcpServer
} from '../../../src/main/mcp'
import { createJournalEntities } from '../../../src/main/mcp/journal/entities'
import { createAgentJournal, type AgentJournal } from '../../../src/main/mcp/journal/journal'
import { createOrganizeReads } from '../../../src/main/mcp/organize/reads'
import { REFRESH_SMART_PLAYLISTS_PROMPT } from '../../../src/main/mcp/prompts/refreshSmartPlaylists'
import { TagStore } from '../../../src/main/tags/store'
import { overviewOnlyTools } from './fakeTools'

/**
 * Smart playlists — **W24-9**, `oscine-mcp` → D36.8: the operator's removal
 * excludes, an agent's add skips what is excluded, adding by hand clears it,
 * every smart-playlist write is journaled and reverts, and with no agent a
 * smart playlist is an ordinary one.
 */

const OVERVIEW = {
  trackCount: 0,
  albumCount: 0,
  artistCount: 0,
  totalDurationMs: 0,
  roots: []
} as never

describe('smart playlists', () => {
  let dir: string
  let db: Database.Database
  let events: LibraryChanged[]
  let playlists: SqlitePlaylistService
  let journal: AgentJournal
  let tracks: number[]
  let server: McpServer
  let client: Client
  let exportTo: string | null

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-smart-playlists-'))
    db = openDatabase(join(dir, 'library.db')).db
    events = []
    exportTo = null
    const changes = createLibraryChangeNotifier({ emit: (event) => events.push(event) })
    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', join(dir, 'music'), 1).lastInsertRowid
    )
    const insert = db.prepare(
      'INSERT INTO tracks (root_id, rel_path, mtime, size, title) VALUES (?, ?, 1, 1, ?)'
    )
    tracks = db.transaction(() =>
      Array.from({ length: 12 }, (_, i) =>
        Number(insert.run(rootId, `t${i}.flac`, `Track ${i}`).lastInsertRowid)
      )
    )()
    playlists = new SqlitePlaylistService({
      db,
      changes,
      pickExportFile: async () => exportTo
    })
    const tags = new TagStore(db, changes)
    const noWrites = async (): Promise<never> => {
      throw new Error('unused')
    }
    journal = createAgentJournal({
      db,
      changes,
      entities: createJournalEntities({
        db,
        playlists,
        tags,
        library: {
          setOverrides: noWrites,
          clearOverrides: noWrites,
          setTagOverrides: noWrites,
          revertTagOverrides: noWrites
        }
      })
    })
    const base = overviewOnlyTools(OVERVIEW)
    server = createAgentMcpServer(
      {
        ...base,
        // get_playlist falls back to `{ id }` for a track it has no fields for.
        library: { ...base.library, getAgentTracks: async () => [] },
        playlists,
        journal,
        organize: { playlists, tags, reads: createOrganizeReads(db) }
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

  const entries = (playlistId: number): Array<{ id: number; trackId: number }> =>
    db
      .prepare(
        `SELECT id, track_id AS trackId FROM playlist_entries
         WHERE playlist_id = ? ORDER BY position, id`
      )
      .all(playlistId) as Array<{ id: number; trackId: number }>

  const trackOrder = (playlistId: number): number[] => entries(playlistId).map((e) => e.trackId)

  const excluded = (playlistId: number): Array<{ trackId: number; source: string }> =>
    db
      .prepare(
        `SELECT track_id AS trackId, source FROM playlist_exclusions
         WHERE playlist_id = ? ORDER BY track_id`
      )
      .all(playlistId) as Array<{ trackId: number; source: string }>

  async function smartPlaylist(name = 'Late Night'): Promise<number> {
    const { id } = await playlists.create(name)
    await playlists.setKind(id, 'smart')
    await playlists.setBrief(id, 'Instrumental, nothing over 95 BPM')
    return id
  }

  /** What an agent does on a refresh: read, add what is missing, leave notes. */
  async function refresh(playlistId: number, candidates: number[]) {
    const listed = await call('list_playlists', {})
    const smart = (listed.playlists as Array<{ id: number; kind: string }>).filter(
      (playlist) => playlist.kind === 'smart'
    )
    expect(smart.map((playlist) => playlist.id)).toContain(playlistId)
    const read = await call('get_playlist', { playlistId })
    const present = new Set(
      (read.entries as Array<{ track: { id: number } }>).map((entry) => entry.track.id)
    )
    const missing = candidates.filter((id) => !present.has(id))
    const added =
      missing.length === 0 ? null : await call('add_to_playlist', { playlistId, trackIds: missing })
    await call('update_agent_notes', { playlistId, notes: `Added ${missing.length}` })
    return { read, added }
  }

  it('keeps a removed track out of the next refresh, and lets it back in by hand', async () => {
    const playlistId = await smartPlaylist()
    const fits = tracks.slice(0, 5)

    // First refresh: the missing tracks appear, and the playlist is marked refreshed.
    const first = await refresh(playlistId, fits)
    expect(first.read.playlist).toMatchObject({
      kind: 'smart',
      brief: 'Instrumental, nothing over 95 BPM',
      agentNotes: null,
      refreshedAt: null,
      excluded: 0
    })
    expect(first.read.exclusions).toEqual({ tracks: [], total: 0 })
    expect(first.added).toMatchObject({ added: 5 })
    expect(trackOrder(playlistId)).toEqual(fits)
    const afterFirst = (await playlists.list())[0]!
    expect(afterFirst.agentNotes).toBe('Added 5')
    expect(afterFirst.refreshedAt).not.toBeNull()

    // The operator removes one: through the IPC path, which is the default actor.
    const removed = entries(playlistId)[2]!
    await playlists.removeEntries({ playlistId, entryIds: [removed.id] })
    expect(excluded(playlistId)).toEqual([{ trackId: removed.trackId, source: 'operator' }])

    // Second refresh: the agent proposes it again; it is skipped and stays out.
    const second = await refresh(playlistId, fits)
    expect(second.read.exclusions).toEqual({
      tracks: [{ trackId: removed.trackId, source: 'operator' }],
      total: 1
    })
    expect(second.added).toMatchObject({ added: 0, skipped: { excluded: [removed.trackId] } })
    expect(trackOrder(playlistId)).not.toContain(removed.trackId)

    // The operator adds it back by hand: the exclusion clears.
    await playlists.addTracks({ playlistId, trackIds: [removed.trackId], insertion: { at: 'end' } })
    expect(excluded(playlistId)).toEqual([])
    expect(trackOrder(playlistId)).toContain(removed.trackId)
  })

  it('skips excluded tracks in a dry run too, and reports them', async () => {
    const playlistId = await smartPlaylist()
    await playlists.addExclusions(playlistId, [tracks[1]!], 'operator')
    const dry = await call('add_to_playlist', {
      playlistId,
      trackIds: [tracks[0], tracks[1], tracks[2]],
      dryRun: true
    })
    expect(dry).toMatchObject({ dryRun: true, added: 2, skipped: { excluded: [tracks[1]] } })
    expect(entries(playlistId)).toEqual([])
    const real = await call('add_to_playlist', {
      playlistId,
      trackIds: [tracks[0], tracks[1], tracks[2]]
    })
    expect(real.entryIds as number[]).toHaveLength(2)
    expect(trackOrder(playlistId)).toEqual([tracks[0], tracks[2]])
  })

  it('does not skip on a static playlist, and an operator removal there excludes nothing', async () => {
    const { id: playlistId } = await playlists.create('Static')
    await playlists.addExclusions(playlistId, [tracks[0]!], 'operator')
    await call('add_to_playlist', { playlistId, trackIds: [tracks[0], tracks[1]] })
    expect(trackOrder(playlistId)).toEqual([tracks[0], tracks[1]])
    await playlists.removeEntries({ playlistId, entryIds: [entries(playlistId)[1]!.id] })
    expect(excluded(playlistId).map((row) => row.trackId)).toEqual([tracks[0]])
    expect(
      await fail('remove_playlist_entries', {
        playlistId,
        entryIds: [entries(playlistId)[0]!.id],
        exclude: true
      })
    ).toContain('smart playlists only')
  })

  it('does not exclude a track another entry still names', async () => {
    const playlistId = await smartPlaylist()
    await playlists.addTracks({
      playlistId,
      trackIds: [tracks[0]!, tracks[0]!, tracks[1]!],
      insertion: { at: 'end' }
    })
    const [one] = entries(playlistId)
    await playlists.removeEntries({ playlistId, entryIds: [one!.id] })
    expect(excluded(playlistId)).toEqual([])
  })

  it('lets an agent removal exclude on request, and a revert undoes both', async () => {
    const playlistId = await smartPlaylist()
    await playlists.addTracks({
      playlistId,
      trackIds: tracks.slice(0, 3),
      insertion: { at: 'end' }
    })
    const before = trackOrder(playlistId)

    // Without `exclude` an agent's removal is tidying, not a ruling.
    const { changesetId } = await call('begin_changeset', { description: 'Prune' })
    await call('remove_playlist_entries', { playlistId, entryIds: [entries(playlistId)[0]!.id] })
    expect(excluded(playlistId)).toEqual([])

    const kept = await call('remove_playlist_entries', {
      playlistId,
      entryIds: [entries(playlistId)[0]!.id],
      exclude: true
    })
    expect(kept).toMatchObject({ excluded: [tracks[1]] })
    expect(excluded(playlistId)).toEqual([{ trackId: tracks[1], source: 'agent' }])

    const reverted = await journal.revert(changesetId as number)
    expect(reverted.skipped).toBe(0)
    expect(trackOrder(playlistId)).toEqual(before)
    expect(excluded(playlistId)).toEqual([])
  })

  it('reverts an agent’s add to a smart playlist without excluding what it takes out', async () => {
    const playlistId = await smartPlaylist()
    const { changesetId } = await call('begin_changeset', { description: 'Refresh' })
    await call('add_to_playlist', { playlistId, trackIds: tracks.slice(0, 4) })
    const reverted = await journal.revert(changesetId as number)
    expect(reverted.skipped).toBe(0)
    expect(entries(playlistId)).toEqual([])
    expect(excluded(playlistId)).toEqual([])
  })

  it('journals set_smart_playlist and update_agent_notes, and reverts them', async () => {
    const { id: playlistId } = await playlists.create('Mix')
    const refused = await fail('update_agent_notes', { playlistId, notes: 'x' })
    expect(refused).toContain('static')

    const { changesetId } = await call('begin_changeset', { description: 'Make it smart' })
    const dry = await call('set_smart_playlist', {
      playlistId,
      kind: 'smart',
      brief: '  Rainy-day folk  ',
      dryRun: true
    })
    expect(dry).toMatchObject({
      dryRun: true,
      kind: { from: 'static', to: 'smart' },
      brief: { from: null, to: 'Rainy-day folk' }
    })
    expect((await playlists.list())[0]!.kind).toBe('static')

    await call('set_smart_playlist', { playlistId, kind: 'smart', brief: 'Rainy-day folk' })
    await call('update_agent_notes', { playlistId, notes: 'genre:folk' })
    const smart = (await playlists.list())[0]!
    expect(smart).toMatchObject({
      kind: 'smart',
      brief: 'Rainy-day folk',
      agentNotes: 'genre:folk'
    })
    expect(events.at(-1)).toMatchObject({ origin: 'agent', changes: { playlists: [playlistId] } })

    const unchanged = await call('set_smart_playlist', { playlistId, kind: 'smart' })
    expect(unchanged).toMatchObject({ unchanged: true })

    const reverted = await journal.revert(changesetId as number)
    expect(reverted).toMatchObject({ restored: 3, skipped: 0 })
    expect((await playlists.list())[0]).toMatchObject({
      kind: 'static',
      brief: null,
      agentNotes: null
    })
  })

  it('round-trips kind through the service, list_playlists and the journal entity', async () => {
    const playlistId = await smartPlaylist()
    expect((await playlists.list())[0]!.kind).toBe('smart')
    const listed = await call('list_playlists', {})
    expect(listed.playlists).toEqual([
      expect.objectContaining({ id: playlistId, kind: 'smart', excluded: 0 })
    ])
    await playlists.setKind(playlistId, 'static')
    const again = await call('list_playlists', {})
    expect(again.playlists).toEqual([expect.objectContaining({ id: playlistId, kind: 'static' })])
    expect(again.playlists as Array<Record<string, unknown>>).not.toContainEqual(
      expect.objectContaining({ brief: expect.anything() })
    )
    // Making it static keeps the brief for when it is made smart again.
    expect((await playlists.list())[0]!.brief).toBe('Instrumental, nothing over 95 BPM')

    const entities = createJournalEntities({
      db,
      playlists,
      tags: new TagStore(db),
      library: {} as never
    })
    for (const [field, value] of [
      ['kind', 'smart'],
      ['brief', 'Something else'],
      ['agentNotes', 'notes'],
      ['exclusions', [tracks[2], tracks[5]]],
      ['exclusions', [tracks[5]]],
      ['brief', null]
    ] as const) {
      await entities.playlist.write(playlistId, field, value)
      expect(entities.playlist.read(playlistId, field), field).toEqual(value)
    }
  })

  it('offers the refresh prompt under Organize, carrying no library text', async () => {
    const playlistId = await smartPlaylist()
    expect(AGENT_SERVER_INSTRUCTIONS).toContain('smart')
    expect(client.getInstructions()).toBe(AGENT_SERVER_INSTRUCTIONS)

    const { prompts } = await client.listPrompts()
    expect(prompts.map((prompt) => prompt.name)).toContain(REFRESH_SMART_PLAYLISTS_PROMPT)
    const all = await client.getPrompt({ name: REFRESH_SMART_PLAYLISTS_PROMPT, arguments: {} })
    const text = JSON.stringify(all.messages)
    for (const tool of [
      'list_playlists',
      'get_playlist',
      'add_to_playlist',
      'update_agent_notes'
    ]) {
      expect(text).toContain(tool)
    }
    expect(text).not.toContain('Instrumental')
    const one = await client.getPrompt({
      name: REFRESH_SMART_PLAYLISTS_PROMPT,
      arguments: { playlistId: String(playlistId) }
    })
    expect(JSON.stringify(one.messages)).toContain(`id ${playlistId}`)

    applyAgentCapabilities(server, { read: true, organize: false, stage: true })
    expect((await client.listPrompts()).prompts).toEqual([])
  })

  it('plays and exports like an ordinary playlist when no agent is present', async () => {
    const smartId = await smartPlaylist('Smart')
    const { id: staticId } = await playlists.create('Static')
    for (const playlistId of [smartId, staticId]) {
      await playlists.addTracks({
        playlistId,
        trackIds: tracks.slice(0, 4),
        insertion: { at: 'end' }
      })
    }
    await playlists.addExclusions(smartId, [tracks[8]!], 'operator')

    // Playback reads entries; the kind and exclusions do not reach them.
    const read = async (playlistId: number) =>
      (await playlists.listEntries({ playlistId, offset: 0, limit: 100 })).entries.map(
        (entry) => entry.track.id
      )
    expect(await read(smartId)).toEqual(await read(staticId))

    const written: string[] = []
    for (const [playlistId, name] of [
      [smartId, 'smart.m3u8'],
      [staticId, 'static.m3u8']
    ] as const) {
      exportTo = join(dir, name)
      const result = await playlists.exportM3u8({ playlistId, pathStyle: 'relative' })
      expect(result).toMatchObject({ entryCount: 4, skippedCount: 0 })
      written.push(readFileSync(exportTo, 'utf8'))
    }
    expect(written[0]).toBe(written[1])
  })
})
