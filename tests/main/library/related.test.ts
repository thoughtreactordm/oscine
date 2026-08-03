import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import {
  buildRelated,
  folderNeighbourhood,
  tagNeighbourhood,
  type RelatedQueries,
  type RelatedSeed,
  type StrandInput
} from '../../../src/main/library/related'
import type {
  FavoriteBias,
  RelatedAlbum,
  RelatedAlbumSection,
  RelatedSection,
  RelatedStrand
} from '../../../src/shared/related'

/**
 * W7-5, both halves: the seam that composes the strands and the SQL underneath.
 *
 * Split into two describes on purpose, because they fail for different reasons.
 * The seam tests use a hand-written `RelatedQueries` and no database at all —
 * that is the point of the interface, and it is what lets the M3 replacement of
 * the neighbourhood strategy be tested before it has a query. The SQL tests use
 * a real library, because the parts worth doubting there are the `IS NOT`
 * comparisons against NULL and the `rel_path` range, neither of which a fake
 * could get wrong on our behalf.
 */

// ---------------------------------------------------------------------------

describe('folderNeighbourhood', () => {
  it('scopes to the parent of the containing directory', () => {
    // Not `Artist/Album/`: that is the album the catalog half already lists in
    // full, so a neighbourhood scoped to it would repeat rows the operator has
    // just read. The parent is where the sibling records are.
    expect(folderNeighbourhood('Artist/Album/01.flac')).toEqual({
      prefix: 'Artist/',
      prefixEnd: 'Artist0'
    })
  })

  it('takes the immediate parent from a deep path', () => {
    expect(folderNeighbourhood('Genre/Artist/Album/01.flac')).toEqual({
      prefix: 'Genre/Artist/',
      prefixEnd: 'Genre/Artist0'
    })
  })

  it('produces a range that brackets exactly the subtree', () => {
    const range = folderNeighbourhood('Artist/Album/01.flac')
    expect(range).not.toBeNull()
    const { prefix, prefixEnd } = range!

    // The half-open range is what makes the query sargable. It must admit
    // everything under the folder and nothing that merely starts with its name.
    expect('Artist/Album/01.flac' >= prefix && 'Artist/Album/01.flac' < prefixEnd).toBe(true)
    expect('Artist/Other/09.flac' >= prefix && 'Artist/Other/09.flac' < prefixEnd).toBe(true)
    expect('Artistic/Album/01.flac' < prefixEnd).toBe(false)
    expect('Artis/Album/01.flac' >= prefix).toBe(false)
  })

  it('declines a track with no parent folder inside the root', () => {
    // One directory deep, or none. The "neighbourhood" would be the whole root,
    // which is a list rather than a relation.
    expect(folderNeighbourhood('Album/01.flac')).toBeNull()
    expect(folderNeighbourhood('01.flac')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

const BARE_SEED: RelatedSeed = {
  trackId: 1,
  rootId: 1,
  relPath: 'Artist/Album/01.flac',
  albumId: 10,
  albumTitle: 'Album',
  artistId: 20,
  artistName: 'Artist',
  albumArtistId: 20,
  albumArtistName: 'Artist',
  genre: 'IDM',
  year: 1998
}

function album(albumId: number, title: string) {
  return { albumId, title, artist: 'Someone', year: 1998, trackCount: 9 }
}

/** Every strand empty; each test overrides only what it is about. */
function queries(overrides: Partial<RelatedQueries> = {}): RelatedQueries {
  return {
    seed: () => BARE_SEED,
    albumTracks: () => [],
    artistAlbums: () => [],
    compilations: () => [],
    sameGenre: () => [],
    sameYear: () => [],
    sameFolder: () => [],
    ...overrides
  }
}

describe('buildRelated', () => {
  it('returns null only when the seed track is gone', () => {
    expect(buildRelated(queries({ seed: () => null }), 1)).toBeNull()
  })

  it('distinguishes a missing track from one that relates to nothing', () => {
    // The pane renders these differently, so the layer below has to keep them
    // apart. An empty `sections` is "present, unrelated"; `null` is "gone".
    const result = buildRelated(queries(), 1)
    expect(result).not.toBeNull()
    expect(result!.sections).toEqual([])
  })

  it('omits sections with no rows rather than returning them empty', () => {
    const result = buildRelated(queries({ artistAlbums: () => [album(11, 'Other')] }), 1)
    expect(result!.sections.map((section) => section.strand)).toEqual(['artist-albums'])
  })

  it('orders the catalog half before the neighbourhood half', () => {
    const result = buildRelated(
      queries({
        albumTracks: () => [],
        artistAlbums: () => [album(11, 'Discography')],
        compilations: () => [album(12, 'Comp')],
        sameGenre: () => [album(13, 'Genre')],
        sameYear: () => [album(14, 'Year')],
        sameFolder: () => [album(15, 'Folder')]
      }),
      1
    )
    expect(result!.sections.map((section) => section.strand)).toEqual([
      'artist-albums',
      'compilations',
      'genre',
      'year',
      'folder'
    ])
  })

  it('over-fetches by one to tell a full page from a truncated one', () => {
    // `LIMIT n` returning exactly n rows cannot distinguish "that is all" from
    // "there is more", so every strand asks for one more than it shows.
    const rows = Array.from({ length: 4 }, (_, index) => album(100 + index, `A${index}`))
    const result = buildRelated(queries({ artistAlbums: () => rows }), 1, { limit: 3 })
    const section = result!.sections[0] as RelatedAlbumSection

    expect(section.albums).toHaveLength(3)
    expect(section.truncated).toBe(true)
  })

  it('does not claim truncation when the page is exactly full', () => {
    const rows = Array.from({ length: 3 }, (_, index) => album(100 + index, `A${index}`))
    const result = buildRelated(queries({ artistAlbums: () => rows }), 1, { limit: 3 })
    const section = result!.sections[0] as RelatedAlbumSection

    expect(section.albums).toHaveLength(3)
    expect(section.truncated).toBe(false)
  })

  it('asks the strands for one more row than it will show', () => {
    let asked = -1
    buildRelated(
      queries({
        artistAlbums: ({ limit }) => {
          asked = limit
          return []
        }
      }),
      1,
      { limit: 25 }
    )
    expect(asked).toBe(26)
  })

  it('keys the discography on the album artist and appearances on the performer', () => {
    // The distinction is the whole difference between the two strands: an album
    // the artist is credited for is their record, one they merely play on is an
    // appearance.
    let discographyArtist = -1
    let appearingArtist = -1
    buildRelated(
      queries({
        seed: () => ({ ...BARE_SEED, albumArtistId: 20, artistId: 21 }),
        artistAlbums: ({ artistId }) => {
          discographyArtist = artistId
          return []
        },
        compilations: ({ artistId }) => {
          appearingArtist = artistId
          return []
        }
      }),
      1
    )
    expect(discographyArtist).toBe(20)
    expect(appearingArtist).toBe(21)
  })

  it('falls back between the two artist identities when one is missing', () => {
    // A loose track has no album artist; a compilation's tracks often carry
    // only a performer. Without the fallback both strands vanish for exactly
    // the tracks that most need them.
    let discographyArtist = -1
    buildRelated(
      queries({
        seed: () => ({ ...BARE_SEED, albumArtistId: null, artistId: 21 }),
        artistAlbums: ({ artistId }) => {
          discographyArtist = artistId
          return []
        }
      }),
      1
    )
    expect(discographyArtist).toBe(21)
  })

  it('routes the neighbourhood through the injected strategy', () => {
    // The seam W7-5 asks for: M3's FTS5 replacement arrives as a different
    // function here and nothing above this call changes.
    const result = buildRelated(queries(), 1, {
      neighbourhood: () => [
        {
          kind: 'albums',
          strand: 'genre',
          detail: 'from FTS',
          truncated: false,
          albums: [album(1, 'X')]
        }
      ]
    })
    expect(result!.sections).toHaveLength(1)
    expect(result!.sections[0].detail).toBe('from FTS')
  })

  /**
   * W10-9. The bias is uninteresting here beyond one thing: that every strand
   * is told the same one. The queries either honour it or they do not, and that
   * is the SQL's business a few describes down.
   */
  function biasSeenByEveryStrand(options: Parameters<typeof buildRelated>[2]): FavoriteBias[] {
    const seen: FavoriteBias[] = []
    const note = (input: StrandInput): [] => {
      seen.push(input.favorites)
      return []
    }
    buildRelated(
      queries({
        albumTracks: note,
        artistAlbums: note,
        compilations: note,
        sameGenre: note,
        sameYear: note,
        sameFolder: note
      }),
      1,
      options
    )
    return seen
  }

  it('asks every strand to ignore favorites unless it is told otherwise', () => {
    // The card's "off by default", at the seam. `BARE_SEED` carries an album, an
    // artist, a genre, a year and a parent folder, so all six are reached.
    expect(biasSeenByEveryStrand(undefined)).toEqual(Array<FavoriteBias>(6).fill('ignore'))
  })

  it('gives every strand the same bias, catalog half and neighbourhood alike', () => {
    // Not just the two the spec's example names: a pane that preferred
    // favorites in "more from this artist" and ignored them one heading down
    // would be describing its own implementation rather than the request.
    expect(biasSeenByEveryStrand({ favorites: 'prefer' })).toEqual(
      Array<FavoriteBias>(6).fill('prefer')
    )
  })

  it('hands the neighbourhood strategy its page size and bias together', () => {
    let given: StrandInput | null = null
    buildRelated(queries(), 1, {
      limit: 7,
      favorites: 'only',
      neighbourhood: (_queries, _seed, params) => {
        given = params
        return []
      }
    })
    expect(given).toEqual({ limit: 7, favorites: 'only' })
  })
})

describe('tagNeighbourhood', () => {
  it('skips a strand whose dimension the seed does not have', () => {
    // A track whose file carried no genre tag — or one indexed before migration
    // 10 and not yet rescanned — produces no genre section rather than an empty
    // one. That is why the migration needed no special case in the pane.
    const sections = tagNeighbourhood(
      queries({ sameGenre: () => [album(1, 'Should not be asked for')] }),
      { ...BARE_SEED, genre: null, year: null, relPath: '01.flac' },
      { limit: 10, favorites: 'ignore' }
    )
    expect(sections).toEqual([])
  })

  it('labels each strand with the value it matched on', () => {
    const sections = tagNeighbourhood(
      queries({
        sameGenre: () => [album(1, 'G')],
        sameYear: () => [album(2, 'Y')],
        sameFolder: () => [album(3, 'F')]
      }),
      BARE_SEED,
      { limit: 10, favorites: 'ignore' }
    )
    expect(sections.map((section) => [section.strand, section.detail])).toEqual([
      ['genre', 'IDM'],
      ['year', '1998'],
      ['folder', 'Artist']
    ])
  })
})

// ---------------------------------------------------------------------------

/**
 * The SQL, against a real library.
 *
 * Small and hand-built rather than generated: every strand has to be
 * distinguishable from every other, which means the fixture is a shape rather
 * than a volume. Scale is a separate concern and `listTracksScale` is where the
 * repository measures it.
 */
describe('related queries', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let store: LibraryStore
  let seedTrackId: number

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fermata-related-'))
    opened = openDatabase(join(dir, 'library.db'))
    const { db } = opened

    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', '/synthetic', 1).lastInsertRowid
    )

    const insertArtist = db.prepare('INSERT INTO artists (name) VALUES (?)')
    const boards = Number(insertArtist.run('Boards of Canada').lastInsertRowid)
    const autechre = Number(insertArtist.run('Autechre').lastInsertRowid)
    const various = Number(insertArtist.run('Various Artists').lastInsertRowid)

    const insertAlbum = db.prepare(
      'INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)'
    )
    const geogaddi = Number(insertAlbum.run('Geogaddi', boards, 2002).lastInsertRowid)
    const musicHasTheRight = Number(
      insertAlbum.run('Music Has the Right to Children', boards, 1998).lastInsertRowid
    )
    const amber = Number(insertAlbum.run('Amber', autechre, 1994).lastInsertRowid)
    const warpComp = Number(insertAlbum.run('Warp Compilation', various, 2002).lastInsertRowid)

    const insertTrack = db.prepare(`
      INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id, track_no, genre)
      VALUES (@rootId, @relPath, 1, 1000, @title, @artistId, @albumId, @trackNo, @genre)
    `)
    const add = (
      relPath: string,
      title: string,
      artistId: number,
      albumId: number,
      trackNo: number,
      genre: string | null
    ): number =>
      Number(
        insertTrack.run({ rootId, relPath, title, artistId, albumId, trackNo, genre })
          .lastInsertRowid
      )

    // The seed's album, three tracks deep.
    seedTrackId = add(
      'Boards of Canada/Geogaddi/01.flac',
      'Ready Lets Go',
      boards,
      geogaddi,
      1,
      'IDM'
    )
    add('Boards of Canada/Geogaddi/02.flac', 'Music Is Math', boards, geogaddi, 2, 'IDM')
    add(
      'Boards of Canada/Geogaddi/03.flac',
      'Beware the Friendly Stranger',
      boards,
      geogaddi,
      3,
      'IDM'
    )

    // Same album artist, same parent folder, same genre — three strands at once,
    // which is what proves they are computed separately.
    add(
      'Boards of Canada/Music Has the Right/01.flac',
      'Wildlife Analysis',
      boards,
      musicHasTheRight,
      1,
      'IDM'
    )
    add(
      'Boards of Canada/Music Has the Right/02.flac',
      'An Eagle in Your Mind',
      boards,
      musicHasTheRight,
      2,
      'IDM'
    )

    // Same genre only: different artist, different folder, different year.
    add('Autechre/Amber/01.flac', 'Foil', autechre, amber, 1, 'IDM')
    add('Autechre/Amber/02.flac', 'Montreal', autechre, amber, 2, 'IDM')

    // A compilation: credited to Various, but with a track by the seed's artist.
    add('Various/Warp Compilation/01.flac', 'Roygbiv', boards, warpComp, 1, 'Electronic')
    add(
      'Various/Warp Compilation/02.flac',
      'Second Bad Vilbel',
      autechre,
      warpComp,
      2,
      'Electronic'
    )

    store = new LibraryStore(db)
  })

  afterAll(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function sectionFor(strand: RelatedStrand): RelatedSection {
    const result = buildRelated(store.relatedQueries(), seedTrackId)
    const section = result?.sections.find((candidate) => candidate.strand === strand)
    // Thrown rather than asserted, so the helpers below narrow. A missing
    // section is always a test failure here — the fixture is built to give
    // every strand something.
    if (section === undefined) throw new Error(`no ${strand} section`)
    return section
  }

  function albumsIn(strand: RelatedStrand): RelatedAlbum[] {
    const section = sectionFor(strand)
    if (section.kind !== 'albums') throw new Error(`${strand} is not an album section`)
    return section.albums
  }

  function albumTitlesIn(strand: RelatedStrand): string[] {
    return albumsIn(strand).map((album) => album.title)
  }

  it('lists the rest of the seed album, in order, without the seed', () => {
    const section = sectionFor('album-tracks')
    expect(section.kind).toBe('tracks')
    expect(section.kind === 'tracks' ? section.tracks.map((track) => track.title) : []).toEqual([
      'Music Is Math',
      'Beware the Friendly Stranger'
    ])
  })

  it('lists other albums by the album artist, excluding the seed album', () => {
    expect(albumTitlesIn('artist-albums')).toEqual(['Music Has the Right to Children'])
  })

  it('counts an album by its own tracks rather than by the strand', () => {
    expect(albumsIn('artist-albums')[0].trackCount).toBe(2)
  })

  it('finds compilations the artist appears on but is not credited for', () => {
    // `Geogaddi` is excluded because the artist *is* its album artist — that is
    // the discography, not an appearance.
    expect(albumTitlesIn('compilations')).toEqual(['Warp Compilation'])
  })

  it('finds the genre neighbourhood across artists and folders', () => {
    expect(albumTitlesIn('genre').sort()).toEqual(['Amber', 'Music Has the Right to Children'])
  })

  it('finds the year neighbourhood, excluding the seed album', () => {
    expect(albumTitlesIn('year')).toEqual(['Warp Compilation'])
  })

  it("finds the folder neighbourhood under the seed's parent directory", () => {
    // `Boards of Canada/` — so the other Boards album, and neither Autechre nor
    // the compilation, both of which live under different parents.
    expect(albumTitlesIn('folder')).toEqual(['Music Has the Right to Children'])
  })

  it('returns null for a track that is not in the library', () => {
    expect(buildRelated(store.relatedQueries(), 999_999)).toBeNull()
  })

  /**
   * W10-9, against the same fixture with two tracks hearted.
   *
   * Nested rather than given a database of its own so the "off by default" test
   * can be the strongest form of itself: the unbiased result is captured before
   * a single favorite exists and compared against the unbiased result once they
   * do. A compatibility test run against a library with no favorites in it
   * would pass on a query that had forgotten the parameter entirely.
   */
  describe('the favorite bias', () => {
    /** Section shape and row identity — everything except the rows' contents. */
    type Shape = { strand: RelatedStrand; truncated: boolean; rows: number[] }

    function shape(sections: readonly RelatedSection[]): Shape[] {
      return sections.map((section) => ({
        strand: section.strand,
        truncated: section.truncated,
        rows:
          section.kind === 'tracks'
            ? section.tracks.map((track) => track.id)
            : section.albums.map((album) => album.albumId)
      }))
    }

    /** The same shapes with each strand's rows put in a canonical order. */
    function asSets(shapes: readonly Shape[]): Shape[] {
      return shapes.map((entry) => ({ ...entry, rows: [...entry.rows].sort((a, b) => a - b) }))
    }

    function strands(favorites: FavoriteBias): RelatedSection[] {
      return buildRelated(store.relatedQueries(), seedTrackId, { favorites })!.sections
    }

    function titlesIn(sections: readonly RelatedSection[], strand: RelatedStrand): string[] {
      const section = sections.find((candidate) => candidate.strand === strand)
      if (section === undefined) return []
      return section.kind === 'tracks'
        ? section.tracks.map((track) => track.title ?? '')
        : section.albums.map((album) => album.title)
    }

    let unhearted: Shape[]

    beforeAll(() => {
      unhearted = shape(strands('ignore'))

      // `Foil` is on Amber, which the genre strand's year ordering puts second,
      // so preferring has something visible to do. `Beware the Friendly
      // Stranger` is on the seed's own album, which is the one strand whose
      // rows are tracks. Nothing on `Music Has the Right to Children` or on the
      // compilation is hearted, which is what lets `only` be watched emptying a
      // strand rather than merely shortening one.
      opened.db
        .prepare(
          `INSERT INTO track_favorites (track_id, favorited_at)
           SELECT id, 1 FROM tracks WHERE title IN ('Foil', 'Beware the Friendly Stranger')`
        )
        .run()
    })

    afterAll(() => {
      opened.db.prepare('DELETE FROM track_favorites').run()
    })

    it('leaves every strand exactly as it was when it is off', () => {
      expect(shape(strands('ignore'))).toEqual(unhearted)
    })

    it('reorders rather than narrows under prefer', () => {
      const preferred = strands('prefer')
      // Every strand keeps every row it had. True as an equality here because
      // the fixture is well inside `RELATED_SECTION_LIMIT`; a truncated strand
      // trades its tail for the promotion, which is what `truncated` says.
      expect(asSets(shape(preferred))).toEqual(asSets(unhearted))

      // Amber is 1994 and the genre strand reads newest first, so it was second.
      expect(titlesIn(preferred, 'genre')).toEqual(['Amber', 'Music Has the Right to Children'])
      // Track 3 ahead of track 2, which is the disc/track ordering overruled.
      expect(titlesIn(preferred, 'album-tracks')).toEqual([
        'Beware the Friendly Stranger',
        'Music Is Math'
      ])
      // A strand with nothing hearted in it is untouched, not emptied.
      expect(titlesIn(preferred, 'artist-albums')).toEqual(['Music Has the Right to Children'])
    })

    it('narrows to hearted rows under only, dropping the strands it empties', () => {
      const only = strands('only')
      // Four of the six go, and they go rather than arriving empty — an empty
      // section is a heading over a blank space, per the note on `RelatedResult`.
      expect(only.map((section) => section.strand)).toEqual(['album-tracks', 'genre'])
      expect(titlesIn(only, 'album-tracks')).toEqual(['Beware the Friendly Stranger'])
      expect(titlesIn(only, 'genre')).toEqual(['Amber'])
    })

    it('counts an album as hearted when any of its tracks is', () => {
      // Amber survives `only` in the *genre* strand on the strength of `Foil`
      // alone: the track that carried the matching genre tag and the track that
      // was hearted need not be the same one. And it arrives whole — the album
      // is filtered, not its tracks, so the count is still both of them.
      const section = strands('only').find((candidate) => candidate.strand === 'genre')
      expect(section?.kind === 'albums' ? section.albums.map((a) => a.trackCount) : []).toEqual([2])
    })
  })
})
