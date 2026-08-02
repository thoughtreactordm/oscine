import type {
  ArtistRelation,
  ArtistRelationKind,
  ArtistRelationsResult
} from '@shared/artistRelations'

/**
 * The relation graph, flattened into one list of fixed-height rows.
 *
 * Flattened for `relatedRows.ts`' reason and under the same standing invariant:
 * `visibleRange` virtualizes one list of one row height, and a band with two
 * hundred members is exactly the case that makes that non-negotiable. Headings
 * are rows; a relation's instruments and years share its row rather than
 * wrapping onto a second one.
 *
 * Pure functions in their own module for `artistIdentity.ts`' reason. What this
 * file decides is what the deck *claims* — which of these artists you own, and
 * how sure it is — and **R5** is a correctness risk about exactly that. Testing
 * a claim through a mounted component means a DOM, a Pinia instance and a Nuxt
 * UI plugin to assert on a sentence.
 */

/**
 * A section, which is a kind and a tense rather than only a kind.
 *
 * "Members" and "Former members" are one MusicBrainz relationship separated by
 * one boolean, and the card names them as two categories because they are two
 * questions. Splitting here rather than in `ArtistRelationKind` keeps the shared
 * contract at six kinds instead of eleven, and keeps the tense where it belongs
 * — a `member of band` relation that has ended is still a membership, and main
 * sorts on that field rather than on a heading.
 */
export type RelationSection = `${ArtistRelationKind}:${'current' | 'ended'}`

/**
 * What each section calls itself.
 *
 * Nouns rather than sentences, because a heading in a 380px column is read as a
 * label. `group` says "Bands and groups" rather than "Member of" for the same
 * reason: the rows under it are bands, and a heading that describes the
 * *relationship* leaves the operator parsing a verb before they can read a name.
 *
 * `other` has no ended form worth naming — a sibling who is no longer a sibling
 * is not a thing — so both of its tenses land on one label and the section
 * splitting simply produces one of them.
 */
const SECTION_LABELS: Readonly<Record<RelationSection, string>> = {
  'member:current': 'Members',
  'member:ended': 'Former members',
  'group:current': 'Bands and groups',
  'group:ended': 'Former bands',
  'side-project:current': 'Side projects',
  'side-project:ended': 'Past side projects',
  'collaboration:current': 'Collaborations',
  'collaboration:ended': 'Past collaborations',
  'alias:current': 'Also known as',
  'alias:ended': 'Formerly known as',
  'other:current': 'Other connections',
  'other:ended': 'Other connections'
}

const SECTION_ICONS: Readonly<Record<ArtistRelationKind, string>> = {
  member: 'i-tabler-users',
  group: 'i-tabler-microphone-2',
  'side-project': 'i-tabler-git-branch',
  collaboration: 'i-tabler-arrows-join',
  alias: 'i-tabler-mask',
  other: 'i-tabler-link'
}

export type RelationRow =
  | {
      kind: 'header'
      key: string
      section: RelationSection
      label: string
      icon: string
      /** How many rows follow. Never a `+`: the cap is reported by the pane, once. */
      count: number
    }
  | {
      kind: 'relation'
      key: string
      relation: ArtistRelation
      /** Instruments, years and MusicBrainz's own type, joined for the second column. */
      detail: string | null
      /** What the library holds, phrased. `null` when it holds nothing. */
      owned: string | null
      /** Whether the match behind `owned` is a name guess rather than an identity. */
      uncertain: boolean
    }

function sectionOf(relation: ArtistRelation): RelationSection {
  // `other` is never drawn as a past tense — see the note on `SECTION_LABELS`.
  if (relation.kind === 'other') return 'other:current'
  return `${relation.kind}:${relation.ended ? 'ended' : 'current'}`
}

/** `1987-12-01` → `1987`. MusicBrainz dates are partial and the year is the useful part. */
function year(date: string | null): string | null {
  if (!date) return null
  const match = /^(\d{4})/u.exec(date)
  return match ? match[1] : null
}

