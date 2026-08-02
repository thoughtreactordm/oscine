/**
 * The MusicBrainz artist document, and the artist-to-artist relations in it.
 *
 * One request against `/artist/{mbid}?inc=artist-rels`, which is a *lookup* and
 * not a search: the identifier is one R5 already settled, so nothing here is
 * allowed to second-guess who the artist is. That is the same rule
 * `wikidata.ts` states for its own first hop, and for the same reason — a pane
 * that re-resolved the identity would be able to disagree with the header
 * directly above it.
 *
 * Everything is parsed defensively, for `search.ts`' reason: this is a JSON
 * document from a service we do not control, and one malformed relation out of
 * forty must cost that row rather than cost the operator a blank pane.
 */

import { isMbid } from '@shared/artist'
import { ARTIST_RELATION_ATTRIBUTE_LIMIT, type ArtistRelationKind } from '@shared/artistRelations'
import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'
import { MUSICBRAINZ_WS } from './search'

/**
 * What the lookup asks for, and the half of the cache key that is not the MBID.
 *
 * `artist-rels` alone: the same endpoint answers `url-rels` for the outbound
 * links W7-12 wants, and asking for both here would make this pane pay for that
 * one's payload on every track change. Naming the `inc` in the cache key is what
 * keeps the two documents from being stored as the same thing — see
 * `relationsCacheKey`.
 */
export const ARTIST_RELATIONS_INC = 'artist-rels'

/** One relation, as it comes out of the document and before the library sees it. */
export interface ParsedRelation {
  kind: ArtistRelationKind
  type: string
  mbid: string
  name: string
  disambiguation: string | null
  attributes: string[]
  begin: string | null
  end: string | null
  ended: boolean
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
 * MusicBrainz's relationship types, mapped onto the six the pane draws.
 *
 * Keyed by type and then by direction, because the direction is what decides
 * which *end* of the relationship the artist we asked about is standing at.
 * `member of band` seen from the band lists people and seen from a person lists
 * bands; one entry with one kind would put a drummer under a heading that says
 * "Members" on the drummer's own page.
 *
 * Deliberately short, and closed: a relationship type absent from here is
 * dropped rather than bucketed. MusicBrainz records `sibling`, `teacher`,
 * `married`, `named after` and thirty more, and every one of them is a fact
 * about two people rather than about their music — a pane listing them spends
 * the operator's attention on the least useful thing the service knows. The cost
 * of the table being closed is that a genuinely musical relationship type added
 * to MusicBrainz next year needs a line here; that is a line, and it is worth
 * paying for a pane that does not fill with trivia in the meantime.
 */
const KIND_BY_TYPE: Readonly<
  Record<string, { readonly forward: ArtistRelationKind; readonly backward: ArtistRelationKind }>
> = {
  // Forward is "this artist is a member of that one"; backward is the band's
  // own view of its people.
  'member of band': { forward: 'group', backward: 'member' },
  // MusicBrainz stores this parent-first: forward from the parent group is the
  // subgroup, which is the side project. Backward is the parent it came out of,
  // which is a band this artist belongs to.
  subgroup: { forward: 'side-project', backward: 'group' },
  // Symmetric in practice: the collaboration and the artists in it are both
  // "collaboration" to somebody reading the deck.
  collaboration: { forward: 'collaboration', backward: 'collaboration' },
  founder: { forward: 'group', backward: 'member' },
  // The person behind a performing name. Both ends are the same fact.
  'is person': { forward: 'alias', backward: 'alias' },
  'legal name': { forward: 'alias', backward: 'alias' }
}

/**
 * Which of the five a relationship type and direction is, or `null` for one the
 * pane does not draw.
 *
 * Exported because it is the part of this file worth testing on its own: the
 * direction handling is the subtle half, and a test that has to build a whole
 * MusicBrainz document to assert that a drummer's band lands under `group` is a
 * test about JSON.
 */
export function relationKind(type: string, direction: string | null): ArtistRelationKind | null {
  const mapped = KIND_BY_TYPE[type.toLowerCase()]
  if (!mapped) return null
  return direction === 'backward' ? mapped.backward : mapped.forward
}

function readAttributes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const attributes: string[] = []
  for (const entry of value) {
    const attribute = asString(entry)
    if (attribute === null) continue
    if (!attributes.includes(attribute)) attributes.push(attribute)
    if (attributes.length >= ARTIST_RELATION_ATTRIBUTE_LIMIT) break
  }
  return attributes
}

/**
 * Merges relations that describe the same connection.
 *
 * MusicBrainz splits one membership across several relationships when the
 * instruments differ or the person left and rejoined, so a band's document
 * routinely carries the same name three times. Merging on kind, identifier and
 * period keeps genuinely distinct stints — a member who was in the band twice
 * has two date ranges and stays two rows — while folding "guitar" and "backing
 * vocals" for one stint into one row with both.
 *
 * `ended` is or-ed rather than overwritten: if any of the merged relationships
 * is over and none of the survivors says otherwise, the connection is over.
 */
