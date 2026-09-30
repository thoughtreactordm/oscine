import type { Migration } from '../migrate'

/**
 * `track_overrides` gains `album_artist_name` — **W16-14**, Decision E.
 *
 * Album artist is half of an album's identity (`albums` is `UNIQUE(title,
 * album_artist_id)`), and a file that carries no album-artist frame falls back to
 * its performer at scan time. A compilation ripped without one therefore shatters
 * into one album per performer, and until now the operator could not correct it:
 * the override layer modelled the album title but not the artist it is keyed on.
 *
 * Same shape as the other text columns: nullable and absent by default, so an
 * existing database gains an empty column and no album re-keys until the operator
 * sets one. `''` is a deliberate "no album artist" — the track falls back to its
 * performer, exactly as the scanner does for a file without the frame.
 */
export const trackOverridesAlbumArtist: Migration = {
  version: 25,
  name: 'track-overrides-album-artist',
  sql: `ALTER TABLE track_overrides ADD COLUMN album_artist_name TEXT;`
}
