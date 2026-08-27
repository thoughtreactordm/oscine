import { useRouter } from 'vue-router'
import type { Track } from '@shared/library'
import { useBrowseStore } from '@renderer/stores/browse'
import { useTrackInfoStore } from '@renderer/stores/trackInfo'

/**
 * The identity half of the shared track menu (**G8**): View artist, View album,
 * Track info. Bound once per surface and handed to `trackMenuItems`.
 *
 * ## Reveal is by text, not by facet id
 *
 * A row carries its artist and album as *names* — the renderer has no cheap way
 * to turn one into a facet id — so View artist/album put the phrase in the
 * library search box and move the frame there, the honest route Now Playing's
 * bar menu already took (see its `reveal`). Naming text that resolves to no facet
 * is visible and editable in the box rather than an approximation hidden inside a
 * query. `null` in means an untagged file, and the caller renders that verb
 * disabled rather than following nothing.
 */
export function useTrackActions() {
  const browse = useBrowseStore()
  const router = useRouter()
  const trackInfo = useTrackInfoStore()

  async function reveal(text: string): Promise<void> {
    browse.revealSearch(text)
    await router.push({ name: 'library' })
  }

  function viewArtist(name: string | null): (() => void) | null {
    return name === null ? null : () => void reveal(name)
  }

  function viewAlbum(name: string | null): (() => void) | null {
    return name === null ? null : () => void reveal(name)
  }

  /** The artist a track's "View artist" follows: album artist, else track artist. */
  function artistOf(track: Track): string | null {
    return track.albumArtist ?? track.artist
  }

  function showInfo(track: Track): () => void {
    return () => trackInfo.show(track)
  }

  return { reveal, viewArtist, viewAlbum, artistOf, showInfo }
}
