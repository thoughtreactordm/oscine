/**
 * The second hop: an article title to its lead section, as plain text.
 *
 * ## The one rule this file exists to keep
 *
 * The card is absolute about it — *no unsanitised remote HTML reaches the
 * renderer under any circumstances* — and there are three independent reasons it
 * does not, which is the right number for a rule stated that way.
 *
 * First, the request asks for plain text. `explaintext=1` makes the extract
 * endpoint render its output as text rather than as the HTML it defaults to, so
 * markup does not arrive in the first place.
 *
 * Second, `toPlainText` strips tag-shaped runs anyway. That is a guard against a
 * changed default, a proxy that rewrites a parameter, and the `TextExtracts`
 * extension's own known habit of leaking the odd `<span>` out of a template it
 * could not flatten. It costs one regular expression per lookup and it is cached
 * afterwards.
 *
 * Third — and this is the one that actually matters — the pane interpolates the
 * string. Vue escapes interpolated text, and there is no `v-html` anywhere in
 * `src/renderer`; `tests/renderer/panels/noRemoteHtml.test.ts` asserts that as a
 * property of the tree rather than as a habit. Escaping is a stronger guarantee
 * than stripping, because stripping can be wrong and escaping cannot. The first
 * two exist so that a *correct-looking* extract is also a correct one.
 *
 * ## Why the lead section only
 *
 * `exintro=1` returns the text before the first heading, which for a biography
 * is the paragraph an encyclopaedia wrote to summarise the artist. The pane
 * truncates that further and offers an expand. Fetching the whole article to
 * show two hundred words of it would be several hundred kilobytes per artist
 * through a cache with a 64 MiB ceiling, to render nothing more.
 */

import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'

/** Every Wikimedia wiki serves its API from the same path. */
export const WIKIPEDIA_API_PATH = '/w/api.php'

/** The API root for one language's Wikipedia. */
export function wikipediaApi(lang: string): string {
  return `https://${lang}.wikipedia.org${WIKIPEDIA_API_PATH}`
}

/**
 * Removes tag-shaped runs and collapses what that leaves behind.
 *
 * Deliberately narrow: only `<` immediately followed by a letter, `/` or `!` is
 * treated as markup. `a < b` and "the 1970s <see below>" survive intact, because
 * a sanitiser that mangles legitimate prose to defend against markup that the
 * endpoint does not send is trading a certain harm for a hypothetical one.
 *
 * HTML entities are left alone. An extract containing a literal `&lt;script&gt;`
 * renders as those nine visible characters, which is correct — it is what the
 * article says. Decoding them here is the only way this function could
 * *introduce* the thing it exists to remove, so it does not.
 */
export function toPlainText(raw: string): string {
  return (
    raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?[a-zA-Z!][^>]*>/g, '')
      .replace(/\r\n?/g, '\n')
      // Paragraph breaks survive and everything else becomes one space. The
      // pane renders `\n\n` as a gap, so this is the difference between a
      // biography with paragraphs and a wall.
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      // Two at most. The extension leaves three or four where it dropped an
      // infobox or a hatnote, which reads as the text having been cut.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * The request for one article's intro.
 *
 * No length parameter. `exchars` cuts mid-word and `exsentences` is both capped
 * at ten and ignored by the extension whenever `exintro` is set, so the whole
 * lead comes back — one to four paragraphs, typically under 2 KB. The pane's own
 * truncation governs what is *shown*, and it can only offer an expand if there
 * is something to expand into. The ceiling is the net client's body cap.
 */
export function extractUrl(lang: string, title: string): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'extracts',
    explaintext: '1',
    exintro: '1',
    // Wikidata's sitelink is a page that may since have become a redirect. One
    // parameter is cheaper than a second request when it has.
    redirects: '1',
    titles: title
  })
  return `${wikipediaApi(lang)}?${params.toString()}`
}

/** The article title Wikipedia settled on, and the prose under it. */
export interface Extract {
  title: string
  text: string
}

/**
 * Reads the first page out of an extracts reply.
 *
 * `null` for a missing page, an empty extract, or a page that came back without
 * one. All three mean the same thing to the pane — there is no biography to show
 * — and all three are worth a negative cache entry rather than a retry.
 *
 * The title is taken from the reply rather than kept from the request, so that a
 * followed redirect attributes the article it actually landed on. Attribution
 * naming a page that redirects elsewhere is a small lie in a licence notice,
 * which is the wrong place to have one.
 */
export function parseExtract(body: unknown, fallbackTitle: string): Extract | null {
  const query = body as { query?: { pages?: unknown } } | null
  const pages = query?.query?.pages
  if (!Array.isArray(pages)) return null

  for (const entry of pages) {
    if (typeof entry !== 'object' || entry === null) continue
    const page = entry as Record<string, unknown>
    if (page.missing === true) continue

    const raw = typeof page.extract === 'string' ? toPlainText(page.extract) : ''
    if (raw === '') continue

    const title = typeof page.title === 'string' && page.title.trim() !== '' ? page.title : null
    return { title: title ?? fallbackTitle, text: raw }
  }
  return null
}

/**
 * Fetches one article's lead section.
 *
 * An article that exists with no usable extract becomes `not-found`, alongside
 * one that does not exist — the negative cache is the point, and a disambiguation
 * page whose intro the extension declines to render is as unshowable as a
 * missing page.
 */
export async function fetchExtract(
  client: NetClient,
  lang: string,
  title: string
): Promise<NetResult<Extract>> {
  const result = await client.getJson<unknown>({
    url: extractUrl(lang, title),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!result.ok) return result

  const extract = parseExtract(result.value, title)
  if (!extract) {
    return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
  }
  return netOk(extract)
}
