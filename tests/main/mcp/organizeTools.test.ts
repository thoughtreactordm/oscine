import { mkdtempSync, rmSync } from 'node:fs'
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
import { applyAgentCapabilities, createAgentMcpServer } from '../../../src/main/mcp'
import { createJournalEntities } from '../../../src/main/mcp/journal/entities'
import { createAgentJournal, type AgentJournal } from '../../../src/main/mcp/journal/journal'
import { createOrganizeReads } from '../../../src/main/mcp/organize/reads'
import { TagStore } from '../../../src/main/tags/store'
import { planLibraryRefetch } from '../../../src/renderer/stores/libraryChangePlan'
import { overviewOnlyTools } from './fakeTools'

/**
 * The Organize tools over a real client, the real schema and the real services
 * — **W24-7**, `oscine-mcp` → D36.5/D36.7: each tool round-trips through its
 * service and the journal, `dryRun` writes nothing, the 500 cap says how to
 * split, every call is one `library.changed`, and a Revert undoes it all.
 */

const OVERVIEW = {
  trackCount: 0,
  albumCount: 0,
  artistCount: 0,
  totalDurationMs: 0,
  roots: []
} as never

const ORGANIZE_TOOLS = [
  'create_playlist',
  'rename_playlist',
  'reorder_playlists',
  'add_to_playlist',
  'move_playlist_entries',
  'remove_playlist_entries',
  'set_playlist_order',
  'add_user_tag',
  'remove_user_tag',
  'set_smart_playlist',
  'update_agent_notes'
]

