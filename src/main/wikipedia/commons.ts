/**
 * The third hop: a Commons file name to a thumbnail and the credit it owes.
 *
 * ## Why the credit comes from the same request as the URL
 *
 * Because a picture we cannot attribute is a picture we must not show. Commons
 * hosts files under licences that require naming the author and the licence, and
 * the acceptance for W7-13 says the attribution is displayed wherever the image
 * is — so fetching the bytes and the terms separately would create a window in
 * which the first had arrived and the second had not, and a component holding a
 * picture with no credit yet has only bad options. `prop=imageinfo` returns the
 * rendered thumbnail URL and `extmetadata` together, which closes the window by
 * not opening it: either both are known or neither is, and `fetchImageInfo`
 * fails rather than returning a picture it cannot label.
 *
 * ## Why the thumbnail and not the original
 *
 * `iiurlwidth` makes Commons render and cache a 640px version on its side. The
 * originals behind P18 claims are frequently 20 megapixel scans; downloading one
 * to produce a 640px WebP would spend tens of megabytes per artist against a
 * client that is a guest on Wikimedia's infrastructure, and R5's secondary risk
 * is about exactly that kind of impoliteness.
 *
 * ## No remote markup, again
 *
 * `extmetadata` values are HTML — the author field is very often an anchor, and
 * the credit is whatever prose the uploader typed into a wikitext template. The
 * same rule `extract.ts` states applies unchanged: it is stripped here, and the
 * pane interpolates the result rather than rendering it.
 */

import { ARTIST_IMAGE_WIDTH, type ArtistImageCredit } from '@shared/artistImage'
import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'
import { toPlainText, WIKIPEDIA_API_PATH } from './extract'

/** Commons is a MediaWiki like any other, on its own host. */
export const COMMONS_API = `https://commons.wikimedia.org${WIKIPEDIA_API_PATH}`

/**
 * The `extmetadata` fields worth asking for.
 *
 * Filtered rather than taken wholesale: the unfiltered block for a
 * well-described file is a couple of kilobytes of dates, categories, camera
 * settings and per-language descriptions, none of which is rendered.
 */
const METADATA_FIELDS = [
  'Artist',
  'Attribution',
  'AttributionRequired',
  'Credit',
  'LicenseShortName',
  'LicenseUrl'
] as const

/** What one Commons file yields. */
export interface CommonsImage {
  /** The rendered thumbnail, on `upload.wikimedia.org`. Where the bytes are. */
  thumbUrl: string
  credit: ArtistImageCredit
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * One `extmetadata` field, reduced to a line of text.
 *
 * Tags go first, through the same stripper the biography uses. The entity
 * decoding after it is deliberately partial and deliberately ordered: `&amp;`
 * is decoded *last*, so an `&amp;lt;` in the source becomes the visible text
 * `&lt;` rather than a `<` this function has just finished removing. `&lt;` and
 * `&gt;` themselves are never decoded, for the reason `toPlainText` gives.
 *
 * Newlines collapse to spaces because this is a credit rather than prose — a
 * two-line author field would push the popover open a row for no information.
 */
export function creditText(raw: string): string | null {
  const text = toPlainText(raw)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? null : text
}

export function imageInfoUrl(file: string, width: number = ARTIST_IMAGE_WIDTH): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'imageinfo',
    // P18 stores the bare name; the API wants the namespaced title. Prefixing
    // here rather than storing it prefixed keeps `ArtistImage.file` the thing
    // Wikidata actually said.
    titles: `File:${file}`,
    iiprop: 'url|mime|extmetadata',
    iiurlwidth: String(width),
    iiextmetadatafilter: METADATA_FIELDS.join('|'),
    // The licence short name is translated per language, and an English UI
    // showing "CC BY-SA 4.0" is what the rest of the attribution is written in.
    iiextmetadatalanguage: 'en'
  })
  return `${COMMONS_API}?${params.toString()}`
}

/**
 * Reads the one page out of an imageinfo reply.
 *
 * `null` covers every way there is nothing to show: the file was deleted or
 * renamed after Wikidata last saw it, the title resolved to something that is
 * not a file, or the reply carries no description page — which is the field the
 * credit is anchored to, so a file without one is a file we cannot attribute
 * and therefore cannot use.
 */
export function parseImageInfo(body: unknown): CommonsImage | null {
  const pages = asRecord(asRecord(body)?.query)?.pages
  if (!Array.isArray(pages) || pages.length === 0) return null

  const page = asRecord(pages[0])
  if (!page || page.missing === true) return null

  const info = Array.isArray(page.imageinfo) ? asRecord(page.imageinfo[0]) : null
  if (!info) return null

  // A P18 claim pointing at a PDF or an audio file is a Wikidata data problem,
  // and handing it to sharp is not how we would want to find out.
  const mime = asString(info.mime)
  if (!mime || !mime.startsWith('image/')) return null

  const descriptionUrl = asString(info.descriptionurl)
  if (!descriptionUrl) return null

  // `thumburl` is absent when the renderer could not produce a thumbnail. The
  // original is not a substitute — it is the multi-megabyte file this hop
  // exists to avoid — so that is a file we skip.
  const thumbUrl = asString(info.thumburl)
  if (!thumbUrl) return null

  const meta = asRecord(info.extmetadata)
  const field = (name: string): string | null => {
    const value = asString(asRecord(meta?.[name])?.value)
    return value === null ? null : creditText(value)
  }

  return {
    thumbUrl,
    credit: {
      artist: field('Artist'),
      attribution: field('Attribution'),
      licence: field('LicenseShortName'),
      // Not run through `creditText`: it is a URL, and a stripper that touches
      // it can only damage it.
      licenceUrl: asString(asRecord(meta?.LicenseUrl)?.value),
      descriptionUrl
    }
  }
}

/**
 * The thumbnail URL and credit for one Commons file.
 *
 * A file that cannot be attributed is `not-found` rather than a partial
 * success, which is the same shape as a file that is genuinely gone and gets the
 * same negative-cache treatment. Both mean the deck shows no picture, and the
 * difference between them is not one an operator can act on.
 */
export async function fetchImageInfo(
  client: NetClient,
  file: string,
  width: number = ARTIST_IMAGE_WIDTH
): Promise<NetResult<CommonsImage>> {
  const reply = await client.getJson<unknown>({
    url: imageInfoUrl(file, width),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!reply.ok) return reply

  const image = parseImageInfo(reply.value)
  if (image === null) {
    return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
  }
  return netOk(image)
}

/**
 * How large a rendered 640px thumbnail is allowed to be.
 *
 * Four mebibytes, matching Discover's ceiling in `trackFiles.ts`. A 640px JPEG
 * is a couple of hundred kilobytes; anything an order of magnitude past that is
 * not the thing we asked for, and the client's own default ceiling is sized for
 * a metadata document rather than a picture.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** The rendered thumbnail's bytes. Straight to the artwork processor. */
export function fetchImageBytes(
  client: NetClient,
  thumbUrl: string
): Promise<NetResult<Uint8Array>> {
  return client.getBytes({
    url: thumbUrl,
    scope: 'tunedeck',
    accept: 'image/*',
    maxBytes: MAX_IMAGE_BYTES
  })
}
