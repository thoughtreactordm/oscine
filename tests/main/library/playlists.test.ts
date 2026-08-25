import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { PlaylistStore } from '../../../src/main/library/playlists/store'
import { spread } from '../../../src/main/library/playlists/positions'
import { isOscineError } from '../../../src/shared/errors'
import type { PlaylistInsertion } from '../../../src/shared/playlists'

let dir: string
let db: Database.Database
let store: PlaylistStore
let rootId: number
let now = 1_700_000_000_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-playlists-'))
  db = openDatabase(join(dir, 'library.db')).db
  store = new PlaylistStore(db)
  rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/srv/music', now).lastInsertRowid
  )
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Monotonic so `updatedAt` comparisons never depend on wall-clock resolution. */
function tick(): number {
  now += 1000
  return now
}

function seedTracks(count: number): number[] {
  const insert = db.prepare(
    'INSERT INTO tracks (root_id, rel_path, mtime, size, title) VALUES (?, ?, ?, ?, ?)'
  )
  const write = db.transaction((n: number) => {
    const ids: number[] = []
    for (let index = 0; index < n; index += 1) {
      ids.push(
        Number(insert.run(rootId, `t${index}.flac`, 1, 100, `Song ${index}`).lastInsertRowid)
      )
    }
    return ids
  })
  return write(count)
}

/** Raw positions in stored order — the detail the wire contract deliberately hides. */
function positions(playlistId: number): Array<{ id: number; position: number }> {
  return db
    .prepare(
      'SELECT id, position FROM playlist_entries WHERE playlist_id = ? ORDER BY position ASC, id ASC'
    )
    .all(playlistId) as Array<{ id: number; position: number }>
}

function entryIds(playlistId: number): number[] {
  return store.listEntryIds({ playlistId, offset: 0, limit: 1000 }).ids
}

function trackOrder(playlistId: number): number[] {
  return store
    .listEntries({ playlistId, offset: 0, limit: 1000 })
    .entries.map((entry) => entry.track.id)
}

function newPlaylist(name = 'Mix'): number {
  return store.create(name, tick()).id
}

describe('playlist tab CRUD', () => {
  it('creates playlists in tab order and returns them that way', () => {
    const first = store.create('Alpha', tick())
    store.create('Beta', tick())

    expect(store.list().map((playlist) => playlist.name)).toEqual(['Alpha', 'Beta'])
    expect(first.trackCount).toBe(0)
    expect(first.createdAt).toBe(first.updatedAt)
  })

  it('renames without disturbing the other tabs', () => {
    const alpha = store.create('Alpha', tick())
    store.create('Beta', tick())

    const renamed = store.rename(alpha.id, 'Aleph', tick())

    expect(renamed.name).toBe('Aleph')
    expect(renamed.updatedAt).not.toBe(alpha.updatedAt)
    expect(store.list().map((playlist) => playlist.name)).toEqual(['Aleph', 'Beta'])
  })

  it('reorders tabs and clamps a destination past the end', () => {
    const ids = ['A', 'B', 'C'].map((name) => store.create(name, tick()).id)

    expect(store.reorder(ids[2], 0, tick()).map((playlist) => playlist.name)).toEqual([
      'C',
      'A',
      'B'
    ])
    expect(store.reorder(ids[2], 99, tick()).map((playlist) => playlist.name)).toEqual([
      'A',
      'B',
      'C'
    ])
  })

  it('reports not-found rather than silently doing nothing', () => {
    const missing = 4242
    for (const act of [
      () => store.rename(missing, 'x', tick()),
      () => store.delete(missing),
      () => store.reorder(missing, 0, tick())
    ]) {
      expect(act).toThrow(expect.objectContaining({ code: 'not-found' }))
    }
  })
})

