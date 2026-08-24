import type { SearchEntityKind, SearchHit } from '@shared/search'

/**
 * What selecting a palette hit does — the shell's tab-level activation.
 *
 * This card wires navigation to the tab an entity lives on and no further: a
 * hit takes the operator to where the thing can be found. Deep targets — landing
 * on a specific playlist or artist — are W13-7's, layered on top of this through
 * the router. Pure and DOM-free so the "select navigates and closes" behaviour
 * is tested without a mounted palette.
 */

/**
 * The tab an entity kind lives on. `view` hits carry their own tab id and pass
 * it directly, so the branch here is only the fallback.
 */
export function homeTabForKind(kind: SearchEntityKind): string {
  switch (kind) {
    case 'playlist':
      return 'curate'
    case 'show':
      return 'podcasts'
    case 'view':
    case 'album':
    case 'artist':
    case 'track':
      return 'library'
  }
}

export interface PaletteSelection {
  /** The route name to switch to. */
  readonly tab: string
}

export interface SelectionDeps {
  navigate: (tab: string) => void
  close: () => void
}

/**
 * Runs a selection: navigate, then close. The order matters only in that the
 * palette should be gone by the time the destination paints.
 */
export function performSelection(selection: PaletteSelection, deps: SelectionDeps): void {
  deps.navigate(selection.tab)
  deps.close()
}

export interface HitActivationDeps {
  /** Play an album, through the same list order Library and Discover use. */
  playAlbum: (albumId: number) => void
  /** Play one track now, its own list of one. */
  playTrack: (trackId: number) => void
  /** Land Curate on a playlist. The `navigate` below takes the view there. */
  openPlaylist: (playlistId: number) => void
  /** Open a show's tab in Podcasts, so its download progress is on screen. */
  openShow: (podcastId: number) => void
  /** Download a show's latest episode — the W9 downloader, with a toast. */
  downloadLatestEpisode: (podcastId: number) => void
  navigate: (tab: string) => void
  close: () => void
}

/**
 * What selecting an *entity* hit does — the deep half W13-7 layers onto W13-5's
 * tab navigation.
 *
 * Album and track are activated where they sit, through the store gestures
 * Library and Discover already use (product rule 5 — no second play-order
 * builder); the playback surface is the confirmation, so there is no toast.
 * Playlist opens its Curate tab and the navigation lands on it. Artist
 * navigates to where it lives. A show downloads its latest episode (D22 — the
 * palette dispatches, the Podcasts view owns the progress), opening its tab and
 * landing there so the download is visible. Always closes, per D22.
 *
 * Pure and injected for the same reason `performSelection` is: the verb per
 * kind is decided here and tested without a store or a mounted palette.
 */
export function activateHit(hit: SearchHit, deps: HitActivationDeps): void {
  switch (hit.kind) {
    case 'album':
      deps.playAlbum(hit.id)
      break
    case 'track':
      deps.playTrack(hit.id)
      break
    case 'playlist':
      deps.openPlaylist(hit.id)
      deps.navigate(homeTabForKind('playlist'))
      break
    case 'artist':
      deps.navigate(homeTabForKind('artist'))
      break
    case 'show':
      deps.openShow(hit.id)
      deps.downloadLatestEpisode(hit.id)
      deps.navigate(homeTabForKind('show'))
      break
    case 'view':
      break
  }
  deps.close()
}
