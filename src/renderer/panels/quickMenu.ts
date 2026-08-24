import type { AlbumCard } from '@shared/albums'
import type { FavoriteArtist } from '@shared/favorites'
import type { Playlist } from '@shared/playlists'

/**
 * The Quick Menu's data and verbs — **D26**, product rules 8 and 9.
 *
 * The drawer on Now Playing is three short lists recomputed every time it opens:
 * Favorite Playlists, Recent Additions, Favorite Artists. This module is the
 * half that has no DOM — the load and the per-kind activation — split out for
 * `paletteActivation`'s reason: the verb a row runs is decided and tested here,
 * without a mounted drawer or a live store.
 *
 * The verbs are the ones Library, Discover and the palette already use (product
 * rule 5 — no second play-order builder, no second reveal): a playlist opens its
 * Curate tab and the view lands on it, an album plays through the shared list
 * order, an artist is revealed in the Library facets. Every one closes the
 * drawer after, so a selection is always a way *out* of the menu.
 */

/** The three lists, as one open's worth of reads. */
export interface QuickMenuLists {
  readonly playlists: Playlist[]
  readonly albums: AlbumCard[]
  readonly artists: FavoriteArtist[]
}

/**
 * The three channels the drawer reads, each capped at `limit`.
 *
 * Injected rather than reached for so the load is tested against fakes: the
 * component wires these to `favorites.listPlaylists`, `library.recentlyAddedAlbums`
 * and `favorites.listArtists`, unwrapping each result to its array.
 */
export interface QuickMenuSources {
  playlists: (limit: number) => Promise<Playlist[]>
  albums: (limit: number) => Promise<AlbumCard[]>
  artists: (limit: number) => Promise<FavoriteArtist[]>
}

/**
 * One open's worth of reads, in parallel.
 *
 * All three at once because they share nothing and a drawer that paints its
 * three lists one round trip after another reads as slower than it is. Called
 * afresh on every open — that *is* "recomputed on open" (product rule 8), and it
 * is why a favorite toggled or an album imported between two opens shows up the
 * second time with no subscription anywhere.
 */
export async function loadQuickMenu(
  sources: QuickMenuSources,
  limit: number
): Promise<QuickMenuLists> {
  const [playlists, albums, artists] = await Promise.all([
    sources.playlists(limit),
    sources.albums(limit),
    sources.artists(limit)
  ])
  return { playlists, albums, artists }
}

/**
 * What selecting a Quick Menu row does — one verb per list, injected and pure.
 *
 * The Quick Menu is a *play* surface, not a navigator: a row starts the thing
 * and closes the drawer, it does not take the operator to where the thing lives.
 * Each verb adopts the play order that surface already uses — a playlist plays in
 * its entry order, an album and an artist in the library order narrowed to them
 * (product rule 5, no second play-order builder). None of them navigates.
 */
export interface QuickMenuActivationDeps {
  /** Play a whole playlist in its entry order. */
  playPlaylist: (playlistId: number) => void
  /** Play an album, through the same list order Library and Discover use. */
  playAlbum: (albumId: number) => void
  /** Play everything by an artist, in the library order narrowed to them. */
  playArtist: (artistId: number) => void
  close: () => void
}

/** Plays a favorite playlist and closes. The transport is the confirmation. */
export function activatePlaylist(playlistId: number, deps: QuickMenuActivationDeps): void {
  deps.playPlaylist(playlistId)
  deps.close()
}

/** Plays a recent album and closes. */
export function activateAlbum(albumId: number, deps: QuickMenuActivationDeps): void {
  deps.playAlbum(albumId)
  deps.close()
}

/** Plays everything by a favorite artist and closes. */
export function activateArtist(artistId: number, deps: QuickMenuActivationDeps): void {
  deps.playArtist(artistId)
  deps.close()
}
