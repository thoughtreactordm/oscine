import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { normalizeLabel } from '@shared/genre'
import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { createCacheService } from '../../../src/main/cache/service'
import { openDatabase } from '../../../src/main/db'
import { migrate } from '../../../src/main/db/migrate'
import {
  createTagSuggestionService,
  type TagSuggestionService
} from '../../../src/main/musicbrainz/tagSuggestionsService'
import { TagStore } from '../../../src/main/tags/store'
import type { NetClient, NetGetRequest } from '../../../src/main/net'

/**
 * The networked half of the tag pane, and the four things D14 promises it: a
 * fresh entry answers even as the network fails, a stale one beats a failure, a
 * decline is silence rather than an error, and none of it can reach a socket for
 * an artist the app has not identified. The dedup that keeps a suggestion from
 * repeating a tag the track already carries is the fifth.
 */

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'
const DAY_MS = 24 * 60 * 60 * 1000

let dir: string
let file: string
let requests: string[]
let clock: number

/** A client whose answer can change between calls, so a fetch can start working and then stop. */
function mutableClient(): { client: NetClient; setAnswer(answer: unknown | NetFailure): void } {
  let answer: unknown | NetFailure = null
  const isFailure = (value: unknown): value is NetFailure =>
    typeof value === 'object' && value !== null && 'kind' in value && 'message' in value

  const client: NetClient = {
    getText: () => Promise.resolve(netFailed<string>({ kind: 'rejected', message: 'unused' })),
    postJson: () => Promise.resolve(netFailed<never>({ kind: 'rejected', message: 'unused' })),
    getBytes: () => Promise.resolve(netFailed<Uint8Array>({ kind: 'rejected', message: 'unused' })),
    getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      requests.push(request.url)
      return Promise.resolve(isFailure(answer) ? netFailed<T>(answer) : netOk(answer as T))
    }
  }

  return { client, setAnswer: (value) => (answer = value) }
}

/** One `artists` row, optionally already resolved to an MBID. */
function seedArtist(db: Database.Database, name: string, mbid: string | null): number {
  return Number(
    db
      .prepare('INSERT INTO artists (name, mbid, mbid_source) VALUES (?, ?, ?)')
      .run(name, mbid, mbid === null ? null : 'auto').lastInsertRowid
  )
}

/** One track credited to an artist, returning its id. */
function seedTrack(db: Database.Database, artistId: number): number {
  const rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 0).lastInsertRowid
  )
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(rootId, 'a/1.flac', 0, 1, 'Track', artistId, 1000).lastInsertRowid
  )
}

/** A file genre on a track, keyed the way the scanner writes it. */
function seedFileGenre(db: Database.Database, trackId: number, genre: string): void {
  const norm = normalizeLabel(genre)
  if (!norm) return
  db.prepare('INSERT INTO track_genres (track_id, genre_key, genre) VALUES (?, ?, ?)').run(
    trackId,
    norm.key,
    norm.label
  )
}

/** An artist document carrying genres and tags. */
function document(
  genres: Array<{ name: string; count: number }>,
  tags: Array<{ name: string; count: number }> = []
): unknown {
  return { id: MBID, genres, tags }
}

interface Harness {
  db: Database.Database
  tags: TagStore
  service: TagSuggestionService
  setAnswer(answer: unknown | NetFailure): void
  close(): void
}