describe('playlist entries', () => {
  it('appends a batch and reads it back in order, paged', () => {
    const tracks = seedTracks(5)
    const playlistId = newPlaylist()

    const playlist = store.addTracks(playlistId, tracks, { at: 'end' }, tick())
    expect(playlist.trackCount).toBe(5)

    const page = store.listEntries({ playlistId, offset: 1, limit: 2 })
    expect(page.total).toBe(5)
    expect(page.entries.map((entry) => entry.track.id)).toEqual([tracks[1], tracks[2]])
    // The display projection is the library's, so tags come through the same joins.
    expect(page.entries[0].track.title).toBe('Song 1')

    const ids = store.listEntryIds({ playlistId, offset: 1, limit: 2 })
    expect(ids.total).toBe(5)
    expect(ids.ids).toEqual(page.entries.map((entry) => entry.id))
  })

  it('keeps the same track twice, with distinct entry ids (D12)', () => {
    const [track] = seedTracks(1)
    const playlistId = newPlaylist()

    store.addTracks(playlistId, [track, track], { at: 'end' }, tick())

    const { entries } = store.listEntries({ playlistId, offset: 0, limit: 10 })
    expect(entries).toHaveLength(2)
    expect(entries[0].track.id).toBe(entries[1].track.id)
    expect(entries[0].id).not.toBe(entries[1].id)
  })

  it('drops ids for tracks that no longer exist instead of failing the batch', () => {
    const tracks = seedTracks(2)
    const playlistId = newPlaylist()

    const playlist = store.addTracks(
      playlistId,
      [tracks[0], 9999, tracks[1]],
      { at: 'end' },
      tick()
    )

    expect(playlist.trackCount).toBe(2)
    expect(trackOrder(playlistId)).toEqual(tracks)
  })

  it('inserts at the start, before and after a named neighbour', () => {
    const tracks = seedTracks(4)
    const playlistId = newPlaylist()
    store.addTracks(playlistId, [tracks[0], tracks[1]], { at: 'end' }, tick())
    const [firstEntry, secondEntry] = entryIds(playlistId)

    store.addTracks(playlistId, [tracks[2]], { at: 'before', entryId: secondEntry }, tick())
    store.addTracks(playlistId, [tracks[3]], { at: 'after', entryId: firstEntry }, tick())

    expect(trackOrder(playlistId)).toEqual([tracks[0], tracks[3], tracks[2], tracks[1]])
  })

  it('removes entries by entry id, leaving the duplicate behind', () => {
    const [track] = seedTracks(1)
    const playlistId = newPlaylist()
    store.addTracks(playlistId, [track, track], { at: 'end' }, tick())
    const [first, second] = entryIds(playlistId)

    const playlist = store.removeEntries(playlistId, [first], tick())

    expect(playlist.trackCount).toBe(1)
    expect(entryIds(playlistId)).toEqual([second])
  })
})

