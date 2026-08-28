/**
 * Every table in the library database, and which side of D11 it is on.
 *
 * `../db/artifacts.ts` answers this question for *files* in `userData`, and its
 * reasoning applies here one level down. D11's bundle carries statements about
 * tracks; "excluded" is not something an exporter achieves by omission, it is
 * something an exporter has to be told. The failure this list exists to prevent
 * is the one W10-13's card names outright: `play_history` sitting next to
 * `listens` in the schema and getting swept in because it now has a neighbour
 * that is carried. Proximity is not an argument. A declaration is.
 *
 * `bundle.test.ts` asserts this list against `sqlite_master`, so a migration
 * that adds a table fails the suite until someone writes down which side it is
 * on. That is the point of the `'open'` side: several tables genuinely have not
 * been ruled on, and a contract that forced a guess would be worse than one that
 * records the question. `'open'` means *no card has decided*, not *nobody
 * looked*.
 *
 * **No credential is a row anywhere in here.** The Last.fm session key lives in
 * Electron's `safeStorage` precisely so that it cannot be a `settings` row and
 * therefore cannot ride a bundle (D19). That is a schema-level property, which
 * is why it is stated here and not enforced here — there is nothing to enforce.
 *
 * Electron-free, like `artifacts.ts`, so a plain-Node test can read it.
 */

/** Which side of the export bundle a table's contents are on. */
export type BundleSide =
  /** Its contents travel. `merge` says how two machines' versions reconcile. */
  | 'carried'
  /** Its contents never travel, and the exporter must not be talked into it. */
  | 'excluded'
  /**
   * Arguable, and unargued. Named here so that a future exporter has to look it
   * up and find a question rather than find nothing and assume an answer.
   */
  | 'open'

export interface BundleTable {
  readonly name: string
  readonly side: BundleSide
  /**
   * For a table carried in part, the columns that travel. Absent means the row.
   * `tracks` is the only one: the row itself is the importer's own scan of its
   * own files, and only the operator's statements about it are portable.
   */
  readonly columns?: readonly string[]
  /** Why it is on that side. Read by whoever next wonders. */
  readonly why: string
  /**
   * How two machines' versions of a carried row reconcile. Required on every
   * `'carried'` entry and meaningless elsewhere — a merge rule nobody wrote down
   * is the bug this whole file is about, and the incoherent import is always the
   * one that had no rule rather than the one that had the wrong rule.
   */
  readonly merge?: string
}

/**
 * The declaration, in schema order.
 *
 * Ordered by migration rather than by side, because the reader arriving here is
 * almost always holding a table name from a migration and asking about that one.
 */