function mergeKey(relation: ParsedRelation): string {
  return `${relation.kind}|${relation.mbid}|${relation.begin ?? ''}|${relation.end ?? ''}`
}

function merge(relations: readonly ParsedRelation[]): ParsedRelation[] {
  const merged = new Map<string, ParsedRelation>()

  for (const relation of relations) {
    const key = mergeKey(relation)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...relation, attributes: [...relation.attributes] })
      continue
    }

    for (const attribute of relation.attributes) {
      if (existing.attributes.length >= ARTIST_RELATION_ATTRIBUTE_LIMIT) break
      if (!existing.attributes.includes(attribute)) existing.attributes.push(attribute)
    }
    existing.ended ||= relation.ended
  }

  return [...merged.values()]
}

/**
 * Reads the `relations` array out of an artist document.
 *
 * Exported for the reason `parseArtistSearch` is: the awkward cases here are
 * awkward at this layer — a relation whose target is a release group, a
 * membership with no dates, an entry MusicBrainz has left half-filled — and
 * asserting on them through a fake `NetClient` would be a test about plumbing.
 */
export function parseArtistRelations(body: unknown): ParsedRelation[] {
  const document = asRecord(body)
  const raw = document?.relations
  if (!Array.isArray(raw)) return []

  const relations: ParsedRelation[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue

    // The document carries relations to every entity type MusicBrainz links an
    // artist to — release groups, works, places, series. This pane is about
    // artists, and a `target-type` check is cheaper and more honest than
    // inferring it from which sub-object happens to be present.
    if (asString(record['target-type']) !== 'artist') continue

    const target = asRecord(record.artist)
    if (!target) continue

    const mbid = asString(target.id)
    const name = asString(target.name)
    // Both load-bearing: without an identifier there is nothing to intersect the
    // library on, and without a name there is nothing to draw.
    if (!mbid || !isMbid(mbid) || !name) continue

    const type = asString(record.type)
    if (!type) continue

    // A relationship type the pane has no heading for. Dropped here rather than
    // filtered later, so nothing downstream has to know the vocabulary twice.
    const kind = relationKind(type, asString(record.direction))
    if (kind === null) continue

    relations.push({
      kind,
      type,
      mbid,
      name,
      disambiguation: asString(target.disambiguation),
      attributes: readAttributes(record.attributes),
      begin: asString(record.begin),
      end: asString(record.end),
      // `ended` is the field MusicBrainz sets when the relationship is over. An
      // end date without it — which happens — is the same fact, so both count.
      ended: record.ended === true || asString(record.end) !== null
    })
  }

  return merge(relations)
}

/**
 * The lookup URL for one artist's relations.
 *
 * `fmt=json` because the default is XML and we would rather not carry a parser,
 * matching `artistSearchUrl`. The identifier is interpolated rather than sent as
 * a query parameter because that is the shape of the endpoint; it is checked
 * before it gets here, which is what makes that safe.
 */
export function artistRelationsUrl(mbid: string): string {
  return `${MUSICBRAINZ_WS}/artist/${encodeURIComponent(mbid)}?inc=${ARTIST_RELATIONS_INC}&fmt=json`
}

/**
 * The cache key for an artist document.
 *
 * The `inc` is in the key, and it is not decoration. `musicbrainz.artist` is
 * described as "the artist document, with its relations and outbound links",
 * which is two documents from one endpoint — and a key of the bare MBID would
 * let a relations-only reply answer a later request that asked for links too,
 * silently, with a document that is missing exactly the half that was wanted.
 */
export function relationsCacheKey(mbid: string): string {
  return `${mbid}/${ARTIST_RELATIONS_INC}`
}

/**
 * Fetches one artist's relations.
 *
 * An artist MusicBrainz has no artist relations for is an *empty success* rather
 * than a `not-found`, which is the opposite of what `searchArtists` does and is
 * deliberate. A search with no results means the thing was not found; this
 * lookup succeeding means the artist page exists and simply records no
 * connections, which is the ordinary state of most solo artists. Caching that
 * positively for thirty days is right; caching it negatively for seven and
 * re-asking weekly would be paying for an answer we already have.
 *
 * A 404, by contrast, means the MBID we hold has been merged away — a real
 * `not-found`, cached negatively, and re-checked on the negative TTL's cadence.
 */
export async function fetchArtistRelations(
  client: NetClient,
  mbid: string
): Promise<NetResult<ParsedRelation[]>> {
  if (!isMbid(mbid)) {
    return netFailed({ kind: 'rejected', message: 'That is not a MusicBrainz identifier.' })
  }

  const result = await client.getJson<unknown>({
    url: artistRelationsUrl(mbid),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!result.ok) return result

  return netOk(parseArtistRelations(result.value))
}
