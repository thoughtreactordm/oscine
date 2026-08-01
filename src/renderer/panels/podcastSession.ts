/**
 * Open podcast show tabs — workspace state, like playlist session.
 *
 * Lives in renderer storage, never crosses IPC. Closing a show tab does not
 * unsubscribe; the subscription rail is where closed shows live.
 */

export interface PodcastSession {
  openIds: number[]
  viewedId: number | null
  /** Episode to scroll into view once its show tab is open. */
  focusEpisodeId: number | null
}

export interface PodcastSessionStorage {
  read(): string | null
  write(value: string): void
}

const STORAGE_KEY = 'fermata.podcastSession.v1'

export function browserPodcastSessionStorage(): PodcastSessionStorage {
  return {
    read: () => {
      try {
        return localStorage.getItem(STORAGE_KEY)
      } catch {
        return null
      }
    },
    write: (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, value)
      } catch {
        // Quota / private mode — session is best-effort.
      }
    }
  }
}

export function parsePodcastSession(raw: string | null): PodcastSession {
  if (raw === null || raw === '') {
    return { openIds: [], viewedId: null, focusEpisodeId: null }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PodcastSession>
    // Duplicates would render one show as two tabs that select each other.
    const openIds = Array.isArray(parsed.openIds)
      ? [...new Set(parsed.openIds.filter(isPodcastId))]
      : []
    const viewedId = isPodcastId(parsed.viewedId) ? parsed.viewedId : null
    return {
      openIds,
      viewedId: viewedId !== null && openIds.includes(viewedId) ? viewedId : null,
      // A scroll target is a one-shot instruction to the show pane, not state.
      // Restoring one would yank the list on launch.
      focusEpisodeId: null
    }
  } catch {
    return { openIds: [], viewedId: null, focusEpisodeId: null }
  }
}

function isPodcastId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function serializePodcastSession(session: PodcastSession): string {
  return JSON.stringify({
    openIds: session.openIds,
    viewedId: session.viewedId
  })
}
