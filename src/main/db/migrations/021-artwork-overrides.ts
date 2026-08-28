import type { Migration } from '../migrate'

/**
 * `artwork_overrides` — the cover correction layer, **W16-9**, design authority
 * `oscine-tag-writeback` → "Embedded artwork & custom frames" (Decision A) and
 * "Schema → Migration 020" (renumbered here: 020 was taken by the genre-alias
 * table, so the artwork migration is 021 — the wiki number is the intent, the
 * file number is the fact).
 *
 * Every text field feeding a pending write already has an app-side source layer:
 * `track_overrides` (D7), extended by 019, and W15's `track_tags`. Artwork has
 * none — a file's embedded picture is the only cover anything reads. Decision A
 * gives it one, so a chosen cover is a persistent correction like every other
 * field: the flush stays a stateless projection of the correction layers (D28),
 * and a set cover shows *instantly everywhere* — Now Playing, the library grid —
 * before any flush, not only after a flush-and-rescan.
 *
 * The row is **tri-state**, mirroring how a text override distinguishes *clear*
 * from *absent*:
 *
 * - no row → leave the file's own cover untouched;
 * - a row with `image_hash` set → set the front cover to that image on flush,
 *   and resolve it as the track's cover now;
 * - a row with `image_hash IS NULL` → clear the front cover on flush, and show
 *   no cover now.
 *
 * `image_hash` is the SHA-256 over the exact full-resolution cover bytes — the
 * same function `derivedArtwork.ts` hashes source art with — and it keys the
 * override-originals store that holds those bytes until a flush writes them into
 * the file. `mime` is the chosen image's media type, carried so the flush writes
 * the right picture frame; it is NULL on a clear. `created_at` stamps the choice.
 *
 * `ON DELETE CASCADE` from `tracks` matches `track_overrides`: a vanished file or
 * a removed root drops the override, and the next originals-store GC releases the
 * hash it referenced.
 */
export const artworkOverrides: Migration = {
  version: 21,
  name: 'artwork-overrides',
  sql: `
    CREATE TABLE artwork_overrides (
      track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      image_hash TEXT,
      mime       TEXT,
      created_at INTEGER NOT NULL
    );
  `
}
