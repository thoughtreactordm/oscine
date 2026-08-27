import type { ArtistLink, ArtistLinkCategory, ArtistLinksResult } from '@shared/artistLinks'

/**
 * The outbound links, flattened into one list of fixed-height rows.
 *
 * `relationRows.ts`' shape and the same standing invariant behind it: the pane
 * virtualizes one list of one row height, so a category heading is a row and a
 * link's host shares its row rather than wrapping. Pure functions in their own
 * module for that file's reason too — what this decides is what the deck *offers
 * to open*, and a test of that should not need a DOM and a Pinia instance to
 * assert on a hostname.
 */

/**
 * What each category calls itself.
 *
 * Nouns, `relationRows.ts`' rule: a heading in a 380px column is read as a label,
 * not a sentence. "Official site" rather than "Homepage" because it is the
 * artist's own front door as opposed to a platform's page for them, and that is
 * the distinction the ordering is built on.
 */
const CATEGORY_LABELS: Readonly<Record<ArtistLinkCategory, string>> = {
  homepage: 'Official site',
  bandcamp: 'Bandcamp',
  purchase: 'Buy',
  social: 'Social'
}

const CATEGORY_ICONS: Readonly<Record<ArtistLinkCategory, string>> = {
  homepage: 'i-tabler-world',
  bandcamp: 'i-tabler-brand-bandcamp',
  purchase: 'i-tabler-shopping-cart',
  social: 'i-tabler-share'
}

export type LinkRow =
  | {
      kind: 'header'
      key: string
      category: ArtistLinkCategory
      label: string
      icon: string
      /** How many links follow. Never a `+`: the cap is reported by the pane, once. */
      count: number
    }
  | {
      kind: 'link'
      key: string
      link: ArtistLink
      /** The host, as the row leads with it — `bandcamp.com`, `instagram.com`. */
      label: string
    }

/**
 * The host a URL points at, for the row to lead with.
 *
 * The host and not the whole URL, because the host is the part that says *where*:
 * `instagram.com` names the network, and a Bandcamp artist's own subdomain
 * already distinguishes them from the next. `www.` is dropped as noise. Derived
 * rather than carried from main, and derived rather than looked up against a
 * per-service name table, because a table of "twitter.com → Twitter" is a thing
 * that goes stale the week a network renames itself — the host is what the URL
 * actually says, and it cannot drift from it.
 *
 * The URL arrived validated as http/https from main, so `new URL` cannot throw
 * here; the guard is defensive rather than expected, and falls back to the raw
 * string so a row is never blank.
 */
export function linkLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./u, '')
  } catch {
    return url
  }
}

/**
 * What a shut group puts on its header.
 *
 * The number of links, plainly — unlike the relations badge, which counts what
 * you *own* rather than what MusicBrainz knows, because there is no library half
 * here to make one number more useful than the other. A homepage is a homepage.
 *
 * `null` rather than `'0'` for nothing, matching its siblings: the absence
 * already says it, and a zero is noisier than a bare heading.
 */
export function countLinks(result: ArtistLinksResult | null): string | null {
  if (result === null) return null
  const total = result.links.length
  return total === 0 ? null : total.toLocaleString()
}

/**
 * The rows, in the order main sorted them.
 *
 * Category boundaries are read off the sequence rather than imposed on it: main
 * has already ordered the links by category and then URL, so walking the list and
 * emitting a heading whenever the category changes produces the grouping without
 * this file holding a second opinion about the order. Two files sorting the same
 * list is how a heading ends up over the wrong rows.
 */
export function buildLinkRows(result: ArtistLinksResult | null): LinkRow[] {
  if (result === null || result.status !== 'ready') return []

  const rows: LinkRow[] = []
  let category: ArtistLinkCategory | null = null
  let header: Extract<LinkRow, { kind: 'header' }> | null = null

  for (const link of result.links) {
    if (link.category !== category) {
      category = link.category
      header = {
        kind: 'header',
        key: `header:${category}`,
        category,
        label: CATEGORY_LABELS[category],
        icon: CATEGORY_ICONS[category],
        count: 0
      }
      rows.push(header)
    }

    if (header) header.count++

    rows.push({
      kind: 'link',
      // Keyed by URL, which is unique after main's dedupe.
      key: `link:${link.url}`,
      link,
      label: linkLabel(link.url)
    })
  }

  return rows
}
