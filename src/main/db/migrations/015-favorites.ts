import type { Migration } from '../migrate'

/**
 * Favorites — **D18**.
 *
 * A boolean fact about a track, keyed by the track, one row or none. The pinned
 * "My Favorites" entry the operator sees at the top of the playlist rail is a
 * *view* over this table and not its storage — D18 records why at length, and
 * the short version is that a playlist row would inherit D12's rule that the
 * same track is legal twice, which is exactly wrong for a fact that is either
 * true or false, and would make the per-row heart a membership join in a list
 * that draws a hundred thousand rows.
 *
 * Schema only. Nothing here has an opinion about what un-hearting pushes to a
 * connected account; that is D19 and W11-6, and the whole of this table works
 * with no account connected at all.
 *
 * ## `CASCADE`, where 014 chose `SET NULL`
 *
 * This is the load-bearing line, and the difference from `listens` two
 * migrations ago is the point rather than an inconsistency.
 *
 * A favorite is a statement about a track you can play. One you cannot play is
 * a broken row in a pinned playlist — it renders as a gap the operator has to
 * understand and cannot act on. And a favorite lost to a folder move is one
 * click to restore, because the track is still there and still the one they
 * wanted. Listening history has neither property: it is a statement about the
 * past, nothing on disk can reconstruct it, and the operator would discover the
 * loss a year later from a chart with a hole in it. So the log severs and keeps
 * the row; this cascades and lets it go.
 *
 * Cross-machine durability for favorites is D11's export bundle (W10-13), not
 * the delete rule. A table that survived its own track would be answering the
 * portability question in the wrong place.
 *
 * ## The columns, and the ones that are absent
 *
 * `track_id` is the primary key rather than a column with a unique index over
 * it, so "favorited twice" is not a state the schema can hold. `INTEGER PRIMARY
 * KEY` makes it an alias for the rowid, so the table *is* its own index and a
 * per-row lookup from the track projection is one b-tree probe.
 *
 * `favorited_at` is the only other column, and it exists because the rail has to
 * order by something. Most-recently-hearted first is the order that needs no
 * explaining; authored position is not available, because there is no gesture
 * that authors one — D18's accepted cost, made honest by disabling reorder in
 * the pane rather than by inventing a position nobody set.
 *
 * There is no `unfavorited_at` and no tombstone. Un-hearting deletes the row.
 * A record of what someone stopped liking is not a thing this application is
 * going to keep on their behalf, and the outbox (012) already holds the pending
 * `track.unlove` for as long as it takes to send.
 *
 * ## The index
 *
 * `idx_track_favorites_at` serves the rail's default order and nothing else.
 * The reverse direction — "is this track favorited" — is the primary key and
 * needs no index of its own, which is the whole reason the key is the track.
 *
 * No backfill. Nothing in the schema before this recorded a favorite: D18 turns
 * down reusing `tracks.rating` above a threshold precisely so that stars and
 * hearts stay independent gestures, and reading a rating in here now would be
 * that rejected design arriving through the back door.
 */
export const favorites: Migration = {
  version: 15,
  name: 'favorites',
  sql: `
CREATE TABLE track_favorites (
  track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  favorited_at INTEGER NOT NULL       -- UTC ms; the rail's default order
);

CREATE INDEX idx_track_favorites_at ON track_favorites(favorited_at);
`
}
