import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'
import {
  MAX_TRACK_ID_PAGE,
  TRACK_SORT_COLUMNS,
  type LibraryBrowseFilters,
  type SortDirection
} from '../../../src/shared/library'

/**
 * `listTrackIds` against `listTracks`, row for row.
 *
 * This is the test the whole selection contract rests on. The renderer resolves
 * a Shift-range through the id query and highlights rows from the row query, so
 * if the two ever disagree about which track sits at which offset, a range
 * selection silently selects the wrong tracks — and it does so only past the end
 * of what is loaded, where nobody is looking. Comparing a page here would not
 * catch that: an off-by-one at a nulls-last boundary, or a tiebreaker applied in
 * one query and not the other, shows up thousands of rows in. So the whole list
 * is compared, for every sort column, in both directions.
 *
 * 10,000 rows because that is what W4-4 promises a range selection can cross,
 * and because a fifth of them are deliberately untagged: the tagged/untagged
 * boundary is where the two query shapes are least alike.
 */
const TRACK_COUNT = 10_000
const UNTAGGED_EVERY = 5
const ROW_PAGE = 1_000

let dir: string
let opened: OpenDatabaseResult
let service: SqliteLibraryService
let albumIds: number[]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-track-ids-'))
  opened = openDatabase(join(dir, 'library.db'))
  const { db } = opened

  const rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Synthetic', '/synthetic', 1).lastInsertRowid
  )
  const insertArtist = db.prepare('INSERT INTO artists (name) VALUES (?)')
  const insertAlbum = db.prepare(
    'INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)'
  )
  // Few enough names to be shared by dozens of tracks each. That is the tie the
  // `t.id` tiebreaker exists for: without it, rows with an equal sort key can
  // come back in a different order from the two queries.
  const artistIds = Array.from({ length: 200 }, (_, index) =>
    Number(insertArtist.run(`Artist ${String(index).padStart(3, '0')}`).lastInsertRowid)
  )
  albumIds = Array.from({ length: 250 }, (_, index) =>
    Number(
      insertAlbum.run(`Album ${String(index).padStart(3, '0')}`, null, 1970 + (index % 50))
        .lastInsertRowid
    )
  )
  const insertTrack = db.prepare(
    `INSERT INTO tracks (
       root_id, rel_path, mtime, size, duration_ms, title, artist_id,
       album_id, track_no, disc_no
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  )

  db.transaction(() => {
    for (let index = 0; index < TRACK_COUNT; index++) {
      const untagged = index % UNTAGGED_EVERY === 0
      insertTrack.run(
        rootId,
        `${index}.flac`,
        1_000 + ((index * 7919) % 90_000_000),
        // Repeating durations and track numbers, again to force ties.
        index % 7 === 0 ? null : 45_000 + ((index * 311) % 600) * 1_000,
        `Title ${String((index * 104729) % TRACK_COUNT).padStart(6, '0')}`,
        untagged ? null : artistIds[index % artistIds.length],
        untagged ? null : albumIds[index % albumIds.length],
        untagged ? null : (index % 18) + 1,
        untagged ? null : (index % 3) + 1
      )
    }
  })()

  service = new SqliteLibraryService({
    db,
    pickFolder: async () => null,
    onProgress: () => {}
  })
}, 30_000)

afterAll(async () => {
  await service?.close()
  opened?.db.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** Every id in the list, read the way the renderer reads rows. */
async function idsFromRows(
  sort: (typeof TRACK_SORT_COLUMNS)[number],
  direction: SortDirection,
  filters: LibraryBrowseFilters = {}
): Promise<number[]> {
  const ids: number[] = []
  for (;;) {
    const page = await service.listTracks({
      ...filters,
      sort,
      direction,
      offset: ids.length,
      limit: ROW_PAGE
    })
    ids.push(...page.tracks.map((track) => track.id))
    if (page.tracks.length < ROW_PAGE || ids.length >= page.total) return ids
  }
}

describe('listTrackIds', () => {
  it.each(
    TRACK_SORT_COLUMNS.flatMap((sort) =>
      (['asc', 'desc'] as const).map((direction) => ({ sort, direction }))
    )
  )(
    'agrees with listTracks for every row, sorted by $sort $direction',
    async ({ sort, direction }) => {
      const fromRows = await idsFromRows(sort, direction)
      expect(fromRows).toHaveLength(TRACK_COUNT)

      // The whole list in one id request — an order of magnitude more rows than
      // the row query will serve at once, which is the point of the channel.
      const fromIds = await service.listTrackIds({
        sort,
        direction,
        offset: 0,
        limit: MAX_TRACK_ID_PAGE
      })

      expect(fromIds.total).toBe(TRACK_COUNT)
      expect(fromIds.ids).toEqual(fromRows)
    },
    30_000
  )

  it.each([
    { label: 'an album filter', filters: () => ({ albumId: albumIds[3]! }) },
    { label: 'a search', filters: () => ({ searchText: 'Title 00' }) },
    { label: 'both', filters: () => ({ albumId: albumIds[3]!, searchText: 'Title' }) }
  ])('agrees with listTracks under $label', async ({ filters }) => {
    const applied = filters()
    const fromRows = await idsFromRows('title', 'desc', applied)
    expect(fromRows.length).toBeGreaterThan(0)

    const fromIds = await service.listTrackIds({
      ...applied,
      sort: 'title',
      direction: 'desc',
      offset: 0,
      limit: MAX_TRACK_ID_PAGE
    })

    expect(fromIds.total).toBe(fromRows.length)
    expect(fromIds.ids).toEqual(fromRows)
  })

  it('windows the same way the row query does', async () => {
    // Offsets around the tagged/untagged boundary, where the joined-sort shape
    // switches from the dimension index to the id-ordered tail.
    const tagged = TRACK_COUNT - TRACK_COUNT / UNTAGGED_EVERY
    for (const offset of [0, 1, tagged - 3, tagged, tagged + 1, TRACK_COUNT - 2]) {
      const rows = await service.listTracks({ sort: 'artist', direction: 'asc', offset, limit: 5 })
      const ids = await service.listTrackIds({ sort: 'artist', direction: 'asc', offset, limit: 5 })
      expect(ids.ids).toEqual(rows.tracks.map((track) => track.id))
    }
  })

  it('runs off the end of the list without complaint', async () => {
    const result = await service.listTrackIds({
      sort: 'title',
      direction: 'asc',
      offset: TRACK_COUNT + 500,
      limit: 100
    })
    expect(result.ids).toEqual([])
    expect(result.total).toBe(TRACK_COUNT)
  })
})

/**
 * What the album column is actually for.
 *
 * The agreement tests above would pass just as happily if both query shapes
 * were wrong in the same way, and for a while they were: `album` ordered on
 * `al.title` alone and left `t.id` — scan order, i.e. the directory listing —
 * to decide what followed what inside an album. A discography came out
 * alphabetised by song title. These pin the ordering itself rather than the
 * agreement, and both fail against that earlier clause.
 */
describe('album ordering', () => {
  /** `[album, disc, track]` for the tagged head of the list, in returned order. */
  async function taggedTuples(direction: SortDirection): Promise<Array<[string, number, number]>> {
    const ids: Array<[string, number, number]> = []
    for (let offset = 0; offset < TRACK_COUNT; offset += ROW_PAGE) {
      const page = await service.listTracks({
        sort: 'album',
        direction,
        offset,
        limit: ROW_PAGE
      })
      for (const track of page.tracks) {
        if (track.album === null) continue
        ids.push([track.album, track.discNo ?? 1, track.trackNo ?? 0])
      }
    }
    return ids
  }

  it('reads each album in disc and track order, ascending', async () => {
    const tuples = await taggedTuples('asc')
    expect(tuples.length).toBeGreaterThan(1_000)

    for (let index = 1; index < tuples.length; index++) {
      const [prevAlbum, prevDisc, prevTrack] = tuples[index - 1]!
      const [album, disc, track] = tuples[index]!
      if (album !== prevAlbum) {
        expect(album.localeCompare(prevAlbum)).toBeGreaterThan(0)
        continue
      }
      if (disc === prevDisc) expect(track).toBeGreaterThanOrEqual(prevTrack)
      else expect(disc).toBeGreaterThan(prevDisc)
    }
  }, 30_000)

  it('reverses the albums without playing each one backwards', async () => {
    const tuples = await taggedTuples('desc')
    expect(tuples.length).toBeGreaterThan(1_000)

    for (let index = 1; index < tuples.length; index++) {
      const [prevAlbum, prevDisc, prevTrack] = tuples[index - 1]!
      const [album, disc, track] = tuples[index]!
      if (album !== prevAlbum) {
        // Albums descend...
        expect(album.localeCompare(prevAlbum)).toBeLessThan(0)
        continue
      }
      // ...while the tracks inside one still ascend.
      if (disc === prevDisc) expect(track).toBeGreaterThanOrEqual(prevTrack)
      else expect(disc).toBeGreaterThan(prevDisc)
    }
  }, 30_000)
})

describe('orderTrackIds', () => {
  it('puts an arbitrary id set into list order, in both directions', async () => {
    const ascending = await idsFromRows('artist', 'asc')

    // A scattered subset, handed over in an order unrelated to the list's — the
    // shape a `Set` of ids arrives in.
    const offsets = [8, 4_400, 17, 9_998, 2_501, 640]
    const picked = offsets.map((offset) => ascending[offset]!)

    const expectedAsc = [...offsets].sort((a, b) => a - b).map((offset) => ascending[offset]!)
    expect(await service.orderTrackIds({ sort: 'artist', direction: 'asc', ids: picked })).toEqual(
      expectedAsc
    )

    const descending = await idsFromRows('artist', 'desc')
    const expectedDesc = descending.filter((id) => picked.includes(id))
    expect(await service.orderTrackIds({ sort: 'artist', direction: 'desc', ids: picked })).toEqual(
      expectedDesc
    )
  })

  it('orders a selection the same way for every sort column', async () => {
    const reference = await idsFromRows('title', 'asc')
    const picked = [12, 900, 4_001, 7_777].map((offset) => reference[offset]!)

    for (const sort of TRACK_SORT_COLUMNS) {
      const full = await idsFromRows(sort, 'asc')
      const expected = full.filter((id) => picked.includes(id))
      expect(await service.orderTrackIds({ sort, direction: 'asc', ids: picked })).toEqual(expected)
    }
  }, 30_000)

  it('ignores browse filters, so a selection outlives the search that made it', async () => {
    const inAlbum = await idsFromRows('title', 'asc', { albumId: albumIds[3]! })
    const others = (await idsFromRows('title', 'asc')).filter((id) => !inAlbum.includes(id))
    const mixed = [inAlbum[0]!, others[0]!, inAlbum[1]!]

    // Every id comes back, including the ones the album filter would have hidden.
    const ordered = await service.orderTrackIds({ sort: 'title', direction: 'asc', ids: mixed })
    expect(new Set(ordered)).toEqual(new Set(mixed))
    expect(ordered).toHaveLength(3)
  })

  it('drops ids that are no longer in the library and collapses duplicates', async () => {
    const known = (
      await service.listTrackIds({ sort: 'title', direction: 'asc', offset: 0, limit: 3 })
    ).ids

    const ordered = await service.orderTrackIds({
      sort: 'title',
      direction: 'asc',
      ids: [...known, ...known, 999_999_999]
    })

    expect(ordered).toEqual(known)
  })

  it('has nothing to order for an empty selection', async () => {
    expect(await service.orderTrackIds({ sort: 'title', direction: 'asc', ids: [] })).toEqual([])
  })
})
