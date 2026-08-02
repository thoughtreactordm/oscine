import type { Track } from '@shared/library'
import type { RelatedAlbum, RelatedResult, RelatedSection, RelatedStrand } from '@shared/related'

/**
 * A related section set, flattened into one list of fixed-height rows.
 *
 * Flattened rather than rendered as nested lists because the standing
 * invariant applies to this pane as much as to any other, and `visibleRange`
 * virtualizes *one* list of *one* row height. Independently scrolling sections
 * would be several viewports to measure and several scroll positions to keep;
 * one list with heading rows in it is the same information and stays
 * arithmetic.
 *
 * That is the constraint behind every layout decision here: headings are rows,
 * and an album's artist and year share its row rather than wrapping onto a
 * second one. A row that could be two lines tall would cost the pane its
 * virtualization, which is not a trade this codebase makes.
 *
 * ## Why this takes a strand set
 *
 * The six strands used to be one list under two headings in one pane. They are
 * now three lists in three accordion groups across two tabs — the artist's own
 * catalog sits under Artist, the rest of the album and the three coincidence
 * strands sit under Related — because "what else did they make" and "what else
 * was tagged 1998" are not the same question and reading them as one list was
 * the pane's central problem. The query is still one round trip returning all
 * six; only the drawing is split, so the split costs nothing.
 *
 * The "Looser connections" divider row is gone with it. It existed to caveat
 * the weaker half inline; that caveat is now the tooltip on the group's own
 * header, which is where it stops being a line of grey text under every list.
 */

export type RelatedRow =
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

function sectionLength(section: RelatedSection): number {
  return section.kind === 'tracks' ? section.tracks.length : section.albums.length
}

function sectionCount(section: RelatedSection): string {
  const length = sectionLength(section)
  return section.truncated ? `${length}+` : String(length)
}

/**
 * What a group holds, for the badge on its header while it is shut.
 *
 * `null` rather than `'0'` for nothing, because a group with a zero on it is
 * noisier than a group with nothing on it — the absence already says it, and
 * the badge exists to answer "is it worth opening", which a bare heading
 * answers just as well in the negative.
 *
 * Counts items and not heading rows: the badge on "Looser connections" should
 * say how many albums are in there, not how many albums plus three strand
 * headings. The `+` is carried through from any truncated section, so a capped
 * strand is not silently reported as exact.
 */
export function countRelatedRows(
  result: RelatedResult | null,
  strands: readonly RelatedStrand[]
): string | null {
  if (result === null) return null

  const wanted = new Set<RelatedStrand>(strands)
  let total = 0
  let truncated = false

  for (const section of result.sections) {
    if (!wanted.has(section.strand)) continue
    total += sectionLength(section)
    truncated ||= section.truncated
  }

  if (total === 0) return null
  return truncated ? `${total}+` : String(total)
}

/**
 * The rows for one group's strands, in the order the query returned them.
 *
 * `strands` orders nothing — the result's own section order is authoritative,
 * so the two lists cannot disagree about whether the album comes before the
 * artist. It is a filter and only a filter.
 */
export function buildRelatedRows(
  result: RelatedResult | null,
  strands: readonly RelatedStrand[]
): RelatedRow[] {
  if (result === null) return []

  const wanted = new Set<RelatedStrand>(strands)
  const rows: RelatedRow[] = []

  for (const section of result.sections) {
    if (!wanted.has(section.strand)) continue

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
