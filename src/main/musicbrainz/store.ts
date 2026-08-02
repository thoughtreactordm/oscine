/**
 * The `artists` row's identity columns, read and written.
 *
 * A thin layer, and the thinness is the point: there is exactly one rule in this
 * file that matters, and it is expressed as a `WHERE` clause rather than as a
 * method that callers have to remember to call.
 */

import type { ArtistMbidSource } from '@shared/artist'
import type Database from 'better-sqlite3'

/** What the row says about who this artist is. */
export interface StoredIdentity {
  artistId: number
  /** The library's tag string. */
  name: string
  mbid: string | null
  source: ArtistMbidSource | null
}

interface IdentityRow {
  artistId: number
  name: string
  mbid: string | null
  source: string | null
}

function toIdentity(row: IdentityRow): StoredIdentity {
  // A source that is neither value is a row written by a future build, or by
  // hand. Reading it as `null` means the automatic matcher is free to overwrite
  // it — which is the safe direction, because the alternative is an artist
  // frozen at an identity nothing in this build can explain or clear.
  const source = row.source === 'auto' || row.source === 'manual' ? row.source : null
  return { artistId: row.artistId, name: row.name, mbid: row.mbid, source }
}

export interface ArtistIdentityStore {
  /** The artist credited on a track, or `null` if the track or the credit is gone. */
  forTrack(trackId: number): StoredIdentity | null
  byId(artistId: number): StoredIdentity | null
  /**
   * Records an automatic match. Refuses to touch a row the operator has decided.
   * Returns whether it wrote.
   */
  promote(artistId: number, mbid: string): boolean
  /** Records the operator's choice. `null` is "none of these", and is a decision. */
  setManual(artistId: number, mbid: string | null): void
  /** Drops the correction entirely, so automatic matching resumes. */
  clear(artistId: number): void
}

export function createArtistIdentityStore(db: Database.Database): ArtistIdentityStore {
  const selectByTrack = db.prepare<[number]>(`
    SELECT a.id AS artistId, a.name AS name, a.mbid AS mbid, a.mbid_source AS source
      FROM tracks t
      JOIN artists a ON a.id = t.artist_id
     WHERE t.id = ?
  `)

  const selectById = db.prepare<[number]>(`
    SELECT id AS artistId, name AS name, mbid AS mbid, mbid_source AS source
      FROM artists
     WHERE id = ?
  `)

  /**
   * The one rule, and it lives here rather than in a service method.
   *
   * The acceptance criterion is that an operator correction "is never silently
   * overwritten by a later automatic match". A guard in the caller satisfies
   * that until somebody adds a second caller; a guard in the statement satisfies
   * it for every caller there will ever be. `changes` then tells the service
   * whether it wrote, without a second read.
   */
  const promoteAuto = db.prepare<[string, number]>(`
    UPDATE artists
       SET mbid = ?, mbid_source = 'auto'
     WHERE id = ?
       AND (mbid_source IS NULL OR mbid_source = 'auto')
  `)

  const setManual = db.prepare<[string | null, number]>(`
    UPDATE artists SET mbid = ?, mbid_source = 'manual' WHERE id = ?
  `)

  const clearMbid = db.prepare<[number]>(`
    UPDATE artists SET mbid = NULL, mbid_source = NULL WHERE id = ?
  `)

  return {
    forTrack(trackId): StoredIdentity | null {
      const row = selectByTrack.get(trackId) as IdentityRow | undefined
      return row ? toIdentity(row) : null
    },

    byId(artistId): StoredIdentity | null {
      const row = selectById.get(artistId) as IdentityRow | undefined
      return row ? toIdentity(row) : null
    },

    promote(artistId, mbid): boolean {
      return promoteAuto.run(mbid, artistId).changes > 0
    },

    setManual(artistId, mbid): void {
      setManual.run(mbid, artistId)
    },

    clear(artistId): void {
      clearMbid.run(artistId)
    }
  }
}
