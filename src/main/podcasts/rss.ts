/* eslint-disable oscine/no-windows-path-literals -- regex metacharacter escapes, not filesystem paths */

/**
 * Minimal podcast RSS parser.
 *
 * Enough of RSS 2.0 + the itunes namespace for subscribe/refresh. Tags we do
 * not understand are ignored — that is how Podcasting 2.0 stays backward
 * compatible, and how this file stays small.
 *
 * No XML dependency: feeds in the wild are messy, and a purpose-built extractor
 * with tests beats pulling a general parser for five tags.
 */

export interface ParsedFeedEpisode {
  guid: string
  title: string
  description: string | null
  pubDateMs: number | null
  durationMs: number | null
  enclosureUrl: string
  enclosureType: string | null
  enclosureSize: number | null
}

export interface ParsedFeed {
  title: string
  author: string | null
  description: string | null
  siteUrl: string | null
  artworkUrl: string | null
  episodes: ParsedFeedEpisode[]
}

export class RssParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RssParseError'
  }
}

export function parsePodcastRss(xml: string): ParsedFeed {
  const channel = firstTag(xml, 'channel')
  if (channel === null) {
    throw new RssParseError('This does not look like a podcast feed (no channel).')
  }

  const title = textContent(channel, 'title')?.trim()
  if (!title) {
    throw new RssParseError('This feed has no title.')
  }

  const author =
    textContent(channel, 'itunes:author') ??
    textContent(channel, 'author') ??
    textContent(channel, 'managingEditor')

  const description = textContent(channel, 'description') ?? textContent(channel, 'itunes:summary')

  const siteUrl = firstHttpHref(channel) ?? textContent(channel, 'link')

  const imageBlock = firstTag(channel, 'image')
  const artworkUrl =
    attrInTag(channel, 'itunes:image', 'href') ??
    (imageBlock ? textContent(imageBlock, 'url') : null)

  const episodes: ParsedFeedEpisode[] = []
  for (const item of allTags(channel, 'item')) {
    const enclosureUrl = attrInTag(item, 'enclosure', 'url')
    if (!enclosureUrl || !/^https?:\/\//i.test(enclosureUrl)) continue

    const itemTitle = textContent(item, 'title')?.trim() || 'Untitled episode'
    const guid =
      textContent(item, 'guid')?.trim() ||
      enclosureUrl ||
      `${itemTitle}:${textContent(item, 'pubDate') ?? ''}`

    const enclosureType = attrInTag(item, 'enclosure', 'type')
    const lengthRaw = attrInTag(item, 'enclosure', 'length')
    const enclosureSize = lengthRaw && /^\d+$/.test(lengthRaw) ? Number(lengthRaw) : null

    const pubDateRaw = textContent(item, 'pubDate')
    const pubParsed = pubDateRaw ? Date.parse(pubDateRaw) : Number.NaN
    const pubDateMs = Number.isFinite(pubParsed) ? pubParsed : null

    episodes.push({
      guid,
      title: itemTitle,
      description: textContent(item, 'description') ?? textContent(item, 'itunes:summary'),
      pubDateMs,
      durationMs: parseItunesDuration(textContent(item, 'itunes:duration')),
      enclosureUrl,
      enclosureType,
      enclosureSize
    })
  }

  if (episodes.length === 0) {
    throw new RssParseError('This feed has no downloadable episodes.')
  }

  return {
    title,
    author: author?.trim() || null,
    description: description?.trim() || null,
    siteUrl: siteUrl?.trim() || null,
    artworkUrl: artworkUrl?.trim() || null,
    episodes
  }
}

/** itunes:duration is seconds, or H:MM:SS / M:SS. */
export function parseItunesDuration(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim()
  if (value === '') return null
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000)
  }
  const parts = value.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    return Math.round(((hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0)) * 1000)
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts
    return Math.round(((minutes ?? 0) * 60 + (seconds ?? 0)) * 1000)
  }
  return null
}

function firstTag(xml: string, name: string): string | null {
  const re = new RegExp(`<${escapeName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}>`, 'i')
  const match = re.exec(xml)
  return match?.[1] ?? null
}

function allTags(xml: string, name: string): string[] {
  const re = new RegExp(
    `<${escapeName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}>`,
    'gi'
  )
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    if (match[1] !== undefined) out.push(match[1])
  }
  return out
}

function textContent(scope: string, name: string): string | null {
  const cdata = new RegExp(
    `<${escapeName(name)}(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escapeName(name)}>`,
    'i'
  )
  const cdataMatch = cdata.exec(scope)
  if (cdataMatch?.[1] !== undefined) {
    return decodeEntities(stripTags(cdataMatch[1]).trim())
  }

  const plain = new RegExp(
    `<${escapeName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}>`,
    'i'
  )
  const match = plain.exec(scope)
  if (match?.[1] === undefined) return null
  return decodeEntities(stripTags(match[1]).trim())
}

function attrInTag(xml: string, name: string, attr: string): string | null {
  const re = new RegExp(`<${escapeName(name)}\\b([^>]*?)\\/?>`, 'i')
  const match = re.exec(xml)
  if (match?.[1] === undefined) return null
  const attrs = match[1]
  const quoted = new RegExp(`${escapeName(attr)}\\s*=\\s*["']([^"']+)["']`, 'i')
  const value = quoted.exec(attrs)
  return value?.[1] ? decodeEntities(value[1]) : null
}

/** Prefer the channel's HTML link over atom self-links. */
function firstHttpHref(channel: string): string | null {
  const links = allTags(channel, 'link')
  for (const link of links) {
    const trimmed = stripTags(link).trim()
    if (/^https?:\/\//i.test(trimmed)) return decodeEntities(trimmed)
  }
  // Self-closing / attribute form: <link href="…"/>
  const href = attrInTag(channel, 'link', 'href')
  if (href && /^https?:\/\//i.test(href)) return href
  return null
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
