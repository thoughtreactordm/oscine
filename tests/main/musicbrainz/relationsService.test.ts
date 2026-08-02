import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ARTIST_RELATION_LIMIT } from '@shared/artistRelations'
import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { createCacheService, type CacheService } from '../../../src/main/cache/service'
import { openDatabase } from '../../../src/main/db'
import { migrate } from '../../../src/main/db/migrate'
import { createLibraryArtistLookup } from '../../../src/main/musicbrainz/libraryArtists'
import type { ParsedRelation } from '../../../src/main/musicbrainz/relations'
import {
  createArtistRelationsService,
  intersectRelations,
  type ArtistRelationsService
} from '../../../src/main/musicbrainz/relationsService'
import type { NetClient, NetGetRequest } from '../../../src/main/net'

/**
 * The join, which is the whole card, and the two ways it can lie.
 *
 * The pane's proposition is "you already own this artist". It can be wrong in
 * two directions and only one of them is harmless: failing to notice an artist
 * you own costs a discovery, while claiming you own one you do not is R5's
 * confident-and-wrong failure applied to the library itself. So most of what is
 * asserted here is about the second — the name fallback, its guard rail, and the
 * fact that an unresolved artist never reaches a socket at all.
 */

const NIRVANA = '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6'
const KURT = '956e0a4c-1a58-4bcb-9c8b-8a0d0f7b0b0c'
const DAVE = 'd2b3fbdc-2f6f-4d24-9d2a-f6f0a2d0f0a1'
const KRIST = 'ab1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'

let dir: string
let file: string
let requests: string[]

function relation(overrides: Partial<ParsedRelation> = {}): ParsedRelation {
  return {
    kind: 'member',
    type: 'member of band',
    mbid: KURT,
    name: 'Kurt Cobain',
    disambiguation: null,
    attributes: [],
    begin: null,
    end: null,
    ended: false,
    ...overrides
  }
}

function stubClient(answer: unknown | NetFailure): NetClient {
  const failed =
    typeof answer === 'object' && answer !== null && 'kind' in answer && 'message' in answer

  return {
    getText: () => Promise.resolve(netFailed<string>({ kind: 'rejected', message: 'unused' })),
    getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      requests.push(request.url)
      return Promise.resolve(failed ? netFailed<T>(answer as NetFailure) : netOk(answer as T))
    }
  }
}

/** The one library root every seeded track hangs off. */
function rootOf(db: Database.Database): number {
  const existing = db.prepare('SELECT id FROM roots WHERE path = ?').get('/music') as
    { id: number } | undefined
  if (existing) return existing.id

  return Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 0).lastInsertRowid
  )
}

/** One `artists` row, and optionally some tracks credited to it. */
function seedArtist(
  db: Database.Database,
  name: string,
  { mbid = null, tracks = 0 }: { mbid?: string | null; tracks?: number } = {}
): number {
  const artistId = Number(
    db
      .prepare('INSERT INTO artists (name, mbid, mbid_source) VALUES (?, ?, ?)')
      .run(name, mbid, mbid === null ? null : 'auto').lastInsertRowid
  )

  if (tracks > 0) {
    const rootId = rootOf(db)
    for (let index = 0; index < tracks; index++) {
      db.prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(rootId, `${name}/${index}.flac`, 0, 1, `Track ${index}`, artistId, 1000)
    }
  }

  return artistId
}

interface Harness {
  db: Database.Database
  service: ArtistRelationsService
  cache: CacheService
  close(): void
}

function harness(answer: unknown | NetFailure): Harness {
  const { db } = openDatabase(file)
  const cacheDb = new Database(':memory:')
  migrate(cacheDb, CACHE_MIGRATIONS)
  const cache = createCacheService({ db: cacheDb })

  return {
    db,
    cache,
    service: createArtistRelationsService({ db, client: stubClient(answer), cache }),
    close: () => {
      db.close()
      cacheDb.close()
    }
  }
}

