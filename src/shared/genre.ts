/**
 * The genre splitter: one tag string in, grouping identities out.
 *
 * `tracks.genre` (migration 010) is whatever the tagger wrote, so `Rock`, `rock`
 * and `Rock; Alternative` are three genres to anything that groups by it, and a
 * genre histogram over that column is close to noise. `track_genres` (migration
 * 013) is the derived join table that gives grouping something to group on, and
 * this function is the only thing that decides what those rows are.
 *
 * ## Why it lives in `src/shared`
 *
 * Not because the renderer needs it today — nothing there calls it yet. Because
 * the two things that come next both have to agree with the migration's backfill
 * to the character: an operator alias map, which rewrites keys, and a display
 * path that has to spell a key the same way the stats pane does. A splitter with
 * two implementations is a library whose genre counts change depending on which
 * one last touched a track.
 *
 * ## The rules, and what each costs
 *
 * Separators are `;`, `/` and `,`. `/` is the contentious one — it is a real
 * separator and also a real character inside a genre name, so `Rock/Pop` becomes
 * two genres and there is no way to tell it apart from `Hip-Hop/Rap` without
 * knowing the library. Splitting is right far more often than not, and the
 * answer to the remainder is an operator alias map, deliberately not this
 * function's job.
 *
 * `genre` is the first spelling seen for a key rather than a title-cased one.
 * Arbitrary, but stable, and a title-caser gets `R&B`, `EDM` and `hip-hop` wrong
 * three different ways — the display value is a fact about the library, not a
 * guess about English.
 *
 * Casefolding is `toLowerCase`, not `toLocaleLowerCase`. The key is a persisted
 * grouping identity, and a locale-sensitive fold would mean a Turkish operator's
 * database groups `INDIE` differently from everyone else's — and differently
 * from the same database opened after a locale change.
 */

/** One genre: how it groups, and how it is spelled. */
export interface SplitGenre {
  /** Casefolded, trimmed, internal whitespace collapsed. The grouping identity. */
  readonly key: string
  /** The display spelling this key was first seen with. */
  readonly genre: string
}

/** One label reduced to its grouping identity and its display spelling. */
export interface NormalizedLabel {
  /** Casefolded, trimmed, internal whitespace collapsed. The grouping identity. */
  readonly key: string
  /** The display spelling: trimmed and whitespace-collapsed, but not casefolded. */
  readonly label: string
}

/** `;`, `/` and `,`. Not global — `String.split` ignores the flag anyway. */
const SEPARATORS = /[;/,]/

const WHITESPACE = /\s+/g

/**
 * One label, normalised to the grouping identity `track_genres.genre_key` is
 * built from — or `null` when it holds no label at all.
 *
 * Factored out of `splitGenres` so the app-side user-tag layer (`src/main/tags`)
 * can key a tag by the *exact* same rule a file genre is grouped by. A tag
 * spelled `Hip-Hop` and a file genre spelled `hip-hop` have to land on one key
 * or the two vocabularies never unify — and the only way to guarantee that is
 * one function. The header's argument against a second splitter is the same
 * argument against a second casefold, verbatim.
 *
 * It does *not* split. A user tag is one label the operator typed, not a
 * multi-valued file frame, so `Rock/Pop` entered as a tag stays the single tag
 * `Rock/Pop`. Trimming, whitespace-collapse and casefold are shared with
 * `splitGenres`; separating on `;/,` is `splitGenres`' alone.
 */
export function normalizeLabel(raw: string | null | undefined): NormalizedLabel | null {
  if (typeof raw !== 'string') return null

  const label = raw.trim().replace(WHITESPACE, ' ')
  if (label === '') return null

  return { key: label.toLowerCase(), label }
}

/**
 * Splits one genre tag into its distinct genres, in the order they appear.
 *
 * Deduplicated by key, so `Rock; rock` is one genre and the result can be
 * inserted straight into `track_genres` without an `OR IGNORE` hiding a bug
 * here. A `null`, an empty tag, or a tag that is nothing but separators all
 * yield an empty array — none of them is a genre, and none is an error.
 */
export function splitGenres(tag: string | null | undefined): SplitGenre[] {
  if (typeof tag !== 'string') return []

  const byKey = new Map<string, SplitGenre>()
  for (const part of tag.split(SEPARATORS)) {
    const norm = normalizeLabel(part)
    if (norm === null) continue

    if (!byKey.has(norm.key)) byKey.set(norm.key, { key: norm.key, genre: norm.label })
  }
  return [...byKey.values()]
}
