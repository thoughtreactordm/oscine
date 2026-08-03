import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_FAVORITE_IDS_PAGE,
  MAX_FAVORITE_REMOVE_IDS,
  MAX_FAVORITE_STATE_IDS,
  MAX_FAVORITES_PAGE
} from '@shared/favorites'
import { MAX_TRACK_ID_PAGE, MAX_TRACK_PAGE } from '@shared/library'
import { openDatabase } from '../../../src/main/db'
import { SqliteFavoriteService } from '../../../src/main/favorites/service'
import { LibraryStore } from '../../../src/main/library/store'

/**
 * Favorites — the table, the toggle and the heart on the row (W10-6, D18).
 *
 * Driven through the real migration list against a real SQLite file, like the
 * listen commit's tests and for the same two reasons: the claims are about what
 * is durably in the database, and the load-bearing one — that deleting a track
 * takes its favorite with it — is a `CASCADE` a fake would simply not have.
 */

let dir: string
let file: string
let db: Database.Database

let nextPath = 0

/** One track under a single root. Tags only where a test reads them back. */
function seedTrack(title = 'Tagged Title'): number {
  const rootId =
    (db.prepare('SELECT id FROM roots LIMIT 1').get() as { id: number } | undefined)?.id ??
    Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Music', '/music', 0).lastInsertRowid
    )

  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, duration_ms)
         VALUES (?, ?, 1, 2, ?, 200000)`
      )
      .run(rootId, `t${nextPath++}.flac`, title).lastInsertRowid
  )
}

function favoriteRows(): { track_id: number; favorited_at: number }[] {
  return db.prepare('SELECT * FROM track_favorites ORDER BY track_id').all() as {
    track_id: number
    favorited_at: number
  }[]
}

function service(): SqliteFavoriteService {
  return new SqliteFavoriteService({ db })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-favorites-'))
  file = join(dir, 'library.db')
  db = openDatabase(file).db
  nextPath = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('favorites.toggle', () => {
  it('hearts a track and reports the state that resulted', async () => {
    const trackId = seedTrack()

    const state = await service().toggle(trackId)

    expect(state).toEqual({ trackId, favorite: true, favoritedAt: expect.any(Number) })
    expect(favoriteRows()).toEqual([{ track_id: trackId, favorited_at: state.favoritedAt }])
  })

  it('un-hearts on the second call and deletes the row rather than marking it', async () => {
    const trackId = seedTrack()
    const favorites = service()

    await favorites.toggle(trackId)
    const state = await favorites.toggle(trackId)

    expect(state).toEqual({ trackId, favorite: false, favoritedAt: null })
    // No tombstone. A record of what someone stopped liking is not something
    // this application keeps on their behalf — see migration 015.
    expect(favoriteRows()).toEqual([])
  })

  /**
   * The idempotence that matters: the table holds one row or none whatever the
   * click history, and the returned state always matches what is in it. A
   * `toggle` cannot be idempotent in itself — it flips — so what is asserted is
   * that reaching a state twice leaves the same single row behind it.
   */
  it('leaves at most one row however many times it is toggled', async () => {
    const trackId = seedTrack()
    const favorites = service()

    for (let i = 0; i < 5; i += 1) {
      const state = await favorites.toggle(trackId)
      expect(state.favorite).toBe(i % 2 === 0)
      expect(favoriteRows()).toHaveLength(state.favorite ? 1 : 0)
    }
  })

  it('re-stamps favorited_at when a track is hearted again', async () => {
    const trackId = seedTrack()
    const favorites = service()

    const first = await favorites.toggle(trackId)
    await favorites.toggle(trackId)
    // The rail orders by this column, so a track hearted again today belongs at
    // the top rather than back where it was a year ago.
    await new Promise((resolve) => setTimeout(resolve, 2))
    const third = await favorites.toggle(trackId)

    expect(third.favoritedAt).toBeGreaterThan(first.favoritedAt!)
  })

  it('answers "not favorited" for a track that is not in the library', async () => {
    // Not a throw and not a foreign-key error: the click happened over a row
    // that was on screen, and a track that has since gone is not favorited.
    const state = await service().toggle(9_999)

    expect(state).toEqual({ trackId: 9_999, favorite: false, favoritedAt: null })
    expect(favoriteRows()).toEqual([])
  })
})

describe('favorites.state', () => {
  it('returns the favorited subset of the ids it was given', async () => {
    const hearted = seedTrack()
    const plain = seedTrack()
    const favorites = service()
    await favorites.toggle(hearted)

    const result = await favorites.state([hearted, plain, 9_999])

    expect(result.favoritedIds).toEqual([hearted])
  })

  it('is one query for a batch far larger than any page', async () => {
    const hearted = seedTrack()
    const favorites = service()
    await favorites.toggle(hearted)

    // 10k ids in one request, which is the ceiling the channel accepts. The
    // claim under test is that the store takes them as a single JSON array
    // rather than compiling a statement per distinct length — a per-id round
    // trip here would not finish in a test's patience, let alone a frame's.
    const ids = [hearted, ...Array.from({ length: 9_999 }, (_, i) => 100_000 + i)]
    const result = await favorites.state(ids)

    expect(result.favoritedIds).toEqual([hearted])
  })

  it('collapses a duplicated id rather than answering about it twice', async () => {
    const hearted = seedTrack()
    const favorites = service()
    await favorites.toggle(hearted)

    expect((await favorites.state([hearted, hearted, hearted])).favoritedIds).toEqual([hearted])
  })

  it('takes an empty batch without asking the database anything', async () => {
    expect((await service().state([])).favoritedIds).toEqual([])
  })
})

describe('favorites.list', () => {
  it('pages newest-hearted first', async () => {
    const first = seedTrack('First')
    const second = seedTrack('Second')
    const third = seedTrack('Third')
    const favorites = service()

    for (const id of [first, second, third]) {
      await favorites.toggle(id)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    const page = await favorites.list({ limit: 10, offset: 0 })

    expect(page.total).toBe(3)
    expect(page.tracks.map((track) => track.title)).toEqual(['Third', 'Second', 'First'])
  })

  it('reports the whole count with a window over part of it', async () => {
    const favorites = service()
    for (let i = 0; i < 3; i += 1) await favorites.toggle(seedTrack(`Track ${i}`))

    const page = await favorites.list({ limit: 1, offset: 1 })

    // The count sizes the scrollbar and must not change because a row happened
    // to be off the end of this window.
    expect(page.total).toBe(3)
    expect(page.tracks).toHaveLength(1)
  })

  it('is empty on a library nobody has hearted anything in', async () => {
    seedTrack()
    expect(await service().list({ limit: 10, offset: 0 })).toEqual({ tracks: [], total: 0 })
  })
})

describe('favorites.listIds', () => {
  /**
   * The Shift-range's half of the window, and the claim that matters is that it
   * agrees with `list` **including on ties**. The pane resolves a range through
   * one and draws those rows through the other, so an ordering that agreed only
   * up to the tie-break would select rows the operator did not point at.
   */
  it('answers in exactly the order the display page does', async () => {
    const favorites = service()
    const ids: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const trackId = seedTrack(`Track ${i}`)
      ids.push(trackId)
      await favorites.toggle(trackId)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    const page = await favorites.list({ limit: 10, offset: 0 })
    const idPage = await favorites.listIds({ limit: 10, offset: 0 })

    expect(idPage.total).toBe(5)
    expect(idPage.ids).toEqual(page.tracks.map((track) => track.id))
    expect(idPage.ids).toEqual([...ids].reverse())
  })

  /**
   * Two hearts in the same millisecond needs a keyboard repeat rather than a
   * human, but an unstable `ORDER BY` across a paged read is how a row appears
   * on page two having already been drawn on page one. The tie-break is
   * `track_id DESC` in both statements; this is the assertion that keeps them
   * from drifting apart.
   */
  it('breaks ties the same way `list` does', () => {
    const first = seedTrack('First')
    const second = seedTrack('Second')
    db.prepare(
      'INSERT INTO track_favorites (track_id, favorited_at) VALUES (?, 5000), (?, 5000)'
    ).run(first, second)

    const store = service()
    return Promise.all([
      store.list({ limit: 10, offset: 0 }),
      store.listIds({ limit: 10, offset: 0 })
    ]).then(([page, idPage]) => {
      expect(idPage.ids).toEqual([second, first])
      expect(idPage.ids).toEqual(page.tracks.map((track) => track.id))
    })
  })

  it('reports the whole count with a window over part of it', async () => {
    const favorites = service()
    for (let i = 0; i < 3; i += 1) await favorites.toggle(seedTrack(`Track ${i}`))

    const idPage = await favorites.listIds({ limit: 1, offset: 1 })

    expect(idPage.total).toBe(3)
    expect(idPage.ids).toHaveLength(1)
  })

  it('is empty on a library nobody has hearted anything in', async () => {
    seedTrack()
    expect(await service().listIds({ limit: 10, offset: 0 })).toEqual({ ids: [], total: 0 })
  })
})

describe('favorites.remove', () => {
  it('un-favorites a batch in one call', async () => {
    const favorites = service()
    const ids: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const trackId = seedTrack(`Track ${i}`)
      ids.push(trackId)
      await favorites.toggle(trackId)
    }

    const result = await favorites.remove([ids[0]!, ids[2]!])

    expect(result).toEqual({ removed: 2 })
    expect(favoriteRows().map((row) => row.track_id)).toEqual([ids[1]!, ids[3]!])
  })

  /**
   * Deliberately not a bulk `toggle`. Over a selection, "the opposite of what
   * each row currently holds" would leave the set half hearted and half not
   * depending on where each row started — which is not a gesture anyone makes.
   */
  it('removes rather than flips, whatever state each row was in', async () => {
    const favorites = service()
    const hearted = seedTrack('Hearted')
    const plain = seedTrack('Plain')
    await favorites.toggle(hearted)

    const result = await favorites.remove([hearted, plain])

    // One row deleted, and the un-favorited track is *not* favorited by having
    // been named. A toggle would have hearted it.
    expect(result).toEqual({ removed: 1 })
    expect(favoriteRows()).toEqual([])
  })

  it('is idempotent, and says so in the count', async () => {
    const favorites = service()
    const trackId = seedTrack()
    await favorites.toggle(trackId)

    expect(await favorites.remove([trackId])).toEqual({ removed: 1 })
    expect(await favorites.remove([trackId])).toEqual({ removed: 0 })
    expect(favoriteRows()).toEqual([])
  })

  it('ignores ids that are not tracks, and ids sent twice', async () => {
    const favorites = service()
    const trackId = seedTrack()
    await favorites.toggle(trackId)

    expect(await favorites.remove([trackId, trackId, 999_999])).toEqual({ removed: 1 })
    expect(favoriteRows()).toEqual([])
  })

  it('does nothing at all on an empty batch', async () => {
    const favorites = service()
    await favorites.toggle(seedTrack())

    expect(await favorites.remove([])).toEqual({ removed: 0 })
    expect(favoriteRows()).toHaveLength(1)
  })
})

describe('the CASCADE', () => {
  /**
   * The load-bearing line of migration 015, and the deliberate difference from
   * migration 014's `SET NULL`. A favorite is a statement about a track you can
   * play; one you cannot is a broken row in a pinned playlist.
   */
  it('drops a favorite when its track leaves the library', async () => {
    const trackId = seedTrack()
    await service().toggle(trackId)

    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)

    expect(favoriteRows()).toEqual([])
  })

  it('drops it when the whole root goes, through the tracks it cascades to', async () => {
    const trackId = seedTrack()
    await service().toggle(trackId)

    db.prepare('DELETE FROM roots').run()

    expect(favoriteRows()).toEqual([])
  })
})

describe('the heart on the display row', () => {
  it('rides along with the page rather than needing a second request', async () => {
    const hearted = seedTrack('Hearted')
    const plain = seedTrack('Plain')
    await service().toggle(hearted)

    // Through the library store, because the claim is about `TRACK_PROJECTION`:
    // every list that widens ids into display rows gets `favorite` for free, and
    // that is the whole reason a virtualized row can draw a heart at all.
    const store = new LibraryStore(db)
    const tracks = store.getTracksByIds({ ids: [hearted, plain] })

    expect(tracks.map((track) => [track.title, track.favorite])).toEqual([
      ['Hearted', true],
      ['Plain', false]
    ])
  })
})

describe('the page ceilings', () => {
  /**
   * Both are borrowed from `@shared/library` rather than chosen here. A second
   * number that merely looked similar is one that drifts, and the symptom would
   * be a caller legally holding a range from `listTrackIds` that this endpoint
   * refuses to answer about.
   */
  it('match their neighbours in the library contract', () => {
    expect(MAX_FAVORITE_STATE_IDS).toBe(MAX_TRACK_ID_PAGE)
    expect(MAX_FAVORITES_PAGE).toBe(MAX_TRACK_PAGE)
    expect(MAX_FAVORITE_IDS_PAGE).toBe(MAX_TRACK_ID_PAGE)
    // The removal takes what a resolved selection can hold, so a selection that
    // can legally be *asked about* can legally be removed.
    expect(MAX_FAVORITE_REMOVE_IDS).toBe(MAX_FAVORITE_STATE_IDS)
  })
})
