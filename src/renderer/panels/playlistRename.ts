import { ref } from 'vue'
import { MAX_PLAYLIST_NAME_LENGTH, type Playlist } from '@shared/playlists'

/**
 * Renaming a playlist in place, for whichever list the operator happened to be
 * looking at.
 *
 * Shared because a playlist can be renamed from two surfaces now — F2 or a
 * double-click on its tab, F2 or the context menu on its rail row — and two
 * copies of "blank is a cancel, unchanged costs no round trip" would be two
 * copies that eventually disagree about one of them.
 */

/** Re-exported so a rename input can bound itself at the same value the IPC boundary does. */
export const PLAYLIST_NAME_MAX_LENGTH = MAX_PLAYLIST_NAME_LENGTH

export interface PlaylistRenameDeps {
  /** The playlist a rename is starting on, or `null` if it has gone. */
  find(playlistId: number): Playlist | null
  commit(playlistId: number, name: string): Promise<void>
}

export function createPlaylistRename(deps: PlaylistRenameDeps) {
  const renamingId = ref<number | null>(null)
  const draft = ref('')
  /** What it was called when the rename began, so an unchanged name costs no round trip. */
  const origin = ref('')

  function begin(playlistId: number): boolean {
    const target = deps.find(playlistId)
    if (target === null) return false
    renamingId.value = playlistId
    origin.value = target.name
    draft.value = target.name
    return true
  }

  function cancel(): void {
    renamingId.value = null
    origin.value = ''
    draft.value = ''
  }

  /**
   * Commits the draft, or silently keeps the old name.
   *
   * Blank is a cancel rather than an error: `assertPlaylistName` rejects an
   * empty name at the boundary, so sending one would surface a validation notice
   * for a gesture — select-all, Delete, click away — that plainly meant "never
   * mind". Trimming here matches what the main process would have stored anyway,
   * which keeps an unchanged-name commit off the wire.
   */
  async function commit(): Promise<void> {
    const playlistId = renamingId.value
    const name = draft.value.trim()
    const was = origin.value.trim()
    cancel()
    if (playlistId === null) return
    if (name.length === 0 || name === was) return
    await deps.commit(playlistId, name)
  }

  return { renamingId, draft, begin, cancel, commit }
}

export type PlaylistRename = ReturnType<typeof createPlaylistRename>
