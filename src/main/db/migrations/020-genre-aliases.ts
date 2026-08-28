import type { Migration } from '../migrate'

/**
 * `genre_aliases` — the operator's bulk genre-cleanup rules — **W16-5, D28**.
 *
 * The operator's stated pain is not one-off typos but *bulk junk genres*: a
 * library where `hiphop`, `Hip-Hop/Rap` and `Rap` are three spellings of one
 * idea and a genre histogram is mostly noise. `track_genres` (migration 013)
 * already gives grouping an identity — `genre_key`, the casefold from
 * `@shared/genre` — but it can only *group* the spellings a file happens to
 * carry, not decide that two keys mean the same thing. This table is that
 * decision: a library-wide map from a variant key to the canonical genre it
 * should collapse to.
 *
 * ## The shared key, again
 *
 * `alias_key` and `canonical_key` are both the *same* `normalizeLabel` key
 * `track_genres.genre_key` and the W15 `tags.key` are built from. That is the
 * whole point of living in W16 rather than inventing a taxonomy: an alias for
 * `Hip-Hop` and a file genre spelled `hip-hop` land on one key, so the rules
 * collapse the exact vocabulary the operator already sees in the browse and the
 * W15 chip surface. A second normalisation here would be a second library.
 *
 * ## What a rule keys on, and the split it inherits
 *
 * A rule keys on a *single* normalised label, not a split frame. Multi-valued
 * file genres are already split into their component keys before they reach the
 * fold — the pending-write diff (W16-1) derives its genre set with the same
 * `splitGenres` the scanner uses — so `Hip-Hop/Rap` in a file arrives as the two
 * keys `hip-hop` and `rap`, and the way to collapse it is a rule per component
 * (`rap` → `Hip-Hop`), not a rule for the joined string. A user tag, which is
 * one label the operator typed and is *not* split, keys on itself: a tag
 * `Hip-Hop/Rap` stays the single key `hip-hop/rap` and a rule can target it
 * directly. Both follow from `@shared/genre`, so neither is this table's to
 * redefine.
 *
 * ## `canonical_label`, the spelling the flush writes
 *
 * `canonical_key` is the identity the variant folds to; `canonical_label` is the
 * display spelling that key is written to the file with — the same key/label
 * split `track_genres` and `tags` keep, and for the same reason: the key groups,
 * the label is a fact about how the operator wrote the canonical, not a guess
 * about capitalisation. The label is what a flush (W16-2) puts in the tag, so a
 * rule `rap` → `Hip-Hop` rewrites both the key *and* the spelling of every
 * aliased genre in the merged set.
 *
 * ## Global to start
 *
 * One flat table, no scope column. The rules are the operator's library-wide
 * intent; per-root rules are a complication no stated need calls for yet, and an
 * `enabled`/`scope` column is a later migration if one ever does — the card's
 * "start global" made deliberate. `WITHOUT ROWID` because `alias_key` is the
 * primary key and all but two columns of the row, so an implicit rowid would be
 * a second copy of the key in a second b-tree. The table is operator-authored
 * and small (tens to low hundreds of rules), read whole to build the
 * canonicalizer, so it carries no secondary index — nothing scans it by
 * `canonical_key` on a hot path.
 */
export const genreAliases: Migration = {
  version: 20,
  name: 'genre-aliases',
  sql: `
CREATE TABLE genre_aliases (
  alias_key       TEXT    NOT NULL PRIMARY KEY,  -- normalizeLabel key of the variant to fold away
  canonical_key   TEXT    NOT NULL,              -- normalizeLabel key of the canonical it folds to
  canonical_label TEXT    NOT NULL,              -- canonical display spelling a flush writes to file
  created_at      INTEGER NOT NULL
) WITHOUT ROWID;
`
}
