import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryChanged } from '@shared/libraryChanges'
import { openDatabase } from '../../../src/main/db'
import { createLibraryChangeNotifier } from '../../../src/main/library/changes'
import { SqlitePlaylistService } from '../../../src/main/library/playlists/service'
import type { TrackTags } from '../../../src/main/library/metadata'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'
import { createJournalEntities } from '../../../src/main/mcp/journal/entities'
import {
  ChangesetNotFoundError,
  createAgentJournal,
  type AgentJournal
} from '../../../src/main/mcp/journal/journal'
import { createSessionJournal } from '../../../src/main/mcp/journal/session'
import { TagStore } from '../../../src/main/tags/store'

/**
 * The agent change journal — **W24-6**, `oscine-mcp` → D36.6 — against the real
 * schema and the real services: every kind records its before and after, a
 * revert restores an untouched change, skips one the operator edited since, is
 * a no-op the second time, and puts an emptied playlist back in order.
 */

const FILE_TITLE = 'Title from the file'

describe('agent change journal', () => {
  let dir: string
  let db: Database.Database
  let events: LibraryChanged[]
  let playlists: SqlitePlaylistService
  let library: SqliteLibraryService
  let tags: TagStore
  let journal: AgentJournal
  let tracks: number[]
  let changed: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-journal-'))
    db = openDatabase(join(dir, 'library.db')).db
    events = []
    changed = 0
    const changes = createLibraryChangeNotifier({ emit: (event) => events.push(event) })
    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', join(dir, 'music'), 1).lastInsertRowid
    )
    // Real files for clearOverrides to resolve; their tags come from readMetadata.
    const insert = db.prepare(
      'INSERT INTO tracks (root_id, rel_path, mtime, size, title) VALUES (?, ?, 1, 1, ?)'
    )
    tracks = Array.from({ length: 6 }, (_, i) =>
      Number(insert.run(rootId, `t${i}.flac`, FILE_TITLE).lastInsertRowid)
    )
    playlists = new SqlitePlaylistService({ db, changes, pickExportFile: async () => null })
    library = new SqliteLibraryService({
      db,
      changes,
      pickFolder: async () => null,
      onProgress: () => {},
      readMetadata: async () => ({ title: FILE_TITLE }) as TrackTags
    })
    tags = new TagStore(db, changes)
    journal = createAgentJournal({
      db,
      changes,
      entities: createJournalEntities({ db, playlists, library, tags }),
      onChanged: () => (changed += 1)
    })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const open = (): number =>
    journal.openChangeset({ clientName: 'Claude Code', description: 'Tidy', origin: 'explicit' })

  function changesOf(changesetId: number) {
    return db
      .prepare(
        `SELECT entity_kind AS kind, entity_id AS entityId, field,
                before_json AS before, after_json AS after
         FROM agent_changes WHERE changeset_id = ? ORDER BY id`
      )
      .all(changesetId) as Array<{
      kind: string
      entityId: number
      field: string
      before: string
      after: string
    }>
  }

  const entryTracks = (playlistId: number): number[] =>
    (
      db
        .prepare(
          'SELECT track_id AS id FROM playlist_entries WHERE playlist_id = ? ORDER BY position, id'
        )
        .all(playlistId) as { id: number }[]
    ).map((row) => row.id)

  describe('recording', () => {
    it('records a created playlist, its entries and a rename, with before and after', async () => {
      const cs = open()
      const { result: created } = await journal.record(cs, {
        targets: [],
        apply: () => playlists.create('Late night'),
        created: (playlist) => [{ kind: 'playlist', entityId: playlist.id, field: 'name' }]
      })
      await journal.record(cs, {
        targets: [{ kind: 'playlistEntries', entityId: created.id, field: 'entries' }],
        apply: () =>
          playlists.addTracks({
            playlistId: created.id,
            trackIds: [tracks[2]!, tracks[0]!],
            insertion: { at: 'end' }
          })
      })
      await journal.record(cs, {
        targets: [{ kind: 'playlist', entityId: created.id, field: 'name' }],
        apply: () => playlists.rename(created.id, 'Later night')
      })
      expect(changesOf(cs)).toEqual([
        {
          kind: 'playlist',
          entityId: created.id,
          field: 'name',
          before: 'null',
          after: '"Late night"'
        },
        {
          kind: 'playlistEntries',
          entityId: created.id,
          field: 'entries',
          before: '[]',
          after: JSON.stringify([tracks[2], tracks[0]])
        },
        {
          kind: 'playlist',
          entityId: created.id,
          field: 'name',
          before: '"Late night"',
          after: '"Later night"'
        }
      ])
      expect(changed).toBeGreaterThanOrEqual(3)
    })

    it('records a grouped override, a registry override and user tags', async () => {
      const cs = open()
      const track = tracks[0]!
      await journal.record(cs, {
        targets: [{ kind: 'override', entityId: track, field: 'title' }],
        apply: () => library.setOverrides({ trackIds: [track], patch: { title: 'Fixed' } })
      })
      await journal.record(cs, {
        targets: [{ kind: 'tagOverride', entityId: track, field: 'conductor' }],
        apply: () => library.setTagOverrides({ trackIds: [track], patch: { conductor: 'Someone' } })
      })
      await journal.record(cs, {
        targets: [{ kind: 'tags', entityId: track, field: 'labels' }],
        apply: async () => tags.addTag([track], 'Late Night', 'user')
      })
      expect(changesOf(cs)).toEqual([
        { kind: 'override', entityId: track, field: 'title', before: 'null', after: '"Fixed"' },
        {
          kind: 'tagOverride',
          entityId: track,
          field: 'conductor',
          before: 'null',
          after: '{"value":"Someone"}'
        },
        {
          kind: 'tags',
          entityId: track,
          field: 'labels',
          before: '[]',
          after: '[{"key":"late night","label":"Late Night","source":"user"}]'
        }
      ])
    })

    it('records nothing for a target whose value did not move', async () => {
      const cs = open()
      const { recorded } = await journal.record(cs, {
        targets: tracks.map((id) => ({ kind: 'override' as const, entityId: id, field: 'title' })),
        apply: () => library.setOverrides({ trackIds: [tracks[1]!], patch: { title: 'Only one' } })
      })
      expect(recorded).toBe(1)
      expect(changesOf(cs)).toHaveLength(1)
    })

    it('rolls the write back with its record when the call throws', async () => {
      const cs = open()
      await expect(
        journal.record(cs, {
          targets: [{ kind: 'override', entityId: tracks[0]!, field: 'title' }],
          apply: async () => {
            await library.setOverrides({ trackIds: [tracks[0]!], patch: { title: 'Doomed' } })
            throw new Error('tool failed after writing')
          }
        })
      ).rejects.toThrow('tool failed')
      expect(changesOf(cs)).toEqual([])
      const title = db.prepare('SELECT title FROM tracks WHERE id = ?').get(tracks[0]) as {
        title: string
      }
      expect(title.title).toBe(FILE_TITLE)
    })

    it('stamps the write as the agent’s and sends one library.changed per call', async () => {
      const cs = open()
      await journal.record(cs, {
        targets: tracks.map((id) => ({ kind: 'tags' as const, entityId: id, field: 'labels' })),
        apply: async () => tags.addTag(tracks, 'Bulk', 'user')
      })
      expect(events).toHaveLength(1)
      expect(events[0]!.origin).toBe('agent')
    })

    it('refuses an unknown changeset and an unknown field before writing', async () => {
      await expect(
        journal.record(999, { targets: [], apply: async () => null })
      ).rejects.toBeInstanceOf(ChangesetNotFoundError)
      const cs = open()
      let ran = false
      await expect(
        journal.record(cs, {
          targets: [{ kind: 'override', entityId: tracks[0]!, field: 'composer' }],
          apply: async () => {
            ran = true
          }
        })
      ).rejects.toThrow('not a grouped override field')
      expect(ran).toBe(false)
    })
  })

  describe('revert', () => {
    it('restores an untouched change of every kind', async () => {
      const cs = open()
      const track = tracks[0]!
      const playlist = await playlists.create('Mine')
      await journal.record(cs, {
        targets: [
          { kind: 'override', entityId: track, field: 'title' },
          { kind: 'override', entityId: track, field: 'year' }
        ],
        apply: () =>
          library.setOverrides({ trackIds: [track], patch: { title: 'Fixed', year: 1999 } })
      })
      await library.setTagOverrides({ trackIds: [track], patch: { conductor: 'Before' } })
      await journal.record(cs, {
        targets: [{ kind: 'tagOverride', entityId: track, field: 'conductor' }],
        apply: () => library.setTagOverrides({ trackIds: [track], patch: { conductor: 'After' } })
      })
      tags.addTag([track], 'Keep', 'suggested')
      await journal.record(cs, {
        targets: [{ kind: 'tags', entityId: track, field: 'labels' }],
        apply: async () => {
          tags.addTag([track], 'Added', 'user')
          const keep = tags.tagsForTrack(track).user.find((tag) => tag.label === 'Keep')!
          tags.removeTag([track], keep.id)
        }
      })
      await journal.record(cs, {
        targets: [{ kind: 'playlist', entityId: playlist.id, field: 'name' }],
        apply: () => playlists.rename(playlist.id, 'Renamed by agent')
      })

      const result = await journal.revert(cs)
      expect(result).toMatchObject({ changesetId: cs, restored: 5, skipped: 0 })

      const row = db.prepare('SELECT * FROM track_overrides WHERE track_id = ?').get(track) as
        { title: string | null; year: number | null } | undefined
      expect(row?.title ?? null).toBeNull()
      expect(row?.year ?? null).toBeNull()
      expect(
        (db.prepare('SELECT title FROM tracks WHERE id = ?').get(track) as { title: string }).title
      ).toBe(FILE_TITLE)
      expect(
        db
          .prepare('SELECT value FROM track_tag_overrides WHERE track_id = ? AND field = ?')
          .get(track, 'conductor')
      ).toEqual({ value: '"Before"' })
      expect(tags.tagsForTrack(track).user.map((tag) => [tag.label, tag.source])).toEqual([
        ['Keep', 'suggested']
      ])
      expect((await playlists.list()).find((p) => p.id === playlist.id)?.name).toBe('Mine')
      expect(journal.get(cs)).toMatchObject({ changeCount: 5, revertedCount: 5 })
    })

    it('skips and reports a change the operator edited since, restoring the rest', async () => {
      const cs = open()
      await journal.record(cs, {
        targets: tracks
          .slice(0, 2)
          .map((id) => ({ kind: 'override' as const, entityId: id, field: 'title' })),
        apply: () =>
          library.setOverrides({ trackIds: tracks.slice(0, 2), patch: { title: 'Agent' } })
      })
      // The operator corrects one of them by hand afterwards.
      await library.setOverrides({ trackIds: [tracks[1]!], patch: { title: 'Operator' } })

      const result = await journal.revert(cs)
      expect(result.restored).toBe(1)
      expect(result.skipped).toBe(1)
      expect(result.skippedChanges).toEqual([
        { kind: 'override', entityId: tracks[1], field: 'title', reason: 'conflict' }
      ])
      const title = (id: number): string =>
        (db.prepare('SELECT title FROM tracks WHERE id = ?').get(id) as { title: string }).title
      expect(title(tracks[0]!)).toBe(FILE_TITLE)
      expect(title(tracks[1]!)).toBe('Operator')
    })

    it('skips a change a later changeset overwrote', async () => {
      const first = open()
      const playlist = await playlists.create('A')
      await journal.record(first, {
        targets: [{ kind: 'playlist', entityId: playlist.id, field: 'name' }],
        apply: () => playlists.rename(playlist.id, 'B')
      })
      const second = open()
      await journal.record(second, {
        targets: [{ kind: 'playlist', entityId: playlist.id, field: 'name' }],
        apply: () => playlists.rename(playlist.id, 'C')
      })
      expect(await journal.revert(first)).toMatchObject({ restored: 0, skipped: 1 })
      expect(await journal.revert(second)).toMatchObject({ restored: 1, skipped: 0 })
      // With the later one undone, the earlier one's value is back, so it now restores.
      expect(await journal.revert(first)).toMatchObject({ restored: 1, skipped: 0 })
      expect((await playlists.list())[0]!.name).toBe('A')
    })

    it('is a no-op the second time', async () => {
      const cs = open()
      await journal.record(cs, {
        targets: [{ kind: 'override', entityId: tracks[0]!, field: 'title' }],
        apply: () => library.setOverrides({ trackIds: [tracks[0]!], patch: { title: 'X' } })
      })
      expect(await journal.revert(cs)).toMatchObject({ restored: 1, skipped: 0 })
      events.length = 0
      changed = 0
      expect(await journal.revert(cs)).toEqual({
        changesetId: cs,
        restored: 0,
        skipped: 0,
        skippedChanges: []
      })
      expect(events).toEqual([])
      expect(changed).toBe(0)
    })

    it('fully restores a playlist an agent emptied, entry order included', async () => {
      const playlist = await playlists.create('Ordered')
      const order = [tracks[3]!, tracks[0]!, tracks[5]!, tracks[0]!, tracks[1]!]
      await playlists.addTracks({
        playlistId: playlist.id,
        trackIds: order,
        insertion: { at: 'end' }
      })
      // The operator's own reshuffle, so position order is not insertion order.
      const entryIds = (
        db
          .prepare('SELECT id FROM playlist_entries WHERE playlist_id = ? ORDER BY position')
          .all(playlist.id) as { id: number }[]
      ).map((row) => row.id)
      await playlists.moveEntries({
        playlistId: playlist.id,
        entryIds: [entryIds[4]!],
        insertion: { at: 'start' }
      })
      const before = entryTracks(playlist.id)
      expect(before).toEqual([tracks[1], tracks[3], tracks[0], tracks[5], tracks[0]])

      const cs = open()
      await journal.record(cs, {
        targets: [{ kind: 'playlistEntries', entityId: playlist.id, field: 'entries' }],
        apply: async () => {
          const all = (
            db
              .prepare('SELECT id FROM playlist_entries WHERE playlist_id = ?')
              .all(playlist.id) as {
              id: number
            }[]
          ).map((row) => row.id)
          return playlists.removeEntries({ playlistId: playlist.id, entryIds: all })
        }
      })
      expect(entryTracks(playlist.id)).toEqual([])

      expect(await journal.revert(cs)).toMatchObject({ restored: 1, skipped: 0 })
      expect(entryTracks(playlist.id)).toEqual(before)
    })

    it('undoes a created playlist, entries first, and keeps one the operator filled', async () => {
      const cs = open()
      const create = (name: string) =>
        journal.record(cs, {
          targets: [],
          apply: () => playlists.create(name),
          created: (p) => [{ kind: 'playlist', entityId: p.id, field: 'name' }]
        })
      const { result: gone } = await create('Agent only')
      await journal.record(cs, {
        targets: [{ kind: 'playlistEntries', entityId: gone.id, field: 'entries' }],
        apply: () =>
          playlists.addTracks({
            playlistId: gone.id,
            trackIds: [tracks[0]!],
            insertion: { at: 'end' }
          })
      })
      const { result: kept } = await create('Operator adopts')
      await playlists.addTracks({
        playlistId: kept.id,
        trackIds: [tracks[1]!],
        insertion: { at: 'end' }
      })

      const result = await journal.revert(cs)
      const names = (await playlists.list()).map((p) => p.name)
      expect(names).toEqual(['Operator adopts'])
      expect(result.restored).toBe(2)
      expect(result.skipped).toBe(1)
      expect(result.skippedChanges).toEqual([
        { kind: 'playlist', entityId: kept.id, field: 'name', reason: 'conflict' }
      ])
      expect(entryTracks(kept.id)).toEqual([tracks[1]])
    })

    it('reports a restore that cannot land as failed, and leaves it for later', async () => {
      const unreadable = new SqliteLibraryService({
        db,
        pickFolder: async () => null,
        onProgress: () => {},
        readMetadata: async () => {
          throw new Error('file gone')
        }
      })
      const strict = createAgentJournal({
        db,
        changes: createLibraryChangeNotifier({ emit: () => {} }),
        entities: createJournalEntities({ db, playlists, library: unreadable, tags })
      })
      const cs = strict.openChangeset({ clientName: null, description: null, origin: 'session' })
      await strict.record(cs, {
        targets: [{ kind: 'override', entityId: tracks[0]!, field: 'title' }],
        apply: () => unreadable.setOverrides({ trackIds: [tracks[0]!], patch: { title: 'Y' } })
      })
      const warn = console.warn
      console.warn = () => {}
      try {
        expect(await strict.revert(cs)).toMatchObject({
          restored: 0,
          skipped: 1,
          skippedChanges: [{ reason: 'failed' }]
        })
      } finally {
        console.warn = warn
      }
      expect(strict.get(cs)).toMatchObject({ revertedCount: 0 })
    })

    it('skips what the agent’s capabilities do not cover', async () => {
      const cs = open()
      const playlist = await playlists.create('P')
      await journal.record(cs, {
        targets: [{ kind: 'playlist', entityId: playlist.id, field: 'name' }],
        apply: () => playlists.rename(playlist.id, 'Q')
      })
      await journal.record(cs, {
        targets: [{ kind: 'override', entityId: tracks[0]!, field: 'title' }],
        apply: () => library.setOverrides({ trackIds: [tracks[0]!], patch: { title: 'Z' } })
      })
      const result = await journal.revert(cs, {
        allowed: (capability) => capability === 'organize'
      })
      expect(result).toMatchObject({ restored: 1, skipped: 1 })
      expect(result.skippedChanges[0]).toMatchObject({ kind: 'override', reason: 'capability' })
    })

    it('refuses an unknown changeset', async () => {
      await expect(journal.revert(12345)).rejects.toBeInstanceOf(ChangesetNotFoundError)
    })
  })

  describe('changesets', () => {
    it('opens one implicitly per session on the first write, and an explicit one on begin', async () => {
      let writes = 0
      const session = createSessionJournal({
        journal,
        clientName: () => 'Cursor',
        beginWrite: () => {
          writes += 1
          return () => (writes -= 1)
        }
      })
      expect(session.current()).toBeNull()
      const first = await session.write({
        targets: [{ kind: 'override', entityId: tracks[0]!, field: 'title' }],
        apply: () => library.setOverrides({ trackIds: [tracks[0]!], patch: { title: 'One' } })
      })
      const again = await session.write({
        targets: [{ kind: 'override', entityId: tracks[1]!, field: 'title' }],
        apply: () => library.setOverrides({ trackIds: [tracks[1]!], patch: { title: 'Two' } })
      })
      expect(again.changesetId).toBe(first.changesetId)
      expect(writes).toBe(0)

      const named = session.begin('Fix titles')
      expect(named).not.toBe(first.changesetId)
      expect(journal.get(first.changesetId)).toMatchObject({
        origin: 'session',
        clientName: 'Cursor',
        changeCount: 2
      })
      expect(journal.get(first.changesetId)!.endedAt).not.toBeNull()

      session.end()
      expect(journal.get(named)).toMatchObject({ origin: 'explicit', description: 'Fix titles' })
      expect(journal.get(named)!.endedAt).not.toBeNull()
      expect(journal.list(10).map((c) => c.id)).toEqual([named, first.changesetId])
    })

    it('closes changesets a previous run left open', () => {
      const id = open()
      createAgentJournal({
        db,
        changes: createLibraryChangeNotifier({ emit: () => {} }),
        entities: createJournalEntities({ db, playlists, library, tags })
      })
      expect(journal.get(id)!.endedAt).not.toBeNull()
    })
  })
})
