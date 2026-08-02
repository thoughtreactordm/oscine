/**
 * Deciding whether a search result is the artist that is playing.
 *
 * This is where **R5** is won or lost. The risk is stated as "a wrong match
 * renders a confident, wrong biography, which is worse than rendering nothing",
 * so every number below is chosen to fail towards *nothing* — an artist the deck
 * declines to identify costs an operator one click on the picker, and an artist
 * it identifies wrongly costs them a paragraph of untrue biography they have no
 * reason to doubt.
 *
 * ## Why a threshold alone is not enough
 *
 * R5's mitigation says "accept only above a score threshold", and taken
 * literally that does not survive its own worked example. Eleven MusicBrainz
 * artists are called exactly "Nirvana". Every one of them is an exact string
 * match, every one of them scores 100 on any name-similarity measure worth
 * having, and MusicBrainz's own relevance score is 100 for all of them too.
 * There is no threshold that accepts the right Nirvana and rejects the other
 * ten; a threshold can only accept *whichever came first*, which is the wrong
 * biography with extra steps.
 *
 * So acceptance is two tests, not one:
 *
 * 1. **Threshold** — the best candidate has to be good enough in absolute terms.
 * 2. **Margin** — it has to be better than the runner-up by a clear distance.
 *
 * The margin is what makes "Nirvana" resolve to *ambiguous* rather than to a
 * coin flip, and ambiguous is a first-class state with a picker attached. The
 * threshold is what stops a library full of misspelled tags from being confidently
 * matched to whatever MusicBrainz ranked first.
 *
 * ## What we are not doing, and why
 *
 * The tiebreaker that would actually settle Nirvana is corroboration: we know
 * which albums this artist has in the local library, and MusicBrainz knows which
 * releases each candidate has. Intersecting the two would identify the right one
 * outright. It is not done here because it costs one request *per candidate*,
 * against a service that permits roughly one request per second — eleven seconds
 * of lookups to answer a question the operator can answer in one click. If R5's
 * correction rate turns out to be high enough to justify that, this is the place
 * it lands, and the revisit trigger is already written down in D14.
 */

import type { ArtistCandidate } from '@shared/artist'
import { compareKey } from './artistName'

/**
 * The absolute bar, out of 100.
 *
 * With `NAME_WEIGHT` at 0.75 this has three readable consequences, and they are
 * the reason for the number rather than a description of it:
 *
 * - A candidate whose name matches exactly (name 100) needs a MusicBrainz score
 *   of only 20 to clear the bar. Every genuine hit clears that comfortably, so
 *   an exact name match is never rejected on the strength of MusicBrainz's
 *   ranking alone.
 * - A candidate whose name is three-quarters right (name 75) needs a MusicBrainz
 *   score of 95. That is the case where our normalisation mangled something and
 *   MusicBrainz's index is certain anyway — worth deferring to, but only at the
 *   very top of its confidence.
 * - Below a name score of about 73 nothing clears the bar at all, whatever
 *   MusicBrainz says. A tag that is a quarter wrong is a tag worth correcting,
 *   not a tag worth guessing about.
 *
 * Tuned against the fixture set in `tests/main/musicbrainz/`, which is chosen to
 * be hard rather than easy — an ambiguous name, punctuation, non-Latin, a
 * featured-artist credit, and one artist that genuinely does not exist. Tuning
 * against whichever artist happened to be playing is precisely the failure the
 * card warns about.
 */
export const ARTIST_MATCH_THRESHOLD = 80

/**
 * How far ahead of the runner-up the winner has to be, out of 100.
 *
 * Ten points is, on this scale, roughly "one name matches and the next one
 * materially does not". Two candidates with identical names can differ by at
 * most a quarter of the MusicBrainz score spread between them, and MusicBrainz
 * gives exact matches equal scores — so identically named candidates always land
 * within ten of each other and the pair is declared ambiguous. That is the
 * Nirvana rule expressed as arithmetic.
 *
 * It also has to be small enough not to reject the ordinary case. An artist with
 * one exact match and a runner-up that merely shares a word scores 100 against
 * something in the fifties; the gap is not close to ten.
 */
export const ARTIST_MATCH_MARGIN = 10

/**
 * How much of the verdict is our name comparison and how much is MusicBrainz's
 * relevance score.
 *
 * Three quarters ours. The name is evidence we can inspect and test; the search
 * score is a Lucene relevance figure that encodes index-side popularity and
 * alias breadth we cannot reproduce — useful as a nudge, and exactly the signal
 * that would happily rank the famous Nirvana above the right one. Giving it a
 * quarter lets it order candidates that our comparison ties, without letting it
 * decide one.
 */
export const NAME_WEIGHT = 0.75

/** A candidate with its arithmetic attached, for tests and for the picker. */
export interface ScoredCandidate extends ArtistCandidate {
  /** How well the name matched, 0–100, before MusicBrainz's opinion is mixed in. */
  nameScore: number
  /** MusicBrainz's own relevance score for the search, 0–100. */
  searchScore: number
}

