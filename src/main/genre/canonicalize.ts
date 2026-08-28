import type Database from 'better-sqlite3'
import { normalizeLabel } from '@shared/genre'
import type { GenreValue } from '@shared/tagWriteback'
import type { GenreCanonicalizer } from '../library/writeback/diff'

/**
 * The genre canonicalization engine — **W16-5**, design authority
 * `oscine-tag-writeback` → "Genre canonicalization engine".
 *
 * Fulfils the {@link GenreCanonicalizer} seam the pending-write diff (W16-1)
 * declares and defaults to identity: given the merged genre set of a track, fold
 * every aliased variant onto its canonical key and spelling, then collapse the
 * duplicates that folding creates. The rules live in `genre_aliases` (migration
 * 020); this module is the pure fold over them plus the store that reads them.
 *
 * ## Pure core, DB-backed edge — the diff.ts/differ.ts split, again
 *
 * {@link makeCanonicalizer} is a pure function of an alias list, so every fold
 * rule — chains, collisions, the canonical spelling winning — is testable
 * without a database. {@link GenreAliasStore} is the one impure seam: it owns the
 * `genre_aliases` rows and hands the pure function a snapshot. The store's
 * {@link GenreAliasStore.canonicalizer} is what a flush passes to the differ.
 *
 * ## The shared key
 *
 * Both sides of a rule are keyed by `@shared/genre`'s `normalizeLabel` — the
 * same casefold `track_genres.genre_key` and W15's `tags.key` are built from — so
 * a rule collapses exactly the vocabulary the operator sees in the browse and the
 * chip surface. This module never invents a second normalisation; if the fold
 * changes, it changes in one place for the whole app.
 */

/** One alias rule: a variant key folded to a canonical genre. */
export interface GenreAlias {
  /** The `normalizeLabel` key of the variant this rule folds away. */
  readonly aliasKey: string
  /** The `normalizeLabel` key of the canonical the variant folds to. */
  readonly canonicalKey: string
  /** The canonical's display spelling — what a flush writes to the file. */
  readonly canonicalLabel: string
}

/**
 * Follows `aliasKey → canonicalKey` hops from `start` to a fixpoint.
 *
 * Chains resolve fully: with `metal → heavy metal` and `heavy metal → metal`
 * collapsed transitively, `metal` lands where the chain ends rather than one hop
 * along it, so a rule set where one canonical is itself another's variant still
 * converges on a single genre. The `seen` set is the cycle guard — a
 * contradictory rule set (mutual aliases) is operator error, and the honest
 * answer to it is to stop at the last key rather than loop forever, so a bad rule
 * degrades to a near-no-op instead of hanging the flush.
 */
function resolveKey(start: string, hops: ReadonlyMap<string, string>): string {
  let key = start
  const seen = new Set<string>([key])
  for (;;) {
    const next = hops.get(key)
    if (next === undefined) return key
    if (seen.has(next)) return next
    seen.add(next)
    key = next
  }
}

/**
 * Builds the canonicalizer for a set of alias rules.
 *
 * The returned function maps each genre in a set to its canonical key and
 * spelling, then dedupes by key keeping first occurrence — which is where two
 * variants of one idea (`hiphop`, `rap` → `Hip-Hop`) collapse to a single genre.
 * Order is preserved so the diff's before/after comparison is deterministic.
 *
 * The canonical *spelling* is authoritative: a genre whose resolved key is a
 * canonical target takes the rule's `canonical_label` even when it arrived spelled
 * some other way — including a genre that was already on the canonical key but
 * spelled inconsistently (a file's `hip-hop` becomes `Hip-Hop`). That is the
 * point of canonicalizing: the whole library reads one spelling, not whichever the
 * tagger happened to write. Genres no rule touches pass through untouched.
 *
 * An empty rule set returns the input as-is — the same contract as the diff's
 * `identityCanonicalizer`, so wiring the real engine over an unconfigured library
 * changes nothing.
 */
export function makeCanonicalizer(aliases: readonly GenreAlias[]): GenreCanonicalizer {
  if (aliases.length === 0) return (genres) => genres

  const hops = new Map<string, string>()
  // The spelling each canonical key should display. First rule wins on a repeated
  // canonical key so the result is stable under the store's ordering; two rules
  // naming one canonical with different spellings is a rare inconsistency the
  // operator authored, not a case worth a spelling-authority merge here.
  const labelForCanonical = new Map<string, string>()
  for (const { aliasKey, canonicalKey, canonicalLabel } of aliases) {
    hops.set(aliasKey, canonicalKey)
    if (!labelForCanonical.has(canonicalKey)) labelForCanonical.set(canonicalKey, canonicalLabel)
  }

  return (genres) => {
    const out = new Map<string, GenreValue>()
    for (const value of genres) {
      const key = resolveKey(value.key, hops)
      const label = labelForCanonical.get(key) ?? value.label
      if (!out.has(key)) out.set(key, { key, label })
    }
    return [...out.values()]
  }
}