/**
 * The years a connection covers, or nothing.
 *
 * Half a range is drawn as half a range, and an undated connection gets no years
 * at all rather than a placeholder — a former member MusicBrainz never dated is
 * still informative, and filling the gap with a dash would be the pane asserting
 * something MusicBrainz did not say. The trailing dash on an open range is not
 * a claim that it is ongoing either: the heading above the row has already said
 * which tense it is in.
 */
export function relationYears(relation: ArtistRelation): string | null {
  const begin = year(relation.begin)
  const end = year(relation.end)
  if (begin && end) return begin === end ? begin : `${begin}–${end}`
  if (begin) return `${begin}–`
  if (end) return `–${end}`
  return null
}

/**
 * The second column: what kind of connection this is, and when.
 *
 * MusicBrainz's own relationship type leads for `other` rows and only for them.
 * Everywhere else the heading has already said it, and repeating "member of
 * band" on every row of a section called Members is noise in the one column that
 * has room for something else — the instruments.
 */
export function relationDetail(relation: ArtistRelation): string | null {
  const parts: string[] = []
  if (relation.kind === 'other') parts.push(relation.type)
  if (relation.attributes.length > 0) parts.push(relation.attributes.join(', '))
  else if (relation.disambiguation) parts.push(relation.disambiguation)

  const years = relationYears(relation)
  if (years) parts.push(years)

  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * What the library holds for this artist, phrased.
 *
 * A count and a noun, because the count is the entire proposition: "the
 * drummer's other band" is a fact about MusicBrainz, and "which you own three
 * tracks by" is the reason anyone opened the deck. Zero is a real answer — an
 * artist whose last track was removed still has a row — and it says so rather
 * than being rendered as ownership.
 */
export function relationOwnership(relation: ArtistRelation): string | null {
  const match = relation.match
  if (match === null) return null
  if (match.trackCount === 0) return 'In your library'
  return match.trackCount === 1 ? '1 track' : `${match.trackCount.toLocaleString()} tracks`
}

/**
 * What a shut group puts on its header.
 *
 * The number of *owned* relations rather than the number of relations, because
 * the badge exists to answer "is it worth opening" and the answer to that is not
 * "MusicBrainz knows forty people". A band whose entire membership is absent
 * from the library is a pane the operator can skip; one where three of them are
 * present is the pane this whole card is for.
 *
 * `null` rather than `'0'` for nothing, matching `countRelatedRows`: the absence
 * already says it, and a zero is noisier than a bare heading.
 */
export function countOwnedRelations(result: ArtistRelationsResult | null): string | null {
  if (result === null) return null
  const owned = result.relations.filter((relation) => relation.match !== null).length
  return owned === 0 ? null : owned.toLocaleString()
}

/**
 * The rows, in the order main sorted them.
 *
 * Section boundaries are read off the sequence rather than imposed on it: main
 * has already ordered the relations by kind, then tense, then ownership, then
 * name, so walking the list and emitting a heading whenever the section changes
 * produces exactly the grouping without this file holding a second opinion about
 * the order. Two files sorting the same list is how a heading ends up over the
 * wrong rows.
 */
export function buildRelationRows(result: ArtistRelationsResult | null): RelationRow[] {
  if (result === null || result.status !== 'ready') return []

  const rows: RelationRow[] = []
  let section: RelationSection | null = null
  let header: Extract<RelationRow, { kind: 'header' }> | null = null

  for (const relation of result.relations) {
    const next = sectionOf(relation)
    if (next !== section) {
      section = next
      header = {
        kind: 'header',
        key: `header:${next}`,
        section: next,
        label: SECTION_LABELS[next],
        icon: SECTION_ICONS[relation.kind],
        count: 0
      }
      rows.push(header)
    }

    if (header) header.count++

    rows.push({
      kind: 'relation',
      // Keyed by section as well as by identifier: one artist can legitimately
      // appear twice — a member who left and rejoined is two stints, and a
      // duplicate `:key` silently drops the second row rather than drawing it.
      key: `relation:${next}:${relation.mbid}:${relation.begin ?? ''}`,
      relation,
      detail: relationDetail(relation),
      owned: relationOwnership(relation),
      uncertain: relation.match?.basis === 'name'
    })
  }

  return rows
}
