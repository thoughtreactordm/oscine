import type { Track } from '@shared/library'
import {
  NEIGHBOURHOOD_STRANDS,
  type RelatedAlbum,
  type RelatedResult,
  type RelatedSection,
  type RelatedStrand
} from '@shared/related'

/**
 * The related pane's sections, flattened into one list of fixed-height rows.
 *
 * Flattened rather than rendered as nested lists because the standing
 * invariant applies to this pane as much as to any other, and `visibleRange`
 * virtualizes *one* list of *one* row height. Six independently scrolling
 * sections would be six viewports to measure and six scroll positions to keep;
 * one list with heading rows in it is the same information and stays
 * arithmetic.
 *
 * That is the constraint behind every layout decision here: headings are rows,
 * the group divider is a row, and an album's artist and year share its row
 * rather than wrapping onto a second one. A row that could be two lines tall
 * would cost the pane its virtualization, which is not a trade this codebase
 * makes.
 */

export type RelatedRow =
  | {
      kind: 'group'
      key: string
      label: string
      /** Why this group is weaker. Rendered once, not per section. */
      hint: string
    }
  | {
      kind: 'header'
      key: string
      strand: RelatedStrand
      label: string
      /** The value the strand matched on — album title, artist, genre, year. */
      detail: string | null
      /** `12`, or `50+` when the section hit its cap. */
      count: string
    }
  | { kind: 'track'; key: string; track: Track }
  | { kind: 'album'; key: string; album: RelatedAlbum; meta: string }

const STRAND_LABELS: Record<RelatedStrand, string> = {
  'album-tracks': 'Rest of this album',
  'artist-albums': 'More by this artist',
  compilations: 'Appears on',
  genre: 'Same genre',
  year: 'Same year',
  folder: 'Same folder'
}

const NEIGHBOURHOOD = new Set<RelatedStrand>(NEIGHBOURHOOD_STRANDS)

/**
 * An album's second line, on its first line.
 *
 * Artist and year are what distinguish two albums with the same title, and the
 * track count is what tells a single from a record. Absent parts are dropped
 * rather than rendered as a dash: the row is thirty-six pixels and a placeholder
 * for something the tags never said is worth less than the space.
 */
export function albumMeta(album: RelatedAlbum): string {
  const parts: string[] = []
  if (album.artist !== null) parts.push(album.artist)
  if (album.year !== null) parts.push(String(album.year))
  parts.push(album.trackCount === 1 ? '1 track' : `${album.trackCount} tracks`)
  return parts.join(' · ')
}

function sectionCount(section: RelatedSection): string {
  const length = section.kind === 'tracks' ? section.tracks.length : section.albums.length
  return section.truncated ? `${length}+` : String(length)
}

/**
 * The group divider, emitted once before the first neighbourhood section.
 *
 * Emitted lazily rather than unconditionally: a track that has catalog
 * relations and no neighbourhood should not get a heading over nothing, and a
 * track with only neighbourhood relations still needs the caveat — so the rule
 * is "before the first one, if there is one" rather than "between the halves".
 */
const GROUP_ROW: Extract<RelatedRow, { kind: 'group' }> = {
  kind: 'group',
  key: 'group:neighbourhood',
  label: 'Looser connections',
  hint: 'Matched on a shared tag rather than on a credit.'
}

export function buildRelatedRows(result: RelatedResult | null): RelatedRow[] {
  if (result === null) return []

  const rows: RelatedRow[] = []
  let groupEmitted = false

  for (const section of result.sections) {
    if (!groupEmitted && NEIGHBOURHOOD.has(section.strand)) {
      rows.push(GROUP_ROW)
      groupEmitted = true
    }

    rows.push({
      kind: 'header',
      key: `header:${section.strand}`,
      strand: section.strand,
      label: STRAND_LABELS[section.strand],
      detail: section.detail,
      count: sectionCount(section)
    })

    if (section.kind === 'tracks') {
      for (const track of section.tracks) {
        rows.push({ kind: 'track', key: `track:${track.id}`, track })
      }
    } else {
      for (const album of section.albums) {
        // Keyed by strand as well as by album: the same album can legitimately
        // appear under two strands — a 1998 record by the artist is both their
        // discography and that year — and a duplicate `:key` silently drops the
        // second row rather than rendering it.
        rows.push({
          kind: 'album',
          key: `album:${section.strand}:${album.albumId}`,
          album,
          meta: albumMeta(album)
        })
      }
    }
  }

  return rows
}
