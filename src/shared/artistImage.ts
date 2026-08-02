import type { NetFailure } from './net'

/**
 * The artist photograph, as it crosses the boundary — **D14**'s images.
 *
 * ## Why the credit is data rather than a rendered line
 *
 * `biography.ts` makes this argument for CC BY-SA text and it is stronger here.
 * A Commons file is not under one licence: it is under whichever licence its
 * uploader chose, which may be CC BY 4.0, CC BY-SA 3.0, a public-domain mark, a
 * bespoke attribution string the photographer required, or two of those at once.
 * There is no constant to put in the component the way `WIKIPEDIA_LICENCE_NAME`
 * is a constant, so the licence has to travel *with the picture* — and the name
 * and the URL have to arrive separately, because naming a licence without
 * linking it is not attribution.
 *
 * ## Why the file name is here at all
 *
 * `file` is the picture's identity on Commons, and `descriptionUrl` is where its
 * full terms are published. Neither is decoration: an operator who wants to know
 * what they are looking at, or a licence that requires more than a short name
 * can carry, both end at the file page. It is the one link this type promises to
 * always have.
 *
 * ## Why the images are URLs and not a hash
 *
 * They are `fermata://artwork/<hash>/<variant>` routes into the same
 * content-addressed thumbnail cache album art uses, built in main exactly as
 * `TrackSummary.artwork` is. The renderer never learns the hash, because a hash
 * is a filesystem fact and the renderer does not have filesystem facts.
 */
export interface ArtistImageCredit {
  /**
   * The photographer or uploader, plain text with markup already removed.
   *
   * `null` when Commons records none, which happens — an old upload, a
   * public-domain scan, a file whose metadata was never filled in.
   */
  artist: string | null
  /**
   * The attribution line the uploader required, when they specified one.
   *
   * Wins over `artist` where both exist. A photographer who wrote "Photo by A.
   * N. Other / example.com" into the attribution field has stated the form the
   * licence obliges us to use, and composing our own from `artist` instead
   * would be substituting our preference for their condition.
   */
  attribution: string | null
  /** The short name — `CC BY-SA 4.0`, `Public domain`. `null` when unstated. */
  licence: string | null
  /** Where the licence is published. `null` for public-domain marks. */
  licenceUrl: string | null
  /** The Commons file description page. The one link that is always present. */
  descriptionUrl: string
}

export interface ArtistImage {
  /** The Wikidata item the photograph was claimed from. */
  entityId: string
  /** The Commons file name — `Kurt Cobain 1992.jpg`. Identity, not a URL. */
  file: string
  /** `fermata://artwork/<hash>/small` — 160px. */
  small: string
  /** `fermata://artwork/<hash>/large` — 640px. The one the deck renders. */
  large: string
  credit: ArtistImageCredit
}

/**
 * What the image lookup answers with.
 *
 * The same three outcomes as the biography, for the same reason and with one
 * more way of reaching `none`: no Wikidata item, an item with no P18 claim, a
 * Commons file that has since been deleted, or bytes the artwork processor
 * could not decode. All four are an artist with no picture, which is the
 * ordinary state of most of a library and not a thing to apologise for.
 */
export type ArtistImageStatus = 'ready' | 'none' | 'unavailable'

export interface ArtistImageResult {
  artistId: number
  status: ArtistImageStatus
  /** Present exactly when `status` is `ready`. */
  image: ArtistImage | null
  /** Present exactly when `status` is `unavailable`. */
  failure: NetFailure | null
}

export interface GetArtistImageRequest {
  artistId: number
}

/**
 * The widest thumbnail worth asking Commons for.
 *
 * It matches the artwork cache's `large` variant. Asking for the original would
 * mean downloading a 20 megapixel TIFF to produce a 640px WebP; asking for less
 * than 640 would mean upscaling one. Commons renders thumbnails on demand and
 * caches them, so this is also the cheap request rather than the polite one.
 */
export const ARTIST_IMAGE_WIDTH = 640
