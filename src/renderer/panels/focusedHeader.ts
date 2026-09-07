/**
 * When the Songs panel is looking at one thing, and what it should say about it.
 *
 * A focused header is for a *singular* browse source: one genre/tag, one artist,
 * or one album. Multi-selects, a search, a folder, or the unfiltered library are
 * not a source with a name — they stay the compact "Songs" chrome. The tightest
 * dimension wins, so one album under one artist is an album header, and two
 * albums under one artist is not a header at all.
 *
 * Lives in a module rather than in the Vue file for `signalReadout.ts`'s reason:
 * the branch order is the part with a rule in it, and a `.vue` file cannot be
 * imported under a Vitest with no Vue plugin.
 */

/** How many of an artist's tags the header will draw. The rest live in the deck. */
export const MAX_FOCUS_TAGS = 8

export type FocusKind = 'genre' | 'artist' | 'album'

/**
 * The three browse dimensions, as the filter they currently contribute.
 *
 * `undefined` is "no constraint" — the pane has nothing selected. An array is
 * the selected identities, and its length is what this module decides on.
 */
export interface BrowseFocus {
  readonly albumIds: readonly number[] | undefined
  readonly artistIds: readonly number[] | undefined
  readonly tagKeys: readonly string[] | undefined
}

/**
 * The tightest singular source, or `null` when the list is not about one thing.
 *
 * Albums first, then artists, then genres: each pane narrows the one above it,
 * so the lowest dimension with a selection is what the song list is actually
 * showing. A length other than one at that level is a multi-select, and a
 * multi-select has no single name to head with.
 */
export function focusKind(browse: BrowseFocus): FocusKind | null {
  const albums = browse.albumIds?.length ?? 0
  if (albums === 1) return 'album'
  if (albums > 1) return null

  const artists = browse.artistIds?.length ?? 0
  if (artists === 1) return 'artist'
  if (artists > 1) return null

  const tags = browse.tagKeys?.length ?? 0
  if (tags === 1) return 'genre'
  return null
}

export function tracksLabel(count: number): string {
  return count === 1 ? '1 track' : `${count.toLocaleString()} tracks`
}

export function albumsLabel(count: number): string {
  return count === 1 ? '1 album' : `${count.toLocaleString()} albums`
}

/**
 * Where a genre/tag row comes from, in the same split the Tunedeck Tags pane
 * uses — file vocabulary, the operator's own, or both.
 *
 * `null` rather than a sentence when neither flag is set: that is a row that
 * should not exist, and inventing an origin for it would be a caption on a bug.
 */
export function genreOrigin(facet: { hasFile: boolean; hasUser: boolean }): string | null {
  if (facet.hasFile && facet.hasUser) return 'From files and your tags'
  if (facet.hasFile) return 'From files'
  if (facet.hasUser) return 'Your tag'
  return null
}

function joinMeta(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => !!part && part.length > 0).join(' · ')
}

export function artistDetail(input: {
  albumCount: number | null
  trackCount: number | null
}): string {
  return joinMeta([
    input.albumCount !== null && input.albumCount > 0 ? albumsLabel(input.albumCount) : null,
    input.trackCount !== null ? tracksLabel(input.trackCount) : null
  ])
}

export function albumDetail(input: {
  albumArtist: string | null
  year: number | null
  trackCount: number | null
}): string {
  return joinMeta([
    input.albumArtist,
    input.year !== null ? String(input.year) : null,
    input.trackCount !== null ? tracksLabel(input.trackCount) : null
  ])
}

export function genreDetail(input: {
  hasFile: boolean
  hasUser: boolean
  trackCount: number | null
}): string {
  return joinMeta([
    genreOrigin(input),
    input.trackCount !== null ? tracksLabel(input.trackCount) : null
  ])
}
