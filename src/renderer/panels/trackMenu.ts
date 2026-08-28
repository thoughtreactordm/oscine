import type { ContextMenuItem } from '@nuxt/ui'
import { queueCommandLabel } from '@renderer/playback/queueCommands'
import { editMetadataMenuItem } from '@renderer/panels/metadataMenu'

/**
 * The one single-track context menu, as data — **G8**.
 *
 * The card's ask was that every surface offering per-track controls offer *the
 * same* controls in the same order with the same wording: the library row, the
 * playlist row, the queue row, a Curate card, and Now Playing's 3-dot menu were
 * five hand-rolled menus drifting apart (the library list had no Play; the
 * playlist pane had one; Now Playing had View artist/album and nothing else).
 * This is where the set is decided, so a sixth surface inherits it rather than
 * restating it.
 *
 * ## Why callbacks rather than a track
 *
 * The verbs resolve differently per surface — the library plays from its browse
 * predicate, a Curate card plays one track, a queue row jumps in place — and the
 * queue plumbing is count-aware in a way a single track is not. So this takes the
 * already-bound actions and only owns their *labels, icons and order*. A `null`
 * action is a verb this surface does not have, and it is dropped rather than
 * shown disabled — a queued row's "Add to queue" would enqueue a second copy, and
 * offering it would be offering a mistake.
 *
 * The two exceptions are `viewArtist`/`viewAlbum`: a `null` there is an untagged
 * file with no artist or album to follow, and *that* is shown disabled, because
 * the verb exists on this surface and the file is what is missing — hiding it
 * would read as the menu being broken rather than the tag being absent, the same
 * call Now Playing's menu already made.
 */
export interface TrackMenuActions {
  /** Play now. `null` on the track that is already playing, where it is a no-op. */
  play: (() => void) | null
  /** Insert at the head of the queue. `null` on a row already in the queue. */
  playNext: (() => void) | null
  /** Append to the queue. `null` on a row already in the queue. */
  addToQueue: (() => void) | null
  /** The add-to-playlist submenu, authored by `addToPlaylist.menuItem(...)`. */
  addToPlaylist: ContextMenuItem
  /** Reveal the artist, or `null` for an untagged file — shown disabled. */
  viewArtist: (() => void) | null
  /** Reveal the album, or `null` for an untagged file — shown disabled. */
  viewAlbum: (() => void) | null
  /** Open the Track Info dialog. */
  trackInfo: () => void
  /** Open the metadata editor scoped to this track (**W16 editor**). */
  editMetadata: () => void
}

/** Flattens groups into one list, separated only between non-empty groups. */
function joinGroups(groups: ContextMenuItem[][]): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  for (const group of groups) {
    if (group.length === 0) continue
    if (items.length > 0) items.push({ type: 'separator' })
    items.push(...group)
  }
  return items
}

export function trackMenuItems(actions: TrackMenuActions): ContextMenuItem[] {
  const playback: ContextMenuItem[] = []
  if (actions.play) {
    playback.push({ label: 'Play', icon: 'i-tabler-player-play', onSelect: actions.play })
  }
  if (actions.playNext) {
    playback.push({
      label: queueCommandLabel('playNext', 1),
      icon: 'i-tabler-corner-right-down',
      onSelect: actions.playNext
    })
  }
  if (actions.addToQueue) {
    playback.push({
      label: queueCommandLabel('addToQueue', 1),
      icon: 'i-tabler-list-numbers',
      onSelect: actions.addToQueue
    })
  }

  return joinGroups([
    playback,
    [actions.addToPlaylist],
    [
      {
        label: 'View artist',
        icon: 'i-tabler-user',
        disabled: actions.viewArtist === null,
        onSelect: actions.viewArtist ?? undefined
      },
      {
        label: 'View album',
        icon: 'i-tabler-vinyl',
        disabled: actions.viewAlbum === null,
        onSelect: actions.viewAlbum ?? undefined
      }
    ],
    [{ label: 'Track info', icon: 'i-tabler-info-circle', onSelect: actions.trackInfo }],
    [editMetadataMenuItem(actions.editMetadata)]
  ])
}
