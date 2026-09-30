import {
  computeDiscId,
  manualDiscProposal,
  type CdToc,
  type DiscLookupResult,
  type DiscMetadataProposal
} from '@shared/cdrip'
import { isMbid } from '@shared/artist'
import { netFailed, netOk } from '@shared/net'
import type { NetClient } from '../net'
import type { CacheService } from '../cache/service'
import { MUSICBRAINZ_WS } from '../musicbrainz/search'
import { parseCdText } from './cdText'

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const string = (value: unknown): string => (typeof value === 'string' ? value : '')
function credit(value: unknown): string {
  return array(value)
    .map((v) => {
      const c = record(v)
      return (string(c.name) || string(record(c.artist).name)) + string(c.joinphrase)
    })
    .join('')
}

export function discLookupUrl(discId: string): string {
  return `${MUSICBRAINZ_WS}/discid/${encodeURIComponent(discId)}?inc=recordings+artist-credits+release-groups&fmt=json`
}

/** Matching medium only, audio tracks only. Rank by completeness, then date and MBID. Never select. */
export function parseDiscReleases(
  body: unknown,
  discId: string,
  toc: CdToc
): DiscMetadataProposal[] {
  const candidates: DiscMetadataProposal[] = []
  const seen = new Set<string>()
  for (const value of array(record(body).releases)) {
    const release = record(value),
      mbid = string(release.id)
    if (!isMbid(mbid) || !string(release.title).trim() || seen.has(mbid)) continue
    const medium = array(release.media)
      .map(record)
      .find((m) => array(m.discs).some((d) => record(d).id === discId))
    if (!medium) continue
    const rawTracks = array(medium.tracks).map(record)
    const proposal = manualDiscProposal(toc)
    proposal.source = 'musicbrainz'
    proposal.releaseMbid = mbid
    proposal.album = string(release.title)
    proposal.albumArtist = credit(release['artist-credit'])
    const date =
      string(release.date) || string(record(release['release-group'])['first-release-date'])
    proposal.year =
      /^\d{4}(?:-|$)/.test(date) && Number(date.slice(0, 4)) > 0 ? Number(date.slice(0, 4)) : null
    const country = string(release.country)
    if (country) proposal.country = country
    const format = string(medium.format)
    if (format) proposal.format = format
    let matches = true
    for (const track of proposal.tracks) {
      const raw = rawTracks.find((t) => t.position === track.number)
      if (!raw) {
        matches = false
        break
      }
      const recording = record(raw.recording)
      track.title = string(raw.title) || string(recording.title)
      track.artist =
        credit(raw['artist-credit']) || credit(recording['artist-credit']) || proposal.albumArtist
      if (isMbid(string(recording.id))) track.recordingMbid = string(recording.id)
    }
    if (!matches) continue
    seen.add(mbid)
    candidates.push(proposal)
  }
  const completeness = (p: DiscMetadataProposal): number =>
    Number(!!p.albumArtist) +
    p.tracks.reduce((n, t) => n + Number(!!t.title) + Number(!!t.artist), 0)
  return candidates.sort(
    (a, b) =>
      completeness(b) - completeness(a) ||
      (a.year ?? Infinity) - (b.year ?? Infinity) ||
      a.releaseMbid!.localeCompare(b.releaseMbid!)
  )
}

export interface DiscLookup {
  lookup(toc: CdToc): Promise<DiscLookupResult>
}

/** No library writes or release decisions. The caller can edit manualDiscProposal immediately. */
export function createDiscLookup({
  client,
  cache
}: {
  client: NetClient
  cache: CacheService
}): DiscLookup {
  return {
    async lookup(toc) {
      const discId = computeDiscId(toc)
      const result = await cache.through<DiscMetadataProposal[]>(
        'musicbrainz.disc',
        discId,
        async () => {
          const reply = await client.getJson<unknown>({
            url: discLookupUrl(discId),
            scope: 'cdrip',
            accept: 'application/json'
          })
          if (!reply.ok) return reply
          if (!Array.isArray(record(reply.value).releases))
            return netFailed({ kind: 'malformed', message: 'Invalid disc lookup response.' })
          const candidates = parseDiscReleases(reply.value, discId, toc)
          return candidates.length
            ? netOk(candidates)
            : netFailed({ kind: 'not-found', message: 'No matching releases.' })
        }
      )
      return {
        discId,
        candidates:
          result.ok && result.value.length
            ? result.value
            : [parseCdText(toc) ?? manualDiscProposal(toc)]
      }
    }
  }
}
