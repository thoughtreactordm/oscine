/**
 * Presence's album-art tier: a track's tags → a public cover URL — **W20-5**.
 *
 * The one part of the Discord stream that reaches the network, and so the one
 * part inside D14's gate. Discord's `large_image` renders either a static asset
 * key or a public URL its media proxy fetches — never a local file or an
 * `oscine://` URL (the wall MPRIS hit) — so the only real cover presence can ever
 * show is the *canonical release* art, resolved to a public URL. The operator's
 * own embedded/local artwork stays out of scope; publishing it is a hosting and a
 * privacy problem this stream will not take on.
 *
 * ## A client over W7's layer, not a second HTTP stack
 *
 * Every request rides `NetClient` — so the identifying User-Agent, the per-host
 * rate limiter and D14's consent gate all come free and are checked at the
 * socket by construction. There is deliberately no consent check in this module:
 * with lookups off, `NetClient` returns `declined` without opening a socket, this
 * resolver returns `null`, and the service keeps the logo. The *decision to
 * attempt a lookup at all* is the service's, gated on `discord.showAlbumArt`
 * (`coverArtEligible`); this module is only reached once that says yes.
 *
 * ## Two hops, two caches, keyed to keep a mistag from poisoning a neighbour
 *
 * An indexed track carries no MBID, so the resolution is:
 *
 *  1. **tags → release-group MBID.** A MusicBrainz release-group search on the
 *     album-artist and album. Cached under `discord.release-match`, keyed on the
 *     (normalised) free-text tags — which is unavoidable, it is a search — and
 *     negative-cached so an album MusicBrainz cannot match costs one search a
 *     week rather than one per play.
 *  2. **MBID → public front URL.** The Cover Art Archive manifest for that
 *     release group, cached under `coverartarchive.cover` keyed on the *MBID*
 *     (shared with the edit-time picker) and negative-cached for a release with
 *     no front. Because this cache is keyed on the identity rather than the tag,
 *     a mistagged track can only ever mis-resolve its own cover, never a
 *     neighbour's.
 *
 * Both hops run on the `discord` scope, so a rapid skip's `cancelScope('discord')`
 * abandons whichever is in flight.
 *
 * ## Where the URL goes
 *
 * The service slots the returned URL straight into the activity's asset-key field
 * `assets.large_image`, replacing the logo key: over the hand-rolled local IPC
 * `SET_ACTIVITY` path Discord fetches a raw URL from `large_image` through its own
 * media proxy, while `large_url` (a client-library / newer-API field nothing here
 * translates) is silently ignored. That is the wall this tier actually had to
 * clear. When the cover shows, the logo moves to the `small_image` badge.
 */

import { type CoverArtCandidate } from '@shared/artwork'
import { netFailed, netOk, type NetResult, type NetScope } from '@shared/net'
import type { PresenceTrack } from '@shared/presence'
import type { CacheService } from '../cache'
import type { CacheEntity } from '../cache/policy'
import type { NetClient } from '../net'
import { fetchReleaseGroupFront, releaseGroupCacheKey } from '../artwork/coverArtArchive'
import {
  parseReleaseGroupCandidates,
  releaseGroupQuery,
  releaseGroupSearchUrl
} from '../musicbrainz/releaseGroups'

/** Every request here enrols in the presence scope, so a skip cancels it. */
const DISCORD_SCOPE: NetScope = 'discord'

/** tags → release-group MBID. */
const MATCH_ENTITY: CacheEntity = 'discord.release-match'

/** MBID → CAA manifest — the entity the edit-time picker already fills. */
const COVER_ENTITY: CacheEntity = 'coverartarchive.cover'

/** Phrased exactly as the client and cache phrase it, so a cached miss matches. */
const NOT_FOUND = { kind: 'not-found', message: 'The service has nothing for this.' } as const

export interface PresenceArtworkResolver {
  /**
   * The public cover URL for a track, or `null` when there is none to show —
   * lookups off, no album/artist tag, no MusicBrainz match, or the release has no
   * Cover Art Archive front. Never throws: every failure resolves to `null` so
   * the caller falls back to the logo.
   */
  resolve(track: PresenceTrack): Promise<string | null>
}

export interface PresenceArtworkResolverDeps {
  client: NetClient
  cache: CacheService
}

/** Upgrade a CAA/archive.org URL to https so Discord's media proxy will fetch it. */
function toHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url
}

/** The normalised search key: casefolded, whitespace-collapsed album-artist + album. */
function matchKey(artist: string, album: string): string {
  const norm = (value: string): string => value.replace(/\s+/gu, ' ').trim().toLowerCase()
  return `${norm(artist)}|${norm(album)}`
}

/**
 * The MusicBrainz hop, as a fetch `cache.through` can remember: the best
 * release-group MBID for these tags, or `not-found` when nothing matches so the
 * miss is negative-cached rather than re-asked every play.
 */
async function fetchTopReleaseGroupMbid(
  client: NetClient,
  artist: string,
  album: string
): Promise<NetResult<string>> {
  const query = releaseGroupQuery(artist, [album])
  if (query === null) return netFailed(NOT_FOUND)

  const result = await client.getJson<unknown>({
    url: releaseGroupSearchUrl(query),
    scope: DISCORD_SCOPE,
    accept: 'application/json'
  })
  if (!result.ok) return result

  // `parseReleaseGroupCandidates` returns them best-score-first, so the head is
  // MusicBrainz's top match for the album.
  const candidates = parseReleaseGroupCandidates(result.value)
  if (candidates.length === 0) return netFailed(NOT_FOUND)
  return netOk(candidates[0].mbid)
}

/** The front cover of a release group's manifest, front-first, or `null`. */
function pickFront(candidates: readonly CoverArtCandidate[]): CoverArtCandidate | null {
  // `parseManifest` already sorts fronts first, so the head is the front when
  // there is one; an empty list (a manifest with no usable image) yields null.
  return candidates[0] ?? null
}

export function createPresenceArtworkResolver({
  client,
  cache
}: PresenceArtworkResolverDeps): PresenceArtworkResolver {
  return {
    async resolve(track): Promise<string | null> {
      // Prefer the album artist: it is the release's credit, so a compilation's
      // per-track artist does not send the search chasing the wrong record.
      const artist = (track.albumArtist ?? track.artist)?.trim()
      const album = track.album?.trim()
      if (!artist || !album) return null

      const match = await cache.through(MATCH_ENTITY, matchKey(artist, album), () =>
        fetchTopReleaseGroupMbid(client, artist, album)
      )
      if (!match.ok) return null

      const mbid = match.value
      const front = await cache.through(COVER_ENTITY, releaseGroupCacheKey(mbid), () =>
        fetchReleaseGroupFront(client, mbid, DISCORD_SCOPE)
      )
      if (!front.ok) return null

      const cover = pickFront(front.value)
      // The bounded ~500px thumbnail, not the full image: Discord renders the
      // presence art small and its media proxy is happier with a modest file than
      // a multi-megabyte front. Falls back to the full image if no thumb is named.
      return cover ? toHttps(cover.thumbUrl || cover.fullUrl) : null
    }
  }
}