/**
 * `genre_aliases`, and the statements it is made of — **migration 020, W16-5**.
 *
 * Its own module under `src/main/genre`, the domain home for what
 * `@shared/genre` normalises: the library layer never writes these rows, and a
 * rescan never touches them, exactly like the W15 tag vocabulary they share a key
 * with. Electron-free, so it is drivable under plain Node against a temp file —
 * its tests do precisely that through the real migration list.
 *
 * The write API normalises both sides of a rule through the shared
 * `normalizeLabel`, so `setAlias` and the browse both see one key per genre.
 * `canonicalizer()` reads the whole (small) table once and hands the snapshot to
 * {@link makeCanonicalizer}; a flush takes that function per batch, so the rules
 * in force are the rules at flush time.
 */
export class GenreAliasStore {
  private readonly statements: {
    upsert: Database.Statement<{
      aliasKey: string
      canonicalKey: string
      canonicalLabel: string
      createdAt: number
    }>
    remove: Database.Statement<[string]>
    list: Database.Statement<[]>
  }

  constructor(db: Database.Database) {
    this.statements = {
      // Coin or repoint a rule. A second `setAlias` on the same variant retargets
      // it — `DO UPDATE` rather than `DO NOTHING`, because re-aliasing a key is the
      // operator changing where it folds, not a duplicate to ignore. `created_at`
      // is left at its first value: it records when the rule was first coined.
      upsert: db.prepare(`
        INSERT INTO genre_aliases (alias_key, canonical_key, canonical_label, created_at)
        VALUES (@aliasKey, @canonicalKey, @canonicalLabel, @createdAt)
        ON CONFLICT(alias_key) DO UPDATE SET
          canonical_key = excluded.canonical_key,
          canonical_label = excluded.canonical_label
      `),
      remove: db.prepare('DELETE FROM genre_aliases WHERE alias_key = ?'),
      // Whole table, ordered so variants read grouped under their canonical
      // spelling (`NOCASE`, alphabetical), `alias_key` breaking ties so a paged
      // reader never sees a row twice — and so the canonicalizer's first-wins
      // spelling choice is deterministic.
      list: db.prepare(`
        SELECT alias_key AS aliasKey, canonical_key AS canonicalKey, canonical_label AS canonicalLabel
        FROM genre_aliases
        ORDER BY canonical_label COLLATE NOCASE, alias_key
      `)
    }
  }

  /**
   * Coins or repoints a rule folding `alias` onto `canonical`.
   *
   * Both labels are normalised to the shared key. Returns the stored rule, or
   * `null` when either normalises to nothing (empty or whitespace-only) or when
   * the two share a key — a genre is not its own alias, and a self-rule is the one
   * shape that would fold a key onto itself. Re-aliasing an existing variant
   * retargets it.
   */
  setAlias(alias: string, canonical: string): GenreAlias | null {
    const a = normalizeLabel(alias)
    const c = normalizeLabel(canonical)
    if (a === null || c === null) return null
    if (a.key === c.key) return null

    const rule: GenreAlias = { aliasKey: a.key, canonicalKey: c.key, canonicalLabel: c.label }
    this.statements.upsert.run({
      aliasKey: rule.aliasKey,
      canonicalKey: rule.canonicalKey,
      canonicalLabel: rule.canonicalLabel,
      createdAt: Date.now()
    })
    return rule
  }

  /**
   * Removes the rule keyed by `alias`, if any.
   *
   * `true` when a rule was deleted, `false` when none matched — removing a variant
   * that carries no rule is idempotent, not an error. The label is normalised so
   * the caller removes by any spelling of the variant.
   */
  removeAlias(alias: string): boolean {
    const a = normalizeLabel(alias)
    if (a === null) return false
    return this.statements.remove.run(a.key).changes > 0
  }

  /** Every rule, grouped by canonical spelling — the management surface's read. */
  listAliases(): GenreAlias[] {
    return this.statements.list.all() as GenreAlias[]
  }

  /**
   * The canonicalizer for the current rule set — a snapshot, passed to a flush.
   *
   * Reads the whole table once and closes over it, so the function a batch flush
   * carries reflects the rules at the moment it was taken. An empty rule set
   * yields identity.
   */
  canonicalizer(): GenreCanonicalizer {
    return makeCanonicalizer(this.listAliases())
  }
}