describe('fractional positions', () => {
  it('writes exactly one row for a between-insert and leaves the rest byte-identical', () => {
    const tracks = seedTracks(11)
    const playlistId = newPlaylist()
    store.addTracks(playlistId, tracks.slice(0, 10), { at: 'end' }, tick())

    const before = positions(playlistId)
    const anchor = before[5].id

    store.addTracks(playlistId, [tracks[10]], { at: 'before', entryId: anchor }, tick())

    const after = positions(playlistId)
    expect(after).toHaveLength(11)

    // Every pre-existing row, compared by identity of the double itself. A
    // renumbering implementation passes an "order is still right" assertion and
    // fails this one, which is the whole point of the REAL column.
    const survivors = new Map(after.map((row) => [row.id, row.position]))
    for (const row of before) {
      expect(Object.is(survivors.get(row.id), row.position)).toBe(true)
    }

    expect(trackOrder(playlistId)).toEqual([
      ...tracks.slice(0, 5),
      tracks[10],
      ...tracks.slice(5, 10)
    ])
  })

  it('spreads a batch across one gap rather than halving it per item', () => {
    const tracks = seedTracks(102)
    const playlistId = newPlaylist()
    store.addTracks(playlistId, tracks.slice(0, 2), { at: 'end' }, tick())
    const [, secondEntry] = entryIds(playlistId)

    store.addTracks(playlistId, tracks.slice(2), { at: 'before', entryId: secondEntry }, tick())

    const rows = positions(playlistId)
    expect(rows).toHaveLength(102)
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].position).toBeGreaterThan(rows[index - 1].position)
    }
    expect(trackOrder(playlistId)).toEqual([tracks[0], ...tracks.slice(2), tracks[1]])
  })

  it('rebalances once repeated inserts at one seam exhaust float precision', () => {
    const tracks = seedTracks(120)
    const playlistId = newPlaylist()
    store.addTracks(playlistId, tracks.slice(0, 2), { at: 'end' }, tick())

    const [headEntry, tailEntry] = entryIds(playlistId)
    const positionOf = db.prepare('SELECT position FROM playlist_entries WHERE id = ?')
    const tailPosition = (positionOf.get(tailEntry) as { position: number }).position
    let rebalanced = false

    // Always drop into the same gap: the one between the head entry and
    // whatever is now immediately after it. Each insert halves that gap, so the
    // mantissa runs out after roughly fifty iterations. This drives the
    // rebalance rather than calling it.
    //
    // The tail is what reveals it. A rebalance renumbers to 1..n, which leaves
    // the head on the 1 it already had — watching that row would report no
    // rebalance had ever happened.
    for (let index = 2; index < 120; index += 1) {
      const anchor = entryIds(playlistId)[1]
      store.addTracks(playlistId, [tracks[index]], { at: 'before', entryId: anchor }, tick())
      const tail = (positionOf.get(tailEntry) as { position: number }).position
      if (!Object.is(tail, tailPosition)) rebalanced = true
    }

    expect(rebalanced).toBe(true)

    const rows = positions(playlistId)
    expect(rows).toHaveLength(120)
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].position).toBeGreaterThan(rows[index - 1].position)
    }

    // Order survived the renumbering: the head stayed put and every later
    // insert landed immediately behind it, so the tail reads newest-first.
    const expected = [tracks[0], ...tracks.slice(2).reverse(), tracks[1]]
    expect(trackOrder(playlistId)).toEqual(expected)
    expect(rows[0].id).toBe(headEntry)
  })

  it('reports an exhausted interval instead of writing colliding positions', () => {
    // The arithmetic in isolation, at the limit a rebalance is meant to rescue.
    expect(spread(1, 2, 1)).toEqual([1.5])
    expect(spread(1, 1 + Number.EPSILON, 1)).toBeNull()
    expect(spread(1, 1, 1)).toBeNull()
    expect(spread(null, null, 3)).toEqual([1, 2, 3])
    expect(spread(5, null, 2)).toEqual([6, 7])
    expect(spread(null, 5, 2)).toEqual([3, 4])
    expect(spread(1, 2, 0)).toEqual([])
  })
})

