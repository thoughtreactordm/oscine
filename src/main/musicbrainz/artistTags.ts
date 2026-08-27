/**
 * The MusicBrainz artist document, read for its genres and folksonomy tags.
 *
 * One lookup against `/artist/{mbid}?inc=genres+tags`, a *lookup* and not a
 * search for `relations.ts`' reason: the identifier is one R5 already settled, so
 * nothing here re-decides who the artist is. It is a different `inc` from the
 * relations/links document, and so a different cache entity — see
 * `musicbrainz.artist-tags` in `cache/policy.ts` — rather than the same payload
 * fetched a second way.
 *
 * ## Two lists, one vocabulary
 *
 * MusicBrainz keeps `genres` and `tags` as separate arrays, but a genre *is* a
 * tag the community has promoted to the curated genre list — so "rock" routinely
 * appears in both, with a vote `count` in each. This folds them into one list
 * keyed by the same casefold the rest of the tag layer uses (`normalizeLabel`),
 * so a genre and its twin tag are one suggestion carrying the larger of the two
 * weights rather than two chips for one idea.
 *
 * Everything is parsed defensively, for `relations.ts`' reason: this is a JSON
 * document from a service we do not control, and one malformed entry out of forty
 * must cost that entry rather than the whole suggestion list.
 */

import { normalizeLabel } from '@shared/genre'
import { isMbid } from '@shared/artist'
import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'
import { MUSICBRAINZ_WS } from './search'

/**
 * What the lookup asks for, and the half of the cache key that is not the MBID.
 *
 * `genres+tags` alone. The same endpoint answers `artist-rels`/`url-rels` for the
 * relations and links panes, and asking for those here would make this pay for
 * their payload on every track change — the same reasoning `ARTIST_RELATIONS_INC`
 * gives, from the other side. Naming the `inc` in the cache key is what keeps the
 * three documents from being stored as one.
 */
export const ARTIST_TAGS_INC = 'genres+tags'

/** One vote-weighted label out of the document, before dedup against the track. */
export interface WeightedTag {
  /** The grouping identity, shared with file genres and user tags. */
  key: string
  /** The display spelling, as MusicBrainz first offered it. */
  label: string
  /** MusicBrainz's net vote weight. Always positive here — see `parseArtistTags`. */
  count: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Reads one `{ name, count }` array into the accumulator, keyed on the shared
 * casefold and keeping the larger weight when a key is seen twice.
 *
 * `genres` is read before `tags` so a label present in both keeps the genre's
 * spelling, which is the curated one. A non-positive count is dropped: MB's
 * `count` is the *net* of up and down votes, and a tag the crowd voted down is
 * not a label to offer as one to adopt.
 */
function collect(raw: unknown, into: Map<string, WeightedTag>): void {
  if (!Array.isArray(raw)) return
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue

    const norm = normalizeLabel(typeof record.name === 'string' ? record.name : null)
    if (norm === null) continue

    const count = typeof record.count === 'number' ? record.count : 0
    if (count <= 0) continue

    const existing = into.get(norm.key)
    if (existing === undefined) {
      into.set(norm.key, { key: norm.key, label: norm.label, count })
    } else if (count > existing.count) {
      existing.count = count
    }
  }
}

/**
 * Folds an artist document's genres and tags into one weighted, ordered list.
 *
 * Exported for the reason `parseArtistRelations` is: the merge, the casefold
 * dedup and the ordering are the half worth testing without a socket. Sorted by
 * weight descending, then by label so two tags of equal weight do not reorder
 * between two lookups of the same artist — a list that reshuffles reads as a bug.
 */
export function parseArtistTags(body: unknown): WeightedTag[] {
  const document = asRecord(body)
  if (!document) return []

  const merged = new Map<string, WeightedTag>()
  collect(document.genres, merged)
  collect(document.tags, merged)

  return [...merged.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * The lookup URL for one artist's genres and tags.
 *
 * `fmt=json` because the default is XML, matching the other MB lookups. The
 * identifier is interpolated because that is the shape of the endpoint; it is
 * checked before it gets here, which is what makes that safe.
 */
export function artistTagsUrl(mbid: string): string {
  return `${MUSICBRAINZ_WS}/artist/${encodeURIComponent(mbid)}?inc=${ARTIST_TAGS_INC}&fmt=json`
}

/**
 * The cache key for an artist's tag document.
 *
 * The `inc` is in the key, and it is not decoration: it is what keeps a
 * `genres+tags` reply from being handed back to a later request that asked the
 * same endpoint for `artist-rels`, with a document missing exactly the arrays
 * that were wanted — the same care `relationsCacheKey` takes.
 */
export function artistTagsCacheKey(mbid: string): string {
  return `${mbid}/${ARTIST_TAGS_INC}`
}

/**
 * Fetches one artist's genres and tags.
 *
 * An artist MusicBrainz has no genres or tags for is an *empty success* rather
 * than a `not-found`, `fetchArtistRelations`' distinction: the artist page exists
 * and simply carries no folksonomy, which is the ordinary state of a small act.
 * Caching that positively for thirty days is right; caching it negatively and
 * re-asking weekly would be paying for an answer we already hold. A 404 is a
 * merged-away MBID — a real `not-found`, cached negatively.
 */
export async function fetchArtistTags(
  client: NetClient,
  mbid: string
): Promise<NetResult<WeightedTag[]>> {
  if (!isMbid(mbid)) {
    return netFailed({ kind: 'rejected', message: 'That is not a MusicBrainz identifier.' })
  }

  const result = await client.getJson<unknown>({
    url: artistTagsUrl(mbid),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!result.ok) return result

  return netOk(parseArtistTags(result.value))
}