/** A MusicBrainz artist document carrying one membership. */
function document(name = 'Kurt Cobain', mbid = KURT): unknown {
  return {
    id: NIRVANA,
    relations: [
      {
        type: 'member of band',
        direction: 'backward',
        'target-type': 'artist',
        artist: { id: mbid, name },
        attributes: ['guitar'],
        ended: false
      }
    ]
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-test-'))
  file = join(dir, 'library.db')
  requests = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('artist relations service', () => {
  it('never asks about an artist it cannot identify', async () => {
    // The card's third acceptance criterion, stated where it is enforced: an
    // unresolved artist is answered before anything is fetched, so there is no
    // path by which somebody else's band reaches the deck.
    const h = harness(document())
    const artistId = seedArtist(h.db, 'Nirvana')

    const result = await h.service.get(artistId)

    expect(result.status).toBe('none')
    expect(result.relations).toEqual([])
    expect(requests).toEqual([])
    h.close()
  })

  it('answers an artist that has left the library with an empty state', async () => {
    const h = harness(document())

    const result = await h.service.get(9999)

    expect(result.status).toBe('none')
    expect(requests).toEqual([])
    h.close()
  })

  it('fetches once and answers the second call from the cache', async () => {
    const h = harness(document())
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    await h.service.get(artistId)
    await h.service.get(artistId)

    expect(requests).toHaveLength(1)
    h.close()
  })

  it('recomputes ownership on every call, cached document or not', async () => {
    // The half that is deliberately not cached. Relations move on a scale of
    // months; ownership moves whenever a folder is scanned, and a joined result
    // in the cache would be stale the minute after the next import.
    const h = harness(document())
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const before = await h.service.get(artistId)
    expect(before.relations[0]?.match).toBeNull()

    seedArtist(h.db, 'Kurt Cobain', { tracks: 3 })

    const after = await h.service.get(artistId)
    expect(requests).toHaveLength(1)
    expect(after.relations[0]?.match).toMatchObject({ trackCount: 3, basis: 'name' })
    h.close()
  })

  it('reads a merged-away identifier as an empty state rather than a failure', async () => {
    const h = harness({ kind: 'not-found', message: 'The service has nothing for this.' })
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const result = await h.service.get(artistId)

    expect(result.status).toBe('none')
    expect(result.failure).toBeNull()
    h.close()
  })

  it('reports an unreachable service as a failure worth retrying', async () => {
    const h = harness({ kind: 'offline', message: 'No network connection.' })
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const result = await h.service.get(artistId)

    expect(result.status).toBe('unavailable')
    expect(result.failure?.kind).toBe('offline')
    h.close()
  })

  it('answers an artist MusicBrainz records no connections for with an empty state', async () => {
    const h = harness({ id: NIRVANA, relations: [] })
    const artistId = seedArtist(h.db, 'Nirvana', { mbid: NIRVANA })

    const result = await h.service.get(artistId)

    expect(result.status).toBe('none')
    expect(result.failure).toBeNull()
    h.close()
  })
})

describe('the library intersection', () => {
  it('joins on the identifier when the library has one', () => {
    const { db } = openDatabase(file)
    // Deliberately spelled differently: the identifier is the join, and a name
    // that does not match must not be able to break it.
    const owned = seedArtist(db, 'Kurt Donald Cobain', { mbid: KURT, tracks: 2 })

    const result = intersectRelations(1, [relation()], createLibraryArtistLookup(db))

    expect(result.relations[0]?.match).toMatchObject({
      artistId: owned,
      name: 'Kurt Donald Cobain',
      trackCount: 2,
      basis: 'mbid'
    })
    db.close()
  })

  it('falls back to the name, and says that is what it did', () => {
    const { db } = openDatabase(file)
    // The ordinary case: the library's artists carry no MBID until the deck has
    // looked each of them up, so a strict identity join would report an empty
    // pane for a library that has never had the deck opened on it.
    const owned = seedArtist(db, 'Guns N Roses', { tracks: 5 })

    const result = intersectRelations(
      1,
      [relation({ mbid: DAVE, name: "Guns N' Roses" })],
      createLibraryArtistLookup(db)
    )

    expect(result.relations[0]?.match).toMatchObject({ artistId: owned, basis: 'name' })
    db.close()
  })

  it('refuses a name match to an artist the library knows is somebody else', () => {
    // The guard rail, and the reason the fallback is safe to ship. Eleven
    // artists are called Nirvana; resolving one of them must not make the deck
    // claim you own the other ten.
    const { db } = openDatabase(file)
    seedArtist(db, 'Nirvana', { mbid: NIRVANA, tracks: 4 })

    const result = intersectRelations(
      1,
      [relation({ mbid: KRIST, name: 'Nirvana' })],
      createLibraryArtistLookup(db)
    )

    expect(result.relations[0]?.match).toBeNull()
    db.close()
  })

  it('matches across punctuation and diacritics', () => {
    const { db } = openDatabase(file)
    const owned = seedArtist(db, 'Bjork', { tracks: 1 })

    const result = intersectRelations(
      1,
      [relation({ mbid: DAVE, name: 'Björk' })],
      createLibraryArtistLookup(db)
    )

    expect(result.relations[0]?.match?.artistId).toBe(owned)
    db.close()
  })

  it('notices artists added since the last lookup', () => {
    // The name index is memoised behind a fingerprint. An artist added by a
    // scan has to invalidate it, or the pane would keep reporting the library
    // as it stood when the deck was opened.
    const { db } = openDatabase(file)
    const lookup = createLibraryArtistLookup(db)

    expect(intersectRelations(1, [relation()], lookup).relations[0]?.match).toBeNull()

    const owned = seedArtist(db, 'Kurt Cobain', { tracks: 1 })

    expect(intersectRelations(1, [relation()], lookup).relations[0]?.match?.artistId).toBe(owned)
    db.close()
  })

  it('sorts by kind, then tense, then ownership, then name', () => {
    const { db } = openDatabase(file)
    seedArtist(db, 'Krist Novoselic', { tracks: 1 })

    const result = intersectRelations(
      1,
      [
        relation({ kind: 'alias', mbid: DAVE, name: 'Aardvark' }),
        relation({ kind: 'member', mbid: NIRVANA, name: 'Zeb', ended: true }),
        relation({ kind: 'member', mbid: KURT, name: 'Wendy' }),
        relation({ kind: 'member', mbid: KRIST, name: 'Krist Novoselic' })
      ],
      createLibraryArtistLookup(db)
    )

    expect(result.relations.map((entry) => entry.name)).toEqual([
      // Owned first inside the current members, then the unowned one, then the
      // former member, and the kind furthest from a line-up last.
      'Krist Novoselic',
      'Wendy',
      'Zeb',
      'Aardvark'
    ])
    db.close()
  })

  it('caps the list without dropping an artist the library holds', () => {
    // The cap is applied after the sort precisely so this is true: the rows a
    // truncation drops are the unowned, alphabetically-late ones, and never the
    // row the operator opened the pane to find.
    const { db } = openDatabase(file)
    const owned = seedArtist(db, 'Zzz Last', { tracks: 1 })

    const relations: ParsedRelation[] = [{ ...relation({ mbid: KRIST, name: 'Zzz Last' }) }]
    for (let index = 0; index < ARTIST_RELATION_LIMIT + 10; index++) {
      relations.push(
        relation({
          mbid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          name: `A${index}`
        })
      )
    }

    const result = intersectRelations(1, relations, createLibraryArtistLookup(db))

    expect(result.truncated).toBe(true)
    expect(result.relations).toHaveLength(ARTIST_RELATION_LIMIT)
    expect(result.relations[0]?.match?.artistId).toBe(owned)
    db.close()
  })
})
