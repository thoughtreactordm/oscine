/**
 * The other half of the intersection: which of these artists the library holds.
 *
 * ## Two joins, and one of them is a guess
 *
 * By MBID where both sides have one, because that is an identity match and is
 * as certain as anything here gets. By comparison key otherwise, because the
 * library's artists are mostly *unresolved* — an MBID lands on an `artists` row
 * only once the deck has looked that artist up, so a strict identity join would
 * report "you own nothing by any of these" for a library that has never had the
 * deck opened on it. The name fallback is what makes the pane useful on day one,
 * and `ArtistMatchBasis` is what stops it being dishonest about that.
 *
 * The guess has one guard rail, and it matters: a library artist carrying an
 * MBID that is *not* the one on the relation is a known-different artist, and a
 * name match to it is refused. That is the "eleven artists called Nirvana" case
 * arriving from the other direction — without it, resolving one Nirvana would
 * make the deck confidently claim you own the other ten.
 *
 * ## Why the name index is memoised
 *
 * `compareKey` is NFKD plus four regexes, and SQLite cannot compute it — so a
 * name join means reading every artist row into JavaScript. At the 100k-track
 * scale target that is tens of thousands of rows, which is tens of milliseconds,
 * and it would otherwise run on every track change while the deck is open.
 *
 * The index is therefore rebuilt only when the artist rows have actually moved,
 * detected by counting them and taking the highest id. That is exact for this
 * table rather than merely cheap: `artists.name` is `UNIQUE`, so a renamed
 * artist is a new row with a new id, and a removed one changes the count. Track
 * counts are deliberately *not* in the index — they move without the artist rows
 * moving, so they are read live, per lookup, for the handful of ids that matched.
 */

import type { ArtistMatchBasis } from '@shared/artistRelations'
import type Database from 'better-sqlite3'
import { compareKey } from './artistName'

/** The library's row for a matched artist, as the relations pane needs it. */
export interface LibraryArtistRow {
  artistId: number
  /** The library's spelling, which is frequently not MusicBrainz's. */
  name: string
  trackCount: number
  /** What the row already believes about its own identity, if anything. */
  mbid: string | null
}

/** A row, and how it was joined. The basis travels with the match; see the type. */
export interface MatchedLibraryArtist extends LibraryArtistRow {
  basis: ArtistMatchBasis
}

/** One artist to look for: MusicBrainz's identifier and MusicBrainz's name. */
export interface ArtistLookupKey {
  mbid: string
  name: string
}

export interface LibraryArtistLookup {
  /**
   * Resolves a batch of artists against the library.
   *
   * A batch rather than one call per artist because a band's relations are
   * forty rows and forty round trips through SQLite to draw one pane is the
   * shape of query this codebase virtualizes lists to avoid.
   *
   * The returned map is keyed by MBID and holds only the artists that matched.
   */
  match(keys: readonly ArtistLookupKey[]): Map<string, MatchedLibraryArtist>
}

interface NameIndexRow {
  id: number
  name: string
}

interface FingerprintRow {
  count: number
  maxId: number
}

export function createLibraryArtistLookup(db: Database.Database): LibraryArtistLookup {
  /**
   * Have the artist rows moved since the index was built?
   *
   * Two integers from one aggregate, which SQLite answers from the primary key
   * without touching the table. See the note at the top for why this is exact
   * and not just cheap.
   */
  const selectFingerprint = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM artists
  `)

  /**
   * `ORDER BY id`, so that a comparison-key collision resolves the same way
   * every time.
   *
   * Two library artists can fold to one key — "The Beatles" and "Beatles" are
   * separate rows under a `UNIQUE(name)` and the same key under `compareKey` —
   * and something has to lose. The lower id wins, which is arbitrary but stable:
   * a match that changed between two runs of the same query would be worse than
   * either answer, because it is the one the operator cannot reason about.
   */
  const selectNames = db.prepare(`SELECT id, name FROM artists ORDER BY id`)

  let index: Map<string, number> | null = null
  let indexedCount = -1
  let indexedMaxId = -1

  function nameIndex(): Map<string, number> {
    const fingerprint = selectFingerprint.get() as FingerprintRow
    if (
      index !== null &&
      fingerprint.count === indexedCount &&
      fingerprint.maxId === indexedMaxId
    ) {
      return index
    }

    const built = new Map<string, number>()
    for (const row of selectNames.all() as NameIndexRow[]) {
      const key = compareKey(row.name)
      if (key === '' || built.has(key)) continue
      built.set(key, row.id)
    }

    index = built
    indexedCount = fingerprint.count
    indexedMaxId = fingerprint.maxId
    return built
  }

  /**
   * The live half: names, identifiers and track counts for the ids that matched.
   *
   * A `LEFT JOIN` rather than an inner one so an artist whose last track was
   * removed still reports as a row with zero tracks instead of vanishing —
   * which is the honest answer, and lets the pane say "you had this" rather than
   * flipping a relation between owned and unowned as a rescan runs.
   *
   * Built per call rather than prepared once, because the placeholder count is
   * the batch size. `better-sqlite3` caches prepared statements internally, so
   * the handful of distinct batch sizes a deck produces are prepared once each.
   */
  function rowsById(ids: readonly number[]): Map<number, LibraryArtistRow> {
    const found = new Map<number, LibraryArtistRow>()
    if (ids.length === 0) return found

    const statement = db.prepare(`
      SELECT a.id AS artistId, a.name AS name, a.mbid AS mbid, COUNT(t.id) AS trackCount
        FROM artists a
        LEFT JOIN tracks t ON t.artist_id = a.id
       WHERE a.id IN (${ids.map(() => '?').join(', ')})
       GROUP BY a.id
    `)

    for (const row of statement.all(...ids) as LibraryArtistRow[]) {
      found.set(row.artistId, row)
    }
    return found
  }

  const selectByMbid = db.prepare<[string]>(`SELECT id FROM artists WHERE mbid = ?`)

  return {
    match(keys): Map<string, MatchedLibraryArtist> {
      const matched = new Map<string, MatchedLibraryArtist>()
      if (keys.length === 0) return matched

      // Identity first, and only then the guess. Resolved with the index built
      // at most once for the whole batch.
      const byMbid = new Map<string, number>()
      const byName = new Map<string, number>()

      let names: Map<string, number> | null = null
      for (const key of keys) {
        const identified = selectByMbid.get(key.mbid) as { id: number } | undefined
        if (identified) {
          byMbid.set(key.mbid, identified.id)
          continue
        }

        names ??= nameIndex()
        const candidate = names.get(compareKey(key.name))
        if (candidate !== undefined) byName.set(key.mbid, candidate)
      }

      const rows = rowsById([...new Set([...byMbid.values(), ...byName.values()])])

      for (const [mbid, artistId] of byMbid) {
        const row = rows.get(artistId)
        if (row) matched.set(mbid, { ...row, basis: 'mbid' })
      }

      for (const [mbid, artistId] of byName) {
        const row = rows.get(artistId)
        if (!row) continue
        // The guard rail. A library artist that already knows it is somebody
        // else is not this artist, whatever the two names fold to.
        if (row.mbid !== null && row.mbid !== mbid) continue
        matched.set(mbid, { ...row, basis: 'name' })
      }

      return matched
    }
  }
}
