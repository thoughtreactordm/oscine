/**
 * The edit-time album-art picker's main-process half — **W7-17**.
 *
 * Two operations behind two IPC channels, for tracks already in the library:
 *
 * - **search** an artist and album across the network and return cover
 *   candidates as references (URLs, never bytes). An indexed track carries no
 *   release MBID, so this cannot go straight to the Cover Art Archive: it runs a
 *   MusicBrainz release-group search first, resolves each match's front through
 *   the CAA, and adds iTunes album covers as the fallback for releases
 *   MusicBrainz does not have.
 * - **apply** the one the operator picked: re-check its URL against the source
 *   allowlist, pull the full-resolution bytes, and hand them to the ordinary
 *   `setCover` ingest — the same door a file pick uses, so the result is an
 *   override indistinguishable from one, keyed on the same `artworkHash`.
 *
 * Everything rides the `cover-art` scope (the MusicBrainz and iTunes searches
 * here, the CAA and image fetches inside the injected client), so closing the
 * picker cancels in-flight lookups and D14's consent gate is checked at every
 * socket by construction. No consent check lives in this module.
 */

import { sniffImageMime, type ArtworkRef, type CoverArtCandidate } from '@shared/artwork'
import { OscineError } from '@shared/errors'
import { isCatalogArtworkHost } from '@shared/ipc'
import type { CoverArtArchiveClient } from './coverArtArchive'
import { searchItunesAlbumCovers } from './itunesAlbums'
import { searchReleaseGroupCandidates } from '../musicbrainz/releaseGroups'
import type { NetClient } from '../net'

/**
 * How many release groups to resolve a cover for.
 *
 * Each is a fetch to `coverartarchive.org`, and the per-host limiter serialises
 * them, so this is a wall-clock budget as much as a result count: five is enough
 * to cover an album's editions without making the operator wait through a dozen
 * one-second-spaced lookups, most of which 404.
 */
const RELEASE_GROUP_COVER_LIMIT = 5

export interface CoverSearchService {
  /** Cover candidates for an artist + album, MusicBrainz first then iTunes. */
  search(artist: string, album: string): Promise<CoverArtCandidate[]>
  /** Applies a picked candidate's bytes as a durable override on the tracks. */
  applyRemoteCover(trackIds: readonly number[], url: string): Promise<ArtworkRef>
}

export interface CoverSearchServiceOptions {
  client: NetClient
  coverArt: CoverArtArchiveClient
  /**
   * The ingest sink — `LibraryService.setArtworkFromBytes` bound. Takes the same
   * bytes a file pick would and produces the same override; the `mime` is
   * advisory and re-sniffed inside, so a network cover and a file cover with
   * identical bytes are one override.
   */
  setCover: (trackIds: readonly number[], bytes: Uint8Array, mime: string) => Promise<ArtworkRef>
}

/** Upgrades a candidate URL to https so the renderer's preview proxy accepts it. */
function toHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url
}

/** A CAA candidate carried out of the client with the release group's captions attached. */
function withCaptions(
  candidate: CoverArtCandidate,
  title: string,
  detail: string | null
): CoverArtCandidate {
  return {
    ...candidate,
    thumbUrl: toHttps(candidate.thumbUrl),
    fullUrl: toHttps(candidate.fullUrl),
    title,
    detail: detail ?? undefined
  }
}

export function createCoverSearchService({
  client,
  coverArt,
  setCover
}: CoverSearchServiceOptions): CoverSearchService {
  /**
   * The MusicBrainz → Cover Art Archive hop: find release groups, resolve the
   * front of the top few. One candidate per release group (its front), captioned
   * with the release-group title and disambiguation so editions stay legible.
   */
  async function coverArtArchiveCandidates(
    artist: string,
    album: string
  ): Promise<CoverArtCandidate[]> {
    const groups = await searchReleaseGroupCandidates(client, artist, album)
    if (!groups.ok || groups.value.length === 0) return []
    const top = groups.value.slice(0, RELEASE_GROUP_COVER_LIMIT)
    const resolved = await Promise.all(
      top.map(async (group) => {
        const front = await coverArt.releaseGroupFront(group.mbid)
        if (!front.ok || front.value.length === 0) return null
        // `parseManifest` already sorts front covers first, so the head is the
        // release group's representative cover.
        return withCaptions(front.value[0], group.title, group.artist ?? group.detail)
      })
    )
    return resolved.filter((candidate): candidate is CoverArtCandidate => candidate !== null)
  }

  return {
    async search(artist, album): Promise<CoverArtCandidate[]> {
      // Both sources run concurrently: they hit different hosts, so neither waits
      // on the other's rate limiter, and the picker fills as soon as both answer.
      const [caa, itunes] = await Promise.all([
        coverArtArchiveCandidates(artist, album),
        searchItunesAlbumCovers(client, artist, album)
      ])
      return [...caa, ...(itunes.ok ? itunes.value : [])]
    },

    async applyRemoteCover(trackIds, url): Promise<ArtworkRef> {
      let target: URL
      try {
        target = new URL(url)
      } catch {
        throw new OscineError('invalid-request', 'That is not a cover address.')
      }
      // The renderer only ever hands back a URL this service itself returned, but
      // it is the process holding the socket, so this is the check that actually
      // constrains where the fetch points — the same allowlist the preview proxy
      // re-checks. Without it the channel is an open image proxy.
      if (target.protocol !== 'https:' || !isCatalogArtworkHost(target.hostname)) {
        throw new OscineError('invalid-request', 'That cover is not from an allowed source.')
      }
      const bytes = await coverArt.fetchImageBytes(target.toString())
      if (!bytes.ok) {
        throw new OscineError('io-error', 'That cover could not be fetched.')
      }
      // The declared mime is advisory — `setCover` re-sniffs — but sniffing here
      // lets an unusable body (a redirect page, an SVG) fail before the store.
      const mime = sniffImageMime(bytes.value)
      if (!mime) {
        throw new OscineError('invalid-request', 'That cover is not a JPEG or PNG image.')
      }
      return setCover(trackIds, bytes.value, mime)
    }
  }
}
