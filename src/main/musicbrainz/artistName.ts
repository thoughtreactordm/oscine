/**
 * Turning a tag string into something worth searching for, and into something
 * worth comparing against.
 *
 * **R5** names four ways a naive lookup breaks — punctuation, non-Latin names,
 * leading articles and featured-artist strings — and three of them are handled
 * here. The fourth, an ambiguous name, cannot be handled by any amount of string
 * work and is `score.ts`'s problem.
 *
 * Two different transforms, and conflating them is the mistake this file exists
 * to avoid. `searchQuery` decides *what we ask MusicBrainz*, and must stay close
 * to the original or the search index cannot find the artist. `compareKey`
 * decides *whether two names are the same*, and must be aggressive or "Godspeed
 * You! Black Emperor" never matches "Godspeed You Black Emperor". Sending the
 * compare key as the query is how you search for "acdc" and find nothing.
 */

/**
 * Featured-artist trailers, in the forms tags actually carry them.
 *
 * Parenthesised first and then bare, because the bare pattern would otherwise
 * eat the opening bracket and leave a dangling one. `with` appears only in the
 * bracketed alternative on purpose: "Nick Cave with the Bad Seeds" is a credit,
 * but "The Kills with Alison Mosshart" is not a name anybody has, and the risk of
 * truncating a real name at a bare " with " is worse than the miss.
 *
 * `vs` and `&` are deliberately absent. "Simon & Garfunkel", "Godspeed You!
 * Black Emperor" and "Sunn O)))" are all one artist, and a rule that splits on a
 * conjunction turns the first of those into a search for "Simon".
 */
const FEATURED_PATTERNS: readonly RegExp[] = [
  /\s*[([{]\s*(?:feat|ft|featuring|with)\b[^)\]}]*[)\]}]\s*/giu,
  /\s+(?:feat|ft|featuring)\.?\s+.*$/iu
]

/**
 * Lucene's reserved characters, which MusicBrainz's search index parses.
 *
 * This is the punctuation half of R5 stated exactly: "Sunn O)))" sent raw is
 * three unbalanced closing parentheses and a query syntax error, which comes
 * back as a 400 and reads to the deck as a bug rather than as an artist. `&&`
 * and `||` are covered because each character is escaped individually.
 */
const LUCENE_RESERVED = /[+\-!(){}[\]^"~*?:\\/&|]/gu

/**
 * Everything to strip before comparing two names.
 *
 * `\p{P}` is punctuation and `\p{S}` is symbols — together they cover the
 * apostrophe in "Guns N' Roses", the exclamation mark in "Godspeed You!", the
 * slash in "AC/DC" and the parentheses in "Sunn O)))". Replaced with a space
 * rather than removed, so "AC/DC" and "AC DC" agree while "Sunn O)))" does not
 * silently become "sunno".
 */
const PUNCTUATION = /[\p{P}\p{S}]+/gu

/** Combining marks left behind by NFKD. Stripping them folds é onto e. */
const COMBINING_MARKS = /\p{M}+/gu

/** The one leading article worth dropping. See `compareKey`. */
const LEADING_THE = /^the\s+/u

/**
 * The name to search MusicBrainz for.
 *
 * Only two things happen: the featured-artist trailer comes off, and whitespace
 * is tidied. Nothing else — MusicBrainz's index knows about punctuation,
 * diacritics and articles far better than we do, and every character we remove
 * here is evidence taken away from a search that is going to be scored anyway.
 *
 * Returns the trimmed original when stripping would leave nothing, so a tag that
 * is *only* a feature credit still searches for something rather than for the
 * empty string.
 */
export function searchQuery(name: string): string {
  let query = name
  for (const pattern of FEATURED_PATTERNS) query = query.replace(pattern, ' ')
  query = query.replace(/\s+/gu, ' ').trim()
  return query === '' ? name.replace(/\s+/gu, ' ').trim() : query
}

/** Escapes a query for MusicBrainz's Lucene parser. */
export function escapeLucene(query: string): string {
  // eslint-disable-next-line oscine/no-windows-path-literals -- a Lucene escape, not a path separator
  return query.replace(LUCENE_RESERVED, (char) => `\\${char}`)
}

/**
 * The form two names are compared in.
 *
 * Casefolded, decomposed, stripped of marks and punctuation, whitespace
 * collapsed, leading "the" dropped. On a non-Latin name every one of those steps
 * except the last is either a no-op or a decomposition applied identically to
 * both sides, which is what makes "坂本龍一" and "Мумий Тролль" compare correctly
 * rather than compare to nothing.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: the latter reads the host's locale,
 * and a Turkish machine would casefold "I" to "ı" and stop matching "INXS". A
 * scoring rule whose answer depends on which laptop it ran on is not a rule.
 *
 * Only "the" is dropped, and only in English. MusicBrainz's own sort names use
 * the same convention ("Beatles, The"), the aliases we score against carry the
 * other languages' articles already, and a list of articles per language is a
 * way to turn the Spanish band "Los Lobos" into "lobos".
 */
export function compareKey(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

  const withoutArticle = folded.replace(LEADING_THE, '')
  // Guard against a name that *is* an article: "The The" keeps its head.
  return withoutArticle === '' ? folded : withoutArticle
}

/**
 * The cache key for a name search.
 *
 * The query actually sent, casefolded and whitespace-collapsed — and
 * deliberately *not* `compareKey`. A cache key is a claim that the stored reply
 * is the reply this request would get, and folding diacritics would let a hit on
 * "bjork" answer a request for "Björk" with results from a search that was never
 * run. Casefolding and whitespace are safe because MusicBrainz's index treats
 * them as equivalent itself.
 */
export function searchCacheKey(query: string): string {
  return query.replace(/\s+/gu, ' ').trim().toLowerCase()
}