describe('moving entries', () => {
  function setup(count = 5): { playlistId: number; tracks: number[] } {
    const tracks = seedTracks(count)
    const playlistId = newPlaylist()
    store.addTracks(playlistId, tracks, { at: 'end' }, tick())
    return { playlistId, tracks }
  }

  it('moves a block to the start, preserving its internal order', () => {
    const { playlistId, tracks } = setup()
    const ids = entryIds(playlistId)

    // Handed over in reverse, because a selection is a set and callers hand it
    // over in whatever order they built it.
    store.moveEntries(playlistId, [ids[3], ids[2]], { at: 'start' }, tick())

    expect(trackOrder(playlistId)).toEqual([tracks[2], tracks[3], tracks[0], tracks[1], tracks[4]])
  })

  it('moves a block to the end and between neighbours', () => {
    const { playlistId, tracks } = setup()
    const ids = entryIds(playlistId)

    store.moveEntries(playlistId, [ids[0]], { at: 'end' }, tick())
    expect(trackOrder(playlistId)).toEqual([tracks[1], tracks[2], tracks[3], tracks[4], tracks[0]])

    store.moveEntries(playlistId, [ids[4]], { at: 'after', entryId: ids[1] }, tick())
    expect(trackOrder(playlistId)).toEqual([tracks[1], tracks[4], tracks[2], tracks[3], tracks[0]])
  })

  it('writes exactly one row for a dragged reorder and leaves the rest byte-identical', () => {
    const { playlistId, tracks } = setup(10)
    const ids = entryIds(playlistId)

    const before = positions(playlistId)
    // The gesture W5-6's contents pane produces for a single row dragged onto
    // the lower half of another: one entry, anchored on the neighbour it was
    // dropped against. The pane's whole claim to writing one row rests on this.
    store.moveEntries(playlistId, [ids[8]], { at: 'after', entryId: ids[2] }, tick())

    const after = positions(playlistId)
    expect(after).toHaveLength(10)

    // Compared by identity of the double, as the between-insert test is: an
    // implementation that renumbered the tail would order the rows correctly
    // and still fail here, which is the whole point of the REAL column.
    const survivors = new Map(after.map((row) => [row.id, row.position]))
    for (const row of before) {
      if (row.id === ids[8]) continue
      expect(Object.is(survivors.get(row.id), row.position)).toBe(true)
    }

    expect(trackOrder(playlistId)).toEqual([
      tracks[0],
      tracks[1],
      tracks[2],
      tracks[8],
      tracks[3],
      tracks[4],
      tracks[5],
      tracks[6],
      tracks[7],
      tracks[9]
    ])
  })

  it('lands a block where it was dropped even when the row above it is moving too', () => {
    const { playlistId, tracks } = setup()
    const ids = entryIds(playlistId)

    // Entries 0 and 1 are contiguous and both moving; the anchor's neighbour is
    // therefore about to vanish. Computing the gap against the rows that stay
    // is what puts the pair before track 4 rather than back where they were.
    store.moveEntries(playlistId, [ids[0], ids[1]], { at: 'before', entryId: ids[4] }, tick())

    expect(trackOrder(playlistId)).toEqual([tracks[2], tracks[3], tracks[0], tracks[1], tracks[4]])
  })

  it('treats a drop onto the moved selection itself as a no-op', () => {
    const { playlistId, tracks } = setup()
    const ids = entryIds(playlistId)
    const before = positions(playlistId)

    store.moveEntries(playlistId, [ids[1], ids[2]], { at: 'before', entryId: ids[2] }, tick())

    expect(positions(playlistId)).toEqual(before)
    expect(trackOrder(playlistId)).toEqual(tracks)
  })

  it('rejects an anchor that belongs to another playlist', () => {
    const { playlistId, tracks } = setup()
    const other = newPlaylist('Other')
    store.addTracks(other, [tracks[0]], { at: 'end' }, tick())
    const [foreignEntry] = entryIds(other)
    const stray: PlaylistInsertion = { at: 'before', entryId: foreignEntry }

    // The anchor exists — it is simply not in this playlist. Scoping the lookup
    // to the playlist is what stops a stale drag target from splicing rows into
    // a gap computed against a different list entirely.
    expect(() => store.addTracks(playlistId, [tracks[1]], stray, tick())).toThrow(
      expect.objectContaining({ code: 'not-found' })
    )
    expect(store.get(playlistId)?.trackCount).toBe(5)
  })
})

describe('cascades', () => {
  it('has foreign keys genuinely enabled on the live connection', () => {
    // The DDL declaring ON DELETE CASCADE proves nothing: the pragma is
    // per-connection and every cascade below is a no-op without it.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('deletes a playlist along with its entries, and leaves the tracks alone', () => {
    const tracks = seedTracks(3)
    const playlistId = newPlaylist()
    store.addTracks(playlistId, tracks, { at: 'end' }, tick())

    store.delete(playlistId)

    expect(db.prepare('SELECT count(*) AS n FROM playlist_entries').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) AS n FROM tracks').get()).toEqual({ n: 3 })
    expect(store.get(playlistId)).toBeNull()
  })

  it('drops a deleted track out of every playlist that referenced it', () => {
    const tracks = seedTracks(3)
    const first = newPlaylist('First')
    const second = newPlaylist('Second')
    store.addTracks(first, tracks, { at: 'end' }, tick())
    store.addTracks(second, [tracks[1], tracks[1]], { at: 'end' }, tick())

    db.prepare('DELETE FROM tracks WHERE id = ?').run(tracks[1])

    expect(trackOrder(first)).toEqual([tracks[0], tracks[2]])
    expect(store.get(second)?.trackCount).toBe(0)
  })
})

