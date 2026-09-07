import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import type { ArtistImage } from '@shared/artistImage'
import {
  plainBrowseFilters,
  type AlbumFacet,
  type ArtistFacet,
  type TagFacet
} from '@shared/library'
import { hasArtwork } from '@shared/ipc'
import type { TagCoverage } from '@shared/tags'
import { artists, library } from '@renderer/ipc'
import {
  albumDetail,
  artistDetail,
  focusKind,
  genreDetail,
  MAX_FOCUS_TAGS,
  type FocusKind
} from '@renderer/panels/focusedHeader'
import { useBrowseStore } from '@renderer/stores/browse'
import { useTagsStore } from '@renderer/stores/tags'

/**
 * What the Songs panel heads with when the browse filter is one named source.
 *
 * A store rather than pane state because the library view unmounts on every tab
 * change and the picture and tag coverage should not be asked for again on the
 * way back — they are keyed on the same artist/album id the browse store already
 * kept. The Vue file is the rendering; this is the subject.
 *
 * ## Why this does not share the Tunedeck image store
 *
 * `useArtistImageStore` is "who is playing". This is "who is selected". They
 * are different artists the moment the operator clicks someone else, and a
 * shared singleton would steal the deck's backdrop out from under it.
 *
 * ## D14, without calling `resolve`
 *
 * `artists.image` is still the only way to learn whether a photograph exists,
 * but it is not an identity lookup. Main returns `none` when the local artist
 * row has no MBID — which is every artist the deck has never resolved — so this
 * surface never opens MusicBrainz. A previously resolved artist may already
 * have a Commons file in the artwork cache; that is a cache read, and if it
 * does miss, the consent gate still sits on the socket. The ordinary fallback
 * is the artist's album art, which never left the machine.
 */
