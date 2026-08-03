import { splitGenres } from '@shared/genre'
import type { Migration } from '../migrate'

/**
 * Genre normalization: the join table grouping can actually group on.
 *
 * `tracks.genre` (migration 010) is a free `TEXT` column holding whatever the
 * tagger wrote. `Rock`, `rock` and `Rock; Alternative` are three distinct values
 * to a `GROUP BY`, so a genre histogram over that column tells the operator more
 * about their taggers than about their library. This table gives each genre an
 * identity, and W10's listening statistics group on it.
 *
 * ## Derived, never authored
 *
 * Nothing outside the scanner writes these rows. `LibraryStore.writeTrack`
 * rebuilds a track's genres — delete then insert — in the same transaction that
 * upserts the track, so the operator-facing Rescan repopulates the whole library
 * with no new gesture. That is the property migration 010 already leans on: a
 * rescan is a full re-parse, so the one action an operator already knows about
 * is the one that fixes genre.
 *
 * Unlike 010, this migration does not wait for that rescan. Its input is a
 * column the database already has rather than a tag only the file has, so the
 * backfill below is a single pass that leaves `track_genres` correct — as
 * correct as `tracks.genre` is — the moment the app opens.
 *
 * What it inherits from `tracks.genre` is that column's own loss: `primaryGenre`
 * keeps only the *first* value of a multi-valued tag, so a file tagged with two
 * separate `GENRE` frames contributes one of them here. Splitting a `Rock; Pop`
 * string recovers the common case; the frame that was dropped at scan time is
 * not this table's to recover, and changing that means changing what the
 * neighbourhood strand's indexed equality reads.
 *
 * ## The shape
 *
 * `genre_key` is the grouping identity — casefolded, trimmed, whitespace
 * collapsed. `genre` is the display spelling. Both, rather than a `genres`
 * dimension table with an id, because the key *is* the identity: an integer
 * surrogate would buy a join on every read and save nothing, since no other
 * table refers to a genre and the strings are short and few.
 *
 * `genre` is a property of the *row*, not of the key: the primary key is
 * `(track_id, genre_key)`, so a library holding both `IDM` and `idm` keeps both
 * spellings, one per track. Grouping is still exact — that is `genre_key`'s
 * whole job — but anything that renders a group has to choose a spelling
 * (`MIN(genre)` is the cheap deterministic answer) rather than assume the column
 * is single-valued per key. Making it single-valued would mean a genres
 * dimension table and a rewrite of every other track's row the first time a
 * spelling changed, for a display detail an alias map will own properly.
 *
 * `WITHOUT ROWID` because the primary key is the whole row bar one column, so an
 * implicit rowid would be a second copy of the key in a second b-tree.
 *
 * `idx_track_genres_key` leads with `genre_key` and carries `track_id`, which
 * makes the histogram — group by key, count tracks — an index-only scan. The
 * primary key already serves the other direction, "what are this track's
 * genres".
 *
 * ## The separator cost, which is accepted
 *
 * The splitter treats `/` as a separator, so `Rock/Pop` becomes two genres and
 * so does every genre legitimately spelled with a slash. Splitting is right far
 * more often than not; the answer to the remainder is an operator alias map,
 * which is deliberately a later card. See `@shared/genre` for the rest of the
 * rules and why each one is what it is.
 */
export const trackGenres: Migration = {
  version: 13,
  name: 'track-genres',
  sql: `
CREATE TABLE track_genres (
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre_key TEXT    NOT NULL,   -- casefolded, trimmed: the grouping identity
  genre     TEXT    NOT NULL,   -- canonical display spelling for that key
  PRIMARY KEY (track_id, genre_key)
) WITHOUT ROWID;

CREATE INDEX idx_track_genres_key ON track_genres(genre_key, track_id);
`,
  backfill: (db) => {
    const insert = db.prepare(
      'INSERT INTO track_genres (track_id, genre_key, genre) VALUES (?, ?, ?)'
    )

    // Read in full rather than streamed: better-sqlite3 refuses a write on a
    // connection with an open cursor, so an `iterate()` here would have to
    // buffer anyway. Two short strings per tagged track at the 100k-track scale
    // target is a few megabytes, once, on the launch that upgrades.
    const rows = db
      .prepare("SELECT id, genre FROM tracks WHERE genre IS NOT NULL AND genre <> ''")
      .all() as { id: number; genre: string }[]

    for (const row of rows) {
      for (const { key, genre } of splitGenres(row.genre)) insert.run(row.id, key, genre)
    }
  }
}
