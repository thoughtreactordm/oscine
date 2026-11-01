import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentCapabilities } from '@shared/agentAccess'
import { openDatabase } from '../../../src/main/db'
import { NO_LIBRARY_CHANGES } from '../../../src/main/library/changes'
import { SqlitePlaylistService } from '../../../src/main/library/playlists/service'
import { applyAgentCapabilities, createAgentMcpServer } from '../../../src/main/mcp'
import { createJournalEntities } from '../../../src/main/mcp/journal/entities'
import { createAgentJournal, type AgentJournal } from '../../../src/main/mcp/journal/journal'
import { TagStore } from '../../../src/main/tags/store'
import { overviewOnlyTools } from './fakeTools'

/**
 * The changeset tools over a real client — **W24-6**, D36.6/D36.7: listed
 * while either write capability is on, `begin_changeset` names the task, and
 * `revert_changeset` respects the live switches.
 */

const OVERVIEW = {
  trackCount: 0,
  albumCount: 0,
  artistCount: 0,
  totalDurationMs: 0,
  roots: []
} as never

describe('changeset tools', () => {
  let dir: string
  let db: Database.Database
  let journal: AgentJournal
  let playlists: SqlitePlaylistService
  let server: McpServer
  let client: Client
  let switches: AgentCapabilities

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-changeset-tools-'))
    db = openDatabase(join(dir, 'library.db')).db
    playlists = new SqlitePlaylistService({ db, pickExportFile: async () => null })
    const noWrites = async (): Promise<never> => {
      throw new Error('unused')
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
    switches = { read: true, organize: true, stage: true }
    server = createAgentMcpServer(
      { ...overviewOnlyTools(OVERVIEW), journal },
      '0.0.0-test',
      switches,
      {
        capabilities: () => switches
      }
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

  const names = async (): Promise<string[]> =>
    (await client.listTools()).tools.map((tool) => tool.name)

  it('is listed while either write capability is on, and hidden with both off', async () => {
    const tools = ['begin_changeset', 'list_changesets', 'revert_changeset']
    expect(await names()).toEqual(expect.arrayContaining(tools))
    applyAgentCapabilities(server, { read: true, organize: false, stage: true })
    expect(await names()).toEqual(expect.arrayContaining(tools))
    applyAgentCapabilities(server, { read: true, organize: false, stage: false })
    const hidden = await names()
    for (const tool of tools) expect(hidden).not.toContain(tool)
  })

  it('begins a named changeset under the client’s name and lists it as open', async () => {
    const { changesetId } = await call('begin_changeset', { description: 'Tidy playlists' })
    const listed = await call('list_changesets', {})
    expect(listed.changesets).toEqual([
      expect.objectContaining({
        id: changesetId,
        client: 'vitest-agent',
        description: 'Tidy playlists',
        origin: 'explicit',
        open: true,
        changes: 0
      })
    ])
  })

  it('reverts, and skips what the live switches do not cover', async () => {
    const playlist = await playlists.create('Before')
    const cs = journal.openChangeset({ clientName: 'x', description: null, origin: 'explicit' })
    await journal.record(cs, {
      targets: [{ kind: 'playlist', entityId: playlist.id, field: 'name' }],
      apply: () => playlists.rename(playlist.id, 'After')
    })

    switches = { read: true, organize: false, stage: true }
    expect(await call('revert_changeset', { changesetId: cs })).toMatchObject({
      restored: 0,
      skipped: 1,
      skippedChanges: [{ reason: 'capability' }]
    })

    switches = { read: true, organize: true, stage: true }
    expect(await call('revert_changeset', { changesetId: cs })).toMatchObject({
      restored: 1,
      skipped: 0
    })
    expect((await playlists.list())[0]!.name).toBe('Before')
  })

  it('answers an unknown changeset with a tool error, not a transport failure', async () => {
    const result = await client.callTool({
      name: 'revert_changeset',
      arguments: { changesetId: 4242 }
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('list_changesets')
  })

  it('ends the session’s changeset when the session closes', async () => {
    const { changesetId } = await call('begin_changeset', { description: 'Short task' })
    await client.close()
    await server.close()
    expect(journal.get(changesetId as number)!.endedAt).not.toBeNull()
  })
})