export const useFocusedHeaderStore = defineStore('focusedHeader', () => {
  const browse = useBrowseStore()
  const tags = useTagsStore()

  const fetchedArtist = shallowRef<ArtistFacet | null>(null)
  const fetchedAlbum = shallowRef<AlbumFacet | null>(null)
  const photo = shallowRef<ArtistImage | null>(null)
  const coverage = shallowRef<readonly TagCoverage[]>([])

  let imageIssued = 0
  let tagsIssued = 0
  let artistIssued = 0
  let albumIssued = 0

  const kind = computed<FocusKind | null>(() =>
    focusKind({
      albumIds: browse.albums.filterIds.value,
      artistIds: browse.artists.filterIds.value,
      tagKeys: browse.genres.filterKeys.value
    })
  )

  const artistId = computed(() =>
    kind.value === 'artist' ? (browse.artists.filterIds.value?.[0] ?? null) : null
  )
  const albumId = computed(() =>
    kind.value === 'album' ? (browse.albums.filterIds.value?.[0] ?? null) : null
  )
  const tagKey = computed(() =>
    kind.value === 'genre' ? (browse.genres.filterKeys.value?.[0] ?? null) : null
  )

  const artist = computed<ArtistFacet | null>(() => {
    const id = artistId.value
    if (id === null) return null
    return browse.artists.findById(id) ?? fetchedArtist.value
  })

  const album = computed<AlbumFacet | null>(() => {
    const id = albumId.value
    if (id === null) return null
    return browse.albums.findById(id) ?? fetchedAlbum.value
  })

  const genre = computed<TagFacet | null>(() => {
    const key = tagKey.value
    if (key === null) return null
    return browse.genres.rows.value.find((row) => row.key === key) ?? null
  })

  const title = computed(() => {
    if (kind.value === 'artist') return artist.value?.name ?? null
    if (kind.value === 'album') return album.value?.title ?? null
    if (kind.value === 'genre') return genre.value?.label ?? tagKey.value
    return null
  })

  const detail = computed(() => {
    if (kind.value === 'artist') {
      return artistDetail({
        albumCount: browse.albums.total.value,
        trackCount: artist.value?.trackCount ?? null
      })
    }
    if (kind.value === 'album') {
      return albumDetail({
        albumArtist: album.value?.albumArtist ?? null,
        year: album.value?.year ?? null,
        trackCount: album.value?.trackCount ?? null
      })
    }
    if (kind.value === 'genre' && genre.value) {
      return genreDetail({
        hasFile: genre.value.hasFile,
        hasUser: genre.value.hasUser,
        trackCount: genre.value.trackCount
      })
    }
    return ''
  })

  const icon = computed(() => {
    if (kind.value === 'artist') return 'i-tabler-user'
    if (kind.value === 'album') return 'i-tabler-disc'
    if (kind.value === 'genre') return 'i-tabler-tag'
    return 'i-tabler-playlist'
  })

  /**
   * First sleeve on the artist's album page that is real art, not the missing
   * placeholder. Page 0 of the albums pane is already this artist when they are
   * the singular source, so this is a cache read rather than a second query.
   */
  const artistCover = computed<string | null>(() => {
    if (kind.value !== 'artist') return null
    const last = Math.min(browse.albums.total.value, browse.albums.pageSize)
    for (let index = 0; index < last; index++) {
      const url = browse.albums.rowAt(index)?.artwork.large
      if (url && hasArtwork(url)) return url
    }
    return null
  })

  const albumCover = computed<string | null>(() => {
    const url = album.value?.artwork.large
    return url && hasArtwork(url) ? url : null
  })

  const cover = computed(() =>
    kind.value === 'album' ? albumCover.value : kind.value === 'artist' ? artistCover.value : null
  )

  /**
   * Sharp sleeve for the album header. `small` rather than the backdrop's
   * `large`: it is drawn at 56px, and the grouped list already established that
   * 160px is the variant a sleeve reads from. Absent when there is no art —
   * the disc icon stays, rather than a grey square of nothing.
   */
  const sleeve = computed<string | null>(() => {
    if (kind.value !== 'album') return null
    const url = album.value?.artwork.small
    return url && hasArtwork(url) ? url : null
  })

  const focusTags = computed(() => coverage.value.slice(0, MAX_FOCUS_TAGS))

  async function loadCoverage(id: number, request: number): Promise<void> {
    const view = await tags.forArtist(id)
    if (request !== tagsIssued) return
    coverage.value = view.tags
  }

  watch(
    artistId,
    (id) => {
      fetchedArtist.value = null
      photo.value = null
      coverage.value = []
      const facetRequest = ++artistIssued
      const imageRequest = ++imageIssued
      const tagRequest = ++tagsIssued
      if (id === null) return

      if (!browse.artists.findById(id)) {
        void library
          .listArtists({
            ...plainBrowseFilters({
              ...(browse.rootId !== null ? { rootId: browse.rootId } : {}),
              ...(browse.activeSearch !== null ? { searchText: browse.activeSearch } : {}),
              ...(browse.genres.filterKeys.value === undefined
                ? {}
                : { tagKeys: browse.genres.filterKeys.value }),
              artistIds: [id]
            }),
            offset: 0,
            limit: 1
          })
          .then((result) => {
            if (facetRequest !== artistIssued) return
            fetchedArtist.value = result.artists[0] ?? null
          })
          .catch(() => {
            if (facetRequest !== artistIssued) return
            fetchedArtist.value = null
          })
      }

      void artists
        .image(id)
        .then((result) => {
          if (imageRequest !== imageIssued) return
          photo.value = result.image
        })
        .catch(() => {
          if (imageRequest !== imageIssued) return
          photo.value = null
        })

      void loadCoverage(id, tagRequest)
    },
    { immediate: true }
  )

  watch(
    albumId,
    (id) => {
      fetchedAlbum.value = null
      const request = ++albumIssued
      if (id === null) return
      if (browse.albums.findById(id)) return
      void library
        .listAlbums({
          ...plainBrowseFilters({
            ...browse.currentFilters
          }),
          offset: 0,
          limit: 1
        })
        .then((result) => {
          if (request !== albumIssued) return
          fetchedAlbum.value = result.albums[0] ?? null
        })
        .catch(() => {
          if (request !== albumIssued) return
          fetchedAlbum.value = null
        })
    },
    { immediate: true }
  )

  watch(
    () => tags.changed?.seq ?? 0,
    () => {
      const id = artistId.value
      if (id === null) return
      const request = ++tagsIssued
      void loadCoverage(id, request)
    }
  )

  return {
    kind,
    artistId,
    title,
    detail,
    icon,
    photo,
    cover,
    sleeve,
    focusTags,
    artist,
    album,
    genre
  }
})
