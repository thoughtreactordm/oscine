/**
 * Which Wikipedia to read, and in what order.
 *
 * ## Why there is a chain rather than a language
 *
 * The card's note is the whole of this file's reason to exist: "plenty of
 * Wikidata entries have no article in the user's language". A German operator
 * playing an American indie band will frequently find that the German article
 * does not exist while the English one runs to four paragraphs. Falling back to
 * English gives them a biography; refusing to gives them an empty pane and the
 * impression that the feature does not work.
 *
 * English is the fallback rather than "the biggest wiki that has one" because
 * choosing per artist would mean fetching the entity's whole sitelink table —
 * three hundred wikis for a well-known band — to pick between languages the
 * operator very likely cannot read. Two languages is a `sitefilter` of two, and
 * the second is the one Wikipedia itself has the most of.
 *
 * ## Why the locale is a parameter
 *
 * `app.getLocale()` is only meaningful after Electron's `ready`, and a module
 * that read it at import time would return `''` in a test and something
 * plausible in the app. Passing it in makes the chain a pure function of a
 * string, which is the only form of this worth testing.
 */

/** The wiki we fall back to when the operator's own has no article. */
export const FALLBACK_LANGUAGE = 'en'

/**
 * The language subtag of a BCP 47 locale.
 *
 * `pt-BR` and `zh-Hans-CN` both become their first subtag, because Wikipedia is
 * organised by language and not by region — there is no `pt-BR.wikipedia.org`,
 * and asking for one is a DNS failure rather than a fallback. `zh` is a real
 * simplification: `zh-Hant` speakers get the `zh` wiki, which is what a browser
 * would give them too.
 */
export function localeLanguage(locale: string): string | null {
  const subtag = locale.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  // Two or three letters, which is every ISO 639 code and no wiki that is not
  // one. The guard is against a malformed locale becoming a hostname: this
  // value is interpolated into `<lang>.wikipedia.org`, so anything that is not
  // plainly a language code must not reach it.
  return /^[a-z]{2,3}$/.test(subtag) ? subtag : null
}

/**
 * The languages to try, best first, without repeats.
 *
 * Always at least `['en']`: a locale we cannot parse is a reason to fall back,
 * not a reason to show nothing.
 */
export function articleLanguages(locale: string): readonly string[] {
  const preferred = localeLanguage(locale)
  if (preferred === null || preferred === FALLBACK_LANGUAGE) return [FALLBACK_LANGUAGE]
  return [preferred, FALLBACK_LANGUAGE]
}

/** The Wikidata site identifier for a language — `en` becomes `enwiki`. */
export function wikiSite(language: string): string {
  return `${language}wiki`
}