/** What the names a candidate can be recognised by, already in compare form. */
export interface CandidateNames {
  name: string
  sortName: string | null
  aliases: readonly string[]
}

/**
 * Character-bigram multisets, for Sørensen–Dice.
 *
 * Dice over edit distance because it is insensitive to word order and to
 * insertions in the middle — "Sakamoto Ryuichi" against "Ryuichi Sakamoto"
 * scores well, where Levenshtein reads it as most of the string having moved.
 * Bigrams rather than words for the same reason a compare key strips
 * punctuation: the differences we are forgiving are usually inside a token.
 */
function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let i = 0; i + 1 < value.length; i++) {
    const pair = value.slice(i, i + 2)
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  return counts
}

/**
 * Sørensen–Dice over character bigrams, 0–1.
 *
 * Exact equality short-circuits to 1 so that one- and two-character names — "U2",
 * "M", the CJK names that are two glyphs long — are not penalised for having
 * almost no bigrams to compare. Without that, "坂本" against itself would score
 * on a single bigram and any mismatch would be catastrophic.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a === '' || b === '') return 0

  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  let leftTotal = 0
  for (const [pair, count] of left) {
    leftTotal += count
    shared += Math.min(count, right.get(pair) ?? 0)
  }
  let rightTotal = 0
  for (const count of right.values()) rightTotal += count

  return (2 * shared) / (leftTotal + rightTotal)
}

/**
 * A sort name says the same thing in a different order, so try both.
 *
 * "Beatles, The" and "Sakamoto, Ryuichi" are the same names as "The Beatles" and
 * "Ryuichi Sakamoto" with the comma doing the work an article or a given name
 * would. Inverting at the first comma is what makes the leading-article case —
 * one of R5's four named breakages — resolve on the sort name even when the
 * display name is written the other way round.
 */
function sortNameVariants(sortName: string): string[] {
  const comma = sortName.indexOf(',')
  if (comma === -1) return [sortName]
  const head = sortName.slice(0, comma).trim()
  const tail = sortName.slice(comma + 1).trim()
  if (head === '' || tail === '') return [sortName]
  return [sortName, `${tail} ${head}`]
}

/**
 * How well a query matches any name the candidate answers to, 0–100.
 *
 * The best of the display name, both readings of the sort name, and every alias
 * MusicBrainz returned. Aliases are what carry the transliterations, so this is
 * the field that lets a library tagged "Ryuichi Sakamoto" match an artist whose
 * MusicBrainz name is "坂本龍一" — and the reason the search asks for them.
 */
export function nameScore(query: string, names: CandidateNames): number {
  const target = compareKey(query)
  if (target === '') return 0

  const forms = [names.name, ...(names.sortName ? sortNameVariants(names.sortName) : [])]
  forms.push(...names.aliases)

  let best = 0
  for (const form of forms) {
    const key = compareKey(form)
    if (key === '') continue
    best = Math.max(best, similarity(target, key))
    if (best === 1) break
  }
  return Math.round(best * 100)
}

/** Mixes our name comparison with MusicBrainz's relevance, per `NAME_WEIGHT`. */
export function combinedScore(name: number, search: number): number {
  return Math.round(NAME_WEIGHT * name + (1 - NAME_WEIGHT) * search)
}

/**
 * The verdict on a ranked candidate list.
 *
 * `none` and `ambiguous` are both "no identity", and the split is by which of
 * the two tests failed, because the operator's next move differs. `ambiguous`
 * means several candidates are each plausibly this artist and one of them is
 * probably right — open the picker. `none` means nothing on offer is plausibly
 * this artist at all, so the tag is what to look at.
 *
 * The distinction cost a live probe to get right. MusicBrainz's search almost
 * never answers an unknown name with an empty array: query a name nobody has
 * and it returns whatever shares a word, scoring in the sixties. Folding that
 * into `ambiguous` made the deck say "several artists go by this name" over a
 * list containing a Dave Brubeck record — which is not merely unhelpful, it is
 * the confident wrong claim R5 exists to prevent, moved from the biography to
 * the header.
 */
export type MatchDecision =
  { kind: 'accept'; match: ScoredCandidate } | { kind: 'ambiguous' } | { kind: 'none' }

/**
 * Applies the threshold and the margin to candidates already sorted best first.
 *
 * The threshold first, because it asks whether there is anything here at all;
 * the margin second, because it only means something once there is. That order
 * is what makes the two failures separable — the whole of R5's mitigation in
 * five lines.
 *
 * A `none` verdict does not mean the candidates are worthless. They are still
 * handed to the picker: a badly misspelled tag scores everything below the bar
 * while the right artist sits third in the list, and the operator can see that
 * even though we cannot.
 */
export function decide(candidates: readonly ScoredCandidate[]): MatchDecision {
  const [best, runnerUp] = candidates
  if (!best || best.score < ARTIST_MATCH_THRESHOLD) return { kind: 'none' }
  if (runnerUp && best.score - runnerUp.score < ARTIST_MATCH_MARGIN) return { kind: 'ambiguous' }
  return { kind: 'accept', match: best }
}
