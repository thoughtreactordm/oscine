/* eslint-disable oscine/no-windows-path-literals -- regex metacharacter escapes, not filesystem paths */

/**
 * OPML subscription list import.
 *
 * Only outline nodes with a `xmlUrl` (or `xmlurl`) are subscriptions. Nested
 * folders are walked; folder titles are ignored — Oscine's subscription list
 * is flat for this slice.
 */

export interface OpmlOutline {
  title: string | null
  feedUrl: string
}

export function parseOpml(xml: string): OpmlOutline[] {
  const outlines: OpmlOutline[] = []
  const re = /<outline\b([^>]*?)\s*\/?>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1] ?? ''
    const feedUrl = attr(attrs, 'xmlUrl') ?? attr(attrs, 'xmlurl')
    if (!feedUrl || !/^https?:\/\//i.test(feedUrl)) continue
    const title = attr(attrs, 'title') ?? attr(attrs, 'text')
    outlines.push({ title: title?.trim() || null, feedUrl: feedUrl.trim() })
  }
  return outlines
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(
    `${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*["']([^"']+)["']`,
    'i'
  )
  const match = re.exec(attrs)
  if (match?.[1] === undefined) return null
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}