export const BUNDLE_TABLES: readonly BundleTable[] = [
  {
    name: 'roots',
    side: 'excluded',
    why:
      'Absolute, machine-local paths. D11 is one independent library per machine and the ' +
      'importer’s roots are its own; a bundle names a track by (root label, rel_path) so that ' +
      'it survives the other machine keeping its music somewhere else entirely.'
  },
  {
    name: 'artists',
    side: 'excluded',
    why: 'Produced by scanning files. The importer’s own scan produces its own.'
  },
  {
    name: 'albums',
    side: 'excluded',
    why: 'Produced by scanning files, and the artwork hash keys a cache that is not carried either.'
  },
  {
    name: 'tracks',
    side: 'carried',
    columns: ['rating', 'play_count', 'last_played_at'],
    why:
      'The row is the importer’s scan of its own files — sizes, codecs, mtimes and ReplayGain ' +
      'are all statements about a copy of a file that the bundle does not contain. Three ' +
      'columns are not: a rating is authored, and the two counters are the listening log’s ' +
      'caches. Those are the "ratings and play counts" D11 has carried since it was written.',
    merge:
      'Rating resolves by recency. `play_count` and `last_played_at` are **recomputed** from ' +
      'the merged `listens` log by `rebuildTrackCounters`, never added — adding two machines’ ' +
      'counters after also merging their logs double-counts every overlapping listen.'
  },
  {
    name: 'tracks_fts',
    side: 'excluded',
    why: 'A search index over `tracks`, maintained by triggers and rebuildable from the rows.'
  },
  {
    name: 'replaygain_jobs',
    side: 'excluded',
    why:
      'A work queue. Its rows describe an analysis run on one machine’s files; importing them ' +
      'would resume another machine’s job against tracks this one may not have.'
  },
  {
    name: 'replaygain_job_items',
    side: 'excluded',
    why: 'Rides with its parent job, and its results land on `tracks` when the job completes.'
  },
  {
    name: 'podcasts',
    side: 'open',
    why:
      'D15 left this open deliberately — its rejected alternative was rejected partly *because* ' +
      'it forced the bundle to decide whether a subscription is library data. It still has to ' +
      'be decided, by a W9 or W6 card, and not by an exporter that finds no entry here.'
  },
  {
    name: 'episodes',
    side: 'open',
    why: 'Rides with `podcasts` whichever way that goes. The downloaded audio never travels (D14).'
  },
  {
    name: 'settings',
    side: 'open',
    why:
      'A `durable` key is by definition a candidate — that is the sentence D19 uses to explain ' +
      'why the session key is not one. Whether the whole `durable` scope travels, or a named ' +
      'subset, is a settings question this card does not answer. `view` scope plainly does not.'
  },
  {
    name: 'playlists',
    side: 'carried',
    why: 'D11 has carried playlists since it was written. A playlist is a set, and sets travel.',
    merge:
      'Merged or kept separate, per import, by the operator — D11 says a playlist is a set that ' +
      'can be either, which makes it a choice at the moment of import rather than a fixed rule.'
  },
  {
    name: 'playlist_entries',
    side: 'carried',
    why: 'A playlist is its entries. They ride with the parent, tracks named by (root label, rel_path).',
    merge: 'Whatever the parent playlist’s merge choice was. Entries are never reconciled alone.'
  },
  {
    name: 'track_overrides',
    side: 'open',
    why:
      'D7’s corrections read like every other statement about a track and would qualify on that ' +
      'argument alone — but D11 names playlists, ratings and play counts, and has never named ' +
      'these. The exporter card decides it. Do not read the resemblance as a ruling.'
  },
  {
    name: 'play_history',
    side: 'excluded',
    why:
      'D11’s W7-4 amendment, unchanged and for its original reason: a trail is a statement about ' +
      'one session on one machine, and merging two interleaves listening that never happened. ' +
      'It now sits beside a table that *is* carried. That changes nothing — see the note above.'
  },
  {
    name: 'track_genres',
    side: 'excluded',
    why: 'Derived from `tracks.genre` and rebuilt on scan. The importer’s scan rebuilds its own.'
  },
  {
    name: 'scrobble_queue',
    side: 'excluded',
    why:
      'Machine-local outbound state. Importing another machine’s pending scrobbles would submit ' +
      'them a second time, under whichever account *this* machine happens to be signed into.'
  },
  {
    name: 'listens',
    side: 'carried',
    why:
      'D17 made `tracks.play_count` a cache of this table, which fired D11’s own revisit trigger. ' +
      'Carrying the derived value while dropping its source is the incoherent option, and the ' +
      'log is mergeable in the way the trail is not: two machines’ timestamped events genuinely ' +
      'interleave into a chronology that did happen.',
    merge:
      '`INSERT OR IGNORE` against `idx_listens_identity` — `(started_at, title, artist_name)` — ' +
      'so merging a bundle twice is merging it once, followed by `rebuildTrackCounters` over the ' +
      'merged log.'
  },
  {
    name: 'listen_genres',
    side: 'carried',
    why: 'A listen’s genres are on the listen, by 014’s copy-don’t-join rule. They ride with it.',
    merge: 'None of its own: the parent row either inserted or was ignored, and these follow.'
  },
  {
    name: 'track_favorites',
    side: 'carried',
    why:
      'A statement about a track, on the same footing as a rating (D18). The delete rule cascades ' +
      'precisely because cross-machine durability is this bundle’s job and not the schema’s.',
    merge:
      'Resolves by recency: the row is kept with the later `favorited_at`, which is idempotent ' +
      'and independent of import order. There is no un-favorite tombstone to reconcile against ' +
      '(D18), so an un-heart on one machine does not travel.'
  },
  {
    name: 'playlist_favorites',
    side: 'open',
    why:
      'D24 makes a playlist favoritable on the same footing D18 gave a track, so by the ' +
      '`track_favorites` argument this is a candidate to carry — and its parent `playlists` ' +
      'already does. But W13-2 only adds the table; the D11 exporter card (W10-13) has not ruled ' +
      'on it, and carrying it means riding the parent’s per-import merge choice (keep vs merge) ' +
      'and re-keying `playlist_id` the way `playlist_entries` does. That is the exporter’s design ' +
      'to make, not this migration’s. Do not read the resemblance to `track_favorites` as a ruling.'
  },
  {
    name: 'artist_favorites',
    side: 'open',
    why:
      'The same D24 star, and the same unruled question as `playlist_favorites` — with a sharper ' +
      'edge: `artists` is `excluded` because the importer re-derives it from its own scan, so ' +
      '`artist_id` is a local surrogate with no cross-machine identity. Carrying this row would ' +
      'first need an artist named the portable way (by name, as tracks are named by root label ' +
      'and rel_path), a mechanism the bundle does not yet have. The exporter card decides both ' +
      'whether it travels and how it would be keyed if it did.'
  },
  {
    name: 'tags',
    side: 'open',
    why:
      'A user tag is an operator’s statement about their library (D7, W15), on the same footing ' +
      'as a rating or a favorite — so by the `track_favorites` argument the vocabulary is a ' +
      'candidate to carry, and unlike `artist_id` its `key` is already a portable casefold ' +
      'identity a bundle could re-key on directly. But W15-1 only adds the tables; the D11 ' +
      'exporter card (W10-13) has not ruled, and carrying the vocabulary is meaningless without ' +
      'carrying `track_tags` with it. The exporter decides both. Do not read the resemblance to ' +
      '`track_favorites` as a ruling.'
  },
  {
    name: 'track_tags',
    side: 'open',
    why:
      'The assignments the `tags` vocabulary exists for, and unruled for its reason. If they ' +
      'travel they ride with `tags`, tracks named the portable way (root label, rel_path) as ' +
      '`playlist_entries` are and the tag named by its `key`. `source` is local colour a merge ' +
      'would resolve toward `user`. All of that is the exporter card’s design, not this ' +
      'migration’s.'
  },
  {
    name: 'genre_aliases',
    side: 'open',
    why:
      'Operator-authored canonicalization rules (W16-5), a statement about the library on the ' +
      'same footing as an override or a tag — so by the `track_overrides`/`tags` argument the ' +
      'ruleset is a candidate to carry, and both sides of a rule are already the portable ' +
      'casefold `key` a bundle could re-key on directly. But W16-5 only adds the table; the D11 ' +
      'exporter card (W10-13) has not ruled, and unlike a per-track statement these rules are ' +
      'global — an importer would union them into its own ruleset rather than name a track, a ' +
      'merge the exporter card designs. Do not read the resemblance to `track_overrides` as a ruling.'
  },
  {
    name: 'artwork_overrides',
    side: 'open',
    why:
      'W16-9’s cover correction, a per-track statement about a track on the same footing as ' +
      '`track_overrides` — and unruled for the same reason: the D11 exporter card (W10-13) has ' +
      'not named it. A sharper edge than the text override, though: the row is only a hash and a ' +
      'mime, and the cover bytes it names live in the `artwork-originals-v1` artifact, which is ' +
      '`derived` and never travels (the bundle carries no file bytes). So even were the row ruled ' +
      'to carry, the exporter would first need a way to carry the image the hash points at, which ' +
      'the bundle does not have. The exporter card decides both. Do not read the resemblance to ' +
      '`track_overrides` as a ruling.'
  }
]

/** Table names whose contents the bundle carries, in whole or in part. */
export const CARRIED_TABLES: readonly string[] = BUNDLE_TABLES.filter(
  (table) => table.side === 'carried'
).map((table) => table.name)

/**
 * Table names the bundle must never contain.
 *
 * `'open'` tables are deliberately absent from both this list and
 * `CARRIED_TABLES`. An exporter that consults these two and finds a name in
 * neither has found an unanswered question, which is the state this file exists
 * to make visible rather than to paper over.
 */
export const EXCLUDED_TABLES: readonly string[] = BUNDLE_TABLES.filter(
  (table) => table.side === 'excluded'
).map((table) => table.name)

/** The declaration for one table, or `undefined` when nobody has written one. */
export function bundleTable(name: string): BundleTable | undefined {
  return BUNDLE_TABLES.find((table) => table.name === name)
}