describe('organize tools', () => {
  let dir: string
  let db: Database.Database
  let events: LibraryChanged[]
  let playlists: SqlitePlaylistService
  let tags: TagStore
  let journal: AgentJournal
  let tracks: number[]
  let server: McpServer
  let client: Client

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-organize-tools-'))
    db = openDatabase(join(dir, 'library.db')).db
    events = []
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
      Array.from({ length: 220 }, (_, i) =>
        Number(insert.run(rootId, `t${i}.flac`, `Track ${i}`).lastInsertRowid)
      )
    )()
    playlists = new SqlitePlaylistService({ db, changes, pickExportFile: async () => null })
    tags = new TagStore(db, changes)
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
    server = createAgentMcpServer(
      {
        ...overviewOnlyTools(OVERVIEW),
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

  const changeRows = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM agent_changes').get() as { n: number }).n

  /** Everything an Organize call could touch in the library. */
  const libraryState = (): string =>
    JSON.stringify([
      db.prepare('SELECT * FROM playlists ORDER BY id').all(),
      db.prepare('SELECT * FROM playlist_entries ORDER BY id').all(),
      db.prepare('SELECT * FROM tags ORDER BY id').all(),
      db.prepare('SELECT * FROM track_tags ORDER BY track_id, tag_id').all()
    ])

  /** The library and the journal, to show a dry run touched neither. */
  const snapshot = (): string => JSON.stringify([libraryState(), changeRows()])

  it('is listed under Organize and hidden when it is off', async () => {
    const names = async () => (await client.listTools()).tools.map((tool) => tool.name)
    expect(await names()).toEqual(expect.arrayContaining(ORGANIZE_TOOLS))
    expect(await names()).not.toContain('delete_playlist')
    applyAgentCapabilities(server, { read: true, organize: false, stage: true })
    const hidden = await names()
    for (const tool of ORGANIZE_TOOLS) expect(hidden).not.toContain(tool)
  })

  it('builds, reorders and edits a 200-track playlist live, and one Revert undoes it', async () => {
    const { changesetId } = await call('begin_changeset', { description: 'Build a mix' })
    const before = libraryState()

    const created = await call('create_playlist', { name: '  Late Night  ' })
    const playlistId = created.playlistId as number
    expect(created).toMatchObject({ dryRun: false, created: { name: 'Late Night' }, changesetId })

    // The operator watches it appear: one agent-origin event, which the
    // sidebar's refetch plan answers by reloading the playlists.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ origin: 'agent', changes: { playlists: [playlistId] } })
    expect(planLibraryRefetch(events[0]!).playlists).toBe(true)

    const picked = tracks.slice(0, 200)
    const added = await call('add_to_playlist', { playlistId, trackIds: picked })
    expect(added).toMatchObject({ added: 200, at: 0, entries: { before: 0, after: 200 } })
    expect(added.entryIds as number[]).toHaveLength(200)
    expect(trackOrder(playlistId)).toEqual(picked)
    expect(events).toHaveLength(2)

    const reversed = [...entries(playlistId)].reverse().map((entry) => entry.id)
    const ordered = await call('set_playlist_order', { playlistId, entryIds: reversed })
    expect(ordered).toMatchObject({ moved: 199, unchanged: 1 })
    expect(entries(playlistId).map((entry) => entry.id)).toEqual(reversed)
    // 199 moves, one call: still one event.
    expect(events).toHaveLength(3)

    const firstTwo = reversed.slice(0, 2)
    await call('move_playlist_entries', {
      playlistId,
      entryIds: firstTwo,
      insertion: { at: 'end' }
    })
    expect(
      entries(playlistId)
        .slice(-2)
        .map((entry) => entry.id)
    ).toEqual(firstTwo)

    await call('remove_playlist_entries', { playlistId, entryIds: reversed.slice(10, 20) })
    expect(entries(playlistId)).toHaveLength(190)

    await call('rename_playlist', { playlistId, name: 'Late Night (edit)' })
    expect(events).toHaveLength(6)
    expect(events.every((event) => event.origin === 'agent')).toBe(true)

    const reverted = await journal.revert(changesetId as number)
    expect(reverted.skipped).toBe(0)
    expect(libraryState()).toBe(before)
    expect(await playlists.list()).toEqual([])
  })

  it('writes nothing on a dry run, and reports the diff it would apply', async () => {
    const other = await playlists.create('Other')
    const mix = await playlists.create('Mix')
    await playlists.addTracks({
      playlistId: mix.id,
      trackIds: tracks.slice(0, 5),
      insertion: { at: 'end' }
    })
    tags.addTag(tracks.slice(0, 2), 'Chill', 'user')
    const ids = entries(mix.id).map((entry) => entry.id)
    events.length = 0
    const before = snapshot()

    const dry = { dryRun: true }
    expect(await call('create_playlist', { name: 'New', ...dry })).toEqual({
      dryRun: true,
      created: { name: 'New', position: 2 }
    })
    expect(await call('rename_playlist', { playlistId: mix.id, name: 'Mix 2', ...dry })).toEqual({
      dryRun: true,
      playlistId: mix.id,
      name: { from: 'Mix', to: 'Mix 2' }
    })
    expect(
      await call('reorder_playlists', { playlistId: mix.id, toIndex: 0, ...dry })
    ).toMatchObject({ position: { from: 1, to: 0 } })
    expect(
      await call('add_to_playlist', {
        playlistId: mix.id,
        trackIds: [tracks[9]],
        insertion: { at: 'after', entryId: ids[1] },
        ...dry
      })
    ).toMatchObject({ added: 1, at: 2, entries: { before: 5, after: 6 } })
    expect(
      await call('move_playlist_entries', {
        playlistId: mix.id,
        entryIds: [ids[4]],
        insertion: { at: 'start' },
        ...dry
      })
    ).toMatchObject({ moved: 1, at: 0 })
    expect(
      await call('remove_playlist_entries', { playlistId: mix.id, entryIds: [ids[0]], ...dry })
    ).toMatchObject({ removed: [{ entryId: ids[0], trackId: tracks[0] }] })
    expect(
      await call('set_playlist_order', {
        playlistId: mix.id,
        entryIds: [...ids].reverse(),
        ...dry
      })
    ).toMatchObject({ moved: 4, unchanged: 1 })
    expect(
      await call('add_user_tag', { trackIds: tracks.slice(0, 4), label: 'chill', ...dry })
    ).toEqual({ dryRun: true, tag: 'Chill', newTag: false, added: 2, alreadyTagged: 2 })
    expect(
      await call('remove_user_tag', { trackIds: tracks.slice(0, 4), label: 'CHILL', ...dry })
    ).toEqual({ dryRun: true, tag: 'Chill', removed: 2, notTagged: 2 })

    expect(snapshot()).toBe(before)
    expect(events).toEqual([])
    expect(journal.count()).toBe(0)
    expect(other.id).toBeLessThan(mix.id)
  })

  it('refuses more than 500 tracks or entries with how to split the call', async () => {
    const mix = await playlists.create('Mix')
    const many = Array.from({ length: 501 }, (_, i) => i + 1)
    for (const [name, args] of [
      ['add_to_playlist', { playlistId: mix.id, trackIds: many }],
      ['remove_playlist_entries', { playlistId: mix.id, entryIds: many }],
      ['move_playlist_entries', { playlistId: mix.id, entryIds: many, insertion: { at: 'end' } }],
      ['set_playlist_order', { playlistId: mix.id, entryIds: many }],
      ['add_user_tag', { trackIds: many, label: 'x' }],
      ['remove_user_tag', { trackIds: many, label: 'x' }]
    ] as const) {
      const message = await fail(name, args)
      expect(message).toContain('over the limit of 500 per call')
      expect(message).toContain('2 calls')
    }
    expect(changeRows()).toBe(0)
  })

  it('reorders the rail and reverts it', async () => {
    const [a, b, c] = [
      await playlists.create('A'),
      await playlists.create('B'),
      await playlists.create('C')
    ]
    const { changesetId } = await call('begin_changeset', { description: 'Rail' })
    expect(await call('reorder_playlists', { playlistId: a.id, toIndex: 99 })).toMatchObject({
      position: { from: 0, to: 2 },
      recorded: 1
    })
    expect((await playlists.list()).map((p) => p.id)).toEqual([b.id, c.id, a.id])
    await journal.revert(changesetId as number)
    expect((await playlists.list()).map((p) => p.id)).toEqual([a.id, b.id, c.id])
  })

  it('adds and removes user tags through the tag store, and reverts them', async () => {
    tags.addTag([tracks[0]!], 'Morning', 'user')
    const { changesetId } = await call('begin_changeset', { description: 'Tags' })

    const added = await call('add_user_tag', { trackIds: tracks.slice(0, 3), label: 'Focus' })
    expect(added).toMatchObject({ tag: 'Focus', newTag: true, added: 3, recorded: 3 })
    expect(tags.tagsForTrack(tracks[2]!).user.map((t) => t.label)).toEqual(['Focus'])

    const removed = await call('remove_user_tag', { trackIds: [tracks[0]], label: 'morning' })
    expect(removed).toMatchObject({ removed: 1, recorded: 1 })
    expect(tags.tagsForTrack(tracks[0]!).user.map((t) => t.label)).toEqual(['Focus'])
    expect(events.at(-1)).toMatchObject({ origin: 'agent', changes: { tags: [tracks[0]] } })

    expect(await fail('remove_user_tag', { trackIds: [tracks[0]], label: 'Nope' })).toContain(
      'No tag is called'
    )

    await journal.revert(changesetId as number)
    expect(tags.tagsForTrack(tracks[0]!).user.map((t) => t.label)).toEqual(['Morning'])
    expect(tags.tagsForTrack(tracks[2]!).user).toEqual([])
  })

  it('answers bad ids with a readable error and writes nothing', async () => {
    const mix = await playlists.create('Mix')
    const other = await playlists.create('Other')
    await playlists.addTracks({
      playlistId: other.id,
      trackIds: [tracks[0]!],
      insertion: { at: 'end' }
    })
    const foreign = entries(other.id)[0]!.id

    expect(await fail('add_to_playlist', { playlistId: 9999, trackIds: [tracks[0]] })).toContain(
      'list_playlists'
    )
    expect(await fail('add_to_playlist', { playlistId: mix.id, trackIds: [999_999] })).toContain(
      'not in the library'
    )
    expect(
      await fail('add_to_playlist', {
        playlistId: mix.id,
        trackIds: [tracks[0]],
        insertion: { at: 'before', entryId: foreign }
      })
    ).toContain('insertion anchor')
    expect(
      await fail('remove_playlist_entries', { playlistId: mix.id, entryIds: [foreign] })
    ).toContain('not in this playlist')
    expect(await fail('create_playlist', { name: '   ' })).toContain('must not be empty')
    expect(changeRows()).toBe(0)
    expect(entries(mix.id)).toEqual([])
  })
})