describe('batch add', () => {
  it('adds thousands of tracks with one statement execution, not one per track', () => {
    const tracks = seedTracks(5000)
    const playlistId = newPlaylist()

    // Counting statement executions rather than timing the call: a per-track
    // loop is fast enough on 5,000 rows to pass any honest time budget, so a
    // wall-clock assertion would not actually hold the line this card draws.
    const counted = countingDatabase(db)
    const batched = new PlaylistStore(db)
    const before = counted()
    batched.addTracks(playlistId, tracks, { at: 'end' }, tick())
    const runs = counted() - before

    // The INSERT ... SELECT over `json_each`, plus the `updated_at` touch.
    expect(runs).toBe(2)
    expect(store.get(playlistId)?.trackCount).toBe(5000)
    expect(store.listEntryIds({ playlistId, offset: 4999, limit: 1 }).total).toBe(5000)
  })
})

describe('error shape', () => {
  it('throws the IPC error vocabulary, not bare Errors', () => {
    try {
      store.rename(9999, 'x', tick())
      expect.unreachable('rename of a missing playlist should throw')
    } catch (error) {
      expect(isOscineError(error)).toBe(true)
    }
  })
})

/**
 * Wraps `prepare` so every statement it hands back counts its own executions.
 *
 * Deliberately installed before the store under test prepares anything: the
 * property being asserted is that batch size does not multiply round trips into
 * SQLite, and that is invisible from the outside any other way.
 */
function countingDatabase(target: Database.Database): () => number {
  let runs = 0
  const realPrepare = target.prepare.bind(target)
  ;(target as { prepare: unknown }).prepare = (sql: string) => {
    const statement = realPrepare(sql)
    const realRun = statement.run.bind(statement)
    ;(statement as { run: unknown }).run = (...args: unknown[]) => {
      runs += 1
      return (realRun as (...a: unknown[]) => unknown)(...args)
    }
    return statement
  }
  return () => runs
}

/**
 * Tracks laid out across albums, deliberately inserted out of album order.
 *
 * `albums` is unique on (title, album_artist), which is the case that makes the
 * album id matter: two artists with a "Greatest Hits" share a title, and an
 * ordering that stopped at the title would interleave their tracks and leave
 * `listEntryGroups` describing runs that are not contiguous.
 */
function seedAlbums(): { trackIds: number[]; albumIds: Record<string, number> } {
  const artist = Number(
    db.prepare('INSERT INTO artists (name) VALUES (?)').run('Artist').lastInsertRowid
  )
  const other = Number(
    db.prepare('INSERT INTO artists (name) VALUES (?)').run('Other').lastInsertRowid
  )
  const album = db.prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)')
  const albumIds = {
    // Two "Hits", one per artist — same title, different rows.
    hitsA: Number(album.run('Hits', artist, 1990).lastInsertRowid),
    hitsB: Number(album.run('Hits', other, 1991).lastInsertRowid),
    zebra: Number(album.run('Zebra', artist, 2000).lastInsertRowid)
  }

  const insert = db.prepare(
    `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id, disc_no, track_no)
     VALUES (?, ?, 1, 100, ?, ?, ?, ?, ?)`
  )
  // Inserted zebra-first and with track numbers shuffled, so nothing below can
  // pass by accident on insertion order.
  const rows: Array<[number, number | null, number | null, number | null]> = [
    [albumIds.zebra, 1, 2, null],
    [albumIds.hitsB, 1, 1, null],
    [albumIds.hitsA, 2, 1, null],
    [albumIds.hitsA, 1, 3, null],
    [albumIds.zebra, 1, 1, null],
    [albumIds.hitsA, 1, 1, null]
  ]
  const trackIds = rows.map(([albumId, discNo, trackNo], index) =>
    Number(
      insert.run(rootId, `a${index}.flac`, `Song ${index}`, artist, albumId, discNo, trackNo)
        .lastInsertRowid
    )
  )
  return { trackIds, albumIds }
}