function harness(): Harness {
  const { db } = openDatabase(file)
  const cacheDb = new Database(':memory:')
  migrate(cacheDb, CACHE_MIGRATIONS)
  const cache = createCacheService({ db: cacheDb, now: () => clock })
  const tags = new TagStore(db)
  const { client, setAnswer } = mutableClient()

  return {
    db,
    tags,
    service: createTagSuggestionService({ db, client, cache, tags }),
    setAnswer,
    close: () => {
      db.close()
      cacheDb.close()
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-test-'))
  file = join(dir, 'library.db')
  requests = []
  clock = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('tag suggestion service', () => {
  it('never asks about a track whose artist it cannot identify', () => {
    // No MBID, no lookup — the same guard the relations pane holds, and for the
    // same reason: nothing can propose one artist's genres for another's track.
    const h = harness()
    h.setAnswer(document([{ name: 'rock', count: 5 }]))
    const trackId = seedTrack(h.db, seedArtist(h.db, 'Local Band', null))

    return h.service.suggest(trackId).then((result) => {
      expect(result).toEqual([])
      expect(requests).toEqual([])
      h.close()
    })
  })

  it('answers a track that has left the library with nothing', async () => {
    const h = harness()
    h.setAnswer(document([{ name: 'rock', count: 5 }]))

    expect(await h.service.suggest(9999)).toEqual([])
    expect(requests).toEqual([])
    h.close()
  })

  it('fetches once and a fresh entry answers even as the network starts failing', async () => {
    // D14's first promise: a fresh cache entry answers without asking, whatever
    // the network is doing by the time of the second call.
    const h = harness()
    h.setAnswer(document([{ name: 'rock', count: 5 }]))
    const trackId = seedTrack(h.db, seedArtist(h.db, 'Nirvana', MBID))

    const first = await h.service.suggest(trackId)
    expect(first.map((tag) => tag.label)).toEqual(['rock'])
    expect(requests).toHaveLength(1)

    h.setAnswer({ kind: 'offline', message: 'No network connection.' })
    const second = await h.service.suggest(trackId)
    expect(second.map((tag) => tag.label)).toEqual(['rock'])
    // No second socket: the fresh entry answered.
    expect(requests).toHaveLength(1)
    h.close()
  })

  it('serves a stale entry rather than a failure', async () => {
    // D14's second promise. The entry is present but past its freshness, and the
    // network is down — a stale answer beats an empty one.
    const h = harness()
    h.setAnswer(document([{ name: 'grunge', count: 7 }]))
    const trackId = seedTrack(h.db, seedArtist(h.db, 'Nirvana', MBID))

    await h.service.suggest(trackId)
    expect(requests).toHaveLength(1)

    clock += 31 * DAY_MS // past the thirty-day fresh window
    h.setAnswer({ kind: 'offline', message: 'No network connection.' })

    const result = await h.service.suggest(trackId)
    expect(result.map((tag) => tag.label)).toEqual(['grunge'])
    // It did reach for the network this time — and fell back to the stale row.
    expect(requests).toHaveLength(2)
    h.close()
  })

  it('is silent when consent is declined, and leaves the local editor working', async () => {
    // D14's third promise, and the card's load-bearing one: suggestions are a
    // decoration, and a decline takes the decoration without touching the editor.
    const h = harness()
    h.setAnswer({ kind: 'declined', message: 'Online features are turned off.' })
    const trackId = seedTrack(h.db, seedArtist(h.db, 'Nirvana', MBID))

    expect(await h.service.suggest(trackId)).toEqual([])

    // The editor beneath it still coins and reads a tag with the network refused.
    h.tags.addTag([trackId], 'Doom', 'user')
    expect(h.tags.tagsForTrack(trackId).user.map((tag) => tag.label)).toEqual(['Doom'])
    h.close()
  })

  it('reads a merged-away identifier as nothing rather than an error', async () => {
    const h = harness()
    h.setAnswer({ kind: 'not-found', message: 'The service has nothing for this.' })
    const trackId = seedTrack(h.db, seedArtist(h.db, 'Nirvana', MBID))

    expect(await h.service.suggest(trackId)).toEqual([])
    h.close()
  })

  it('collapses a suggestion the track already carries, from either vocabulary', async () => {
    // The dedup keyed on the shared casefold: "Rock" on the file and "Doom" as a
    // user tag both cancel the matching suggestion, whatever its capitalisation.
    const h = harness()
    h.setAnswer(
      document(
        [
          { name: 'ROCK', count: 9 },
          { name: 'Sludge', count: 4 }
        ],
        [{ name: 'doom', count: 6 }]
      )
    )
    const trackId = seedTrack(h.db, seedArtist(h.db, 'Nirvana', MBID))
    seedFileGenre(h.db, trackId, 'Rock')
    h.tags.addTag([trackId], 'Doom', 'user')

    const result = await h.service.suggest(trackId)
    expect(result.map((tag) => tag.label)).toEqual(['Sludge'])
    h.close()
  })
})
