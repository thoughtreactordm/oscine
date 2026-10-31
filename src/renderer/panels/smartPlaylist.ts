import type { PlaylistExclusion } from '@shared/playlists'

/**
 * Smart playlists in the renderer — **W24-9**, `oscine-mcp` → D36.8.
 *
 * Pure, DOM-free and `@renderer`-free, so the copy and the draft rules are
 * unit-tested without a component.
 *
 * The copy says what the flag means. "Smart" elsewhere means rule-evaluated;
 * here it means the operator's own agent keeps it up to date when asked, and
 * nothing in the app ever asks for them. There is deliberately no control that
 * starts an agent.
 */

export const SMART_PLAYLIST_ICON = 'i-tabler-refresh-dot'

export const SMART_PLAYLIST_LABEL = 'Smart: kept up to date by your agent'

/** The brief as it would be saved: trimmed, blank meaning none. */
export function normalizeBrief(draft: string): string | null {
  const trimmed = draft.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** Whether the draft differs from what is stored, so Save has something to do. */
export function briefChanged(draft: string, stored: string | null): boolean {
  return normalizeBrief(draft) !== stored
}

/** One excluded track's line in the header: its title, else its id. */
export function exclusionLabel(exclusion: PlaylistExclusion): string {
  const title = exclusion.title?.trim() || `Track ${exclusion.trackId}`
  const artist = exclusion.artist?.trim()
  return artist ? `${title} — ${artist}` : title
}

/** Who excluded it, said plainly. */
export function exclusionSourceLabel(exclusion: PlaylistExclusion): string {
  return exclusion.source === 'operator' ? 'Removed by you' : 'Removed by your agent'
}

/** "Last refreshed …", or that no agent has yet. */
export function refreshedLabel(refreshedAt: string | null, locale?: string): string {
  if (refreshedAt === null) return 'Not refreshed by an agent yet'
  const when = new Date(refreshedAt)
  if (Number.isNaN(when.getTime())) return 'Not refreshed by an agent yet'
  return `Last refreshed ${when.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}`
}