describe('album-major playlist entries', () => {
  it('leaves the stored order alone and serves a different one on request', () => {
    const { trackIds } = seedAlbums()
    const playlistId = newPlaylist()
    store.addTracks(playlistId, trackIds, { at: 'end' }, tick())

    // The playlist is what it was authored as, whatever the pane is showing.
    expect(trackOrder(playlistId)).toEqual(trackIds)

    const byAlbum = store
      .listEntries({ playlistId, offset: 0, limit: 100, order: 'album' })
      .entries.map((entry) => entry.track.id)
    expect(byAlbum).not.toEqual(trackIds)
    expect([...byAlbum].sort()).toEqual([...trackIds].sort())
    expect(positions(playlistId).map((row) => row.id)).toEqual(entryIds(playlistId))
  })

  it('orders by album, then disc, then track — the library ordering exactly', () => {
    const { trackIds, albumIds } = seedAlbums()
    const playlistId = newPlaylist()
    store.addTracks(playlistId, trackIds, { at: 'end' }, tick())

    const rows = store.listEntries({ playlistId, offset: 0, limit: 100, order: 'album' }).entries
    const shape = rows.map((entry) => [entry.track.album, entry.track.discNo, entry.track.trackNo])

    // Both "Hits" albums come before "Zebra", each one contiguous, and within
    // each the discs run before the tracks do.
    expect(shape).toEqual([
      ['Hits', 1, 1],
      ['Hits', 1, 3],
      ['Hits', 2, 1],
      ['Hits', 1, 1],
      ['Zebra', 1, 1],
      ['Zebra', 1, 2]
    ])
    expect(albumIds.hitsA).not.toBe(albumIds.hitsB)
  })

  it('describes runs that account for every entry, duplicates included', () => {
    const { trackIds } = seedAlbums()
    const playlistId = newPlaylist()
    // The first track twice: D12 makes that legal, and a run has to count both.
    store.addTracks(playlistId, [...trackIds, trackIds[0]!], { at: 'end' }, tick())

    const { groups, total } = store.listEntryGroups({ playlistId })
    expect(total).toBe(7)
    expect(groups.reduce((sum, group) => sum + group.trackCount, 0)).toBe(total)
    expect(groups.map((group) => [group.title, group.trackCount])).toEqual([
      ['Hits', 3],
      ['Hits', 1],
      ['Zebra', 3]
    ])
  })

  it('lines the runs up with the rows they head', () => {
    const { trackIds } = seedAlbums()
    const playlistId = newPlaylist()
    store.addTracks(playlistId, trackIds, { at: 'end' }, tick())

    const rows = store.listEntries({ playlistId, offset: 0, limit: 100, order: 'album' }).entries
    const { groups } = store.listEntryGroups({ playlistId })

    // Walk the runs over the rows: each run's slice must be one album, which is
    // the whole contract the header layer's prefix sums rest on.
    let offset = 0
    for (const group of groups) {
      const slice = rows.slice(offset, offset + group.trackCount)
      expect(slice).toHaveLength(group.trackCount)
      expect(new Set(slice.map((entry) => entry.track.album))).toEqual(new Set([group.title]))
      offset += group.trackCount
    }
    expect(offset).toBe(rows.length)
  })

  it('pages the album view consistently, ids and rows alike', () => {
    const { trackIds } = seedAlbums()
    const playlistId = newPlaylist()
    store.addTracks(playlistId, trackIds, { at: 'end' }, tick())

    const whole = store.listEntries({ playlistId, offset: 0, limit: 100, order: 'album' }).entries
    const pageOne = store.listEntries({ playlistId, offset: 0, limit: 3, order: 'album' }).entries
    const pageTwo = store.listEntries({ playlistId, offset: 3, limit: 3, order: 'album' }).entries
    expect([...pageOne, ...pageTwo].map((entry) => entry.id)).toEqual(
      whole.map((entry) => entry.id)
    )

    // A Shift-range resolves through the ids, so they must be the same sequence
    // or the selection is of rows the operator is not looking at.
    const ids = store.listEntryIds({ playlistId, offset: 0, limit: 100, order: 'album' }).ids
    expect(ids).toEqual(whole.map((entry) => entry.id))
  })

  it('defaults to stored position when no order is asked for', () => {
    const { trackIds } = seedAlbums()
    const playlistId = newPlaylist()
    store.addTracks(playlistId, trackIds, { at: 'end' }, tick())

    expect(trackOrder(playlistId)).toEqual(trackIds)
    expect(store.listEntryIds({ playlistId, offset: 0, limit: 100 }).ids).toEqual(
      positions(playlistId).map((row) => row.id)
    )
  })
})
