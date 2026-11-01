/**
 * The agent change journal's shared vocabulary — **W24-6**, `oscine-mcp` → D36.6.
 *
 * Main records every agent write into a changeset; Settings → Agent access
 * lists recent changesets and reverts one. A revert is conflict-aware: a change
 * is restored only while the entity still holds the value the agent left, so it
 * never overwrites a later edit by the operator or another changeset.
 */

/**
 * What a journaled change is about. Mirrors the `library.changed` kinds
 * (D36.9), with `playlist` for the playlist row's own fields.
 */
export const JOURNAL_ENTITY_KINDS = [
  'playlist',
  'playlistEntries',
  'override',
  'tagOverride',
  'tags'
] as const

export type JournalEntityKind = (typeof JOURNAL_ENTITY_KINDS)[number]

/** How a changeset was opened: by `begin_changeset`, or by a session's first write. */
export type AgentChangesetOrigin = 'explicit' | 'session'

export interface AgentChangesetSummary {
  readonly id: number
  readonly clientName: string | null
  readonly description: string | null
  readonly origin: AgentChangesetOrigin
  /** UTC ms. */
  readonly startedAt: number
  /** UTC ms; null while the changeset is still open. */
  readonly endedAt: number | null
  /** Changes recorded. */
  readonly changeCount: number
  /** Changes a revert has restored. Equal to `changeCount` once fully reverted. */
  readonly revertedCount: number
}

/** Why a revert left a change as it was. */
export type RevertSkipReason =
  /** The value is no longer the one the agent left: someone edited it since. */
  | 'conflict'
  /** The write to restore it failed, or did not land on the old value. */
  | 'failed'
  /** The agent asked, and the capability that change belongs to is off. */
  | 'capability'

export interface RevertSkippedChange {
  readonly kind: JournalEntityKind
  readonly entityId: number
  readonly field: string
  readonly reason: RevertSkipReason
}

export interface AgentRevertResult {
  readonly changesetId: number
  /** Changes put back to their value before the agent. */
  readonly restored: number
  /** Changes left alone; see `skippedChanges`. */
  readonly skipped: number
  /** The first {@link MAX_REPORTED_SKIPS} skipped changes. */
  readonly skippedChanges: readonly RevertSkippedChange[]
}

/** The most skipped changes a revert result lists; `skipped` counts them all. */
export const MAX_REPORTED_SKIPS = 50

/** The most changesets the Settings list asks for. */
export const MAX_CHANGESET_LIST = 100

export interface ListAgentChangesetsRequest {
  readonly limit: number
}

export interface RevertAgentChangesetRequest {
  readonly changesetId: number
}

/** "3 restored, 1 skipped because it was edited since" — the result summary. */
export function describeRevert(result: AgentRevertResult): string {
  if (result.restored === 0 && result.skipped === 0) return 'Nothing left to revert.'
  const parts = [`${result.restored} restored`]
  if (result.skipped > 0) {
    const conflicts = result.skippedChanges.filter((change) => change.reason === 'conflict').length
    parts.push(
      conflicts === result.skipped
        ? `${result.skipped} skipped because ${result.skipped === 1 ? 'it was' : 'they were'} edited since`
        : `${result.skipped} skipped`
    )
  }
  return `${parts.join(', ')}.`
}
