import type Database from 'better-sqlite3'
import type { AgentCapability } from '@shared/agentAccess'
import {
  MAX_REPORTED_SKIPS,
  type AgentChangesetOrigin,
  type AgentChangesetSummary,
  type AgentRevertResult,
  type JournalEntityKind,
  type RevertSkippedChange,
  type RevertSkipReason
} from '@shared/agentChangesets'
import { withChangeOrigin, type LibraryChangeNotifier } from '../../library/changes'
import {
  journalJson,
  JournalConflictError,
  type JournalEntities,
  type JournalValue
} from './entities'

/**
 * The agent change journal — **W24-6**, `oscine-mcp` → D36.6.
 *
 * **Recording.** {@link AgentJournal.record} is the write wrapper every agent
 * write tool goes through (W24-7, W24-8, W24-9; no tool writes without it). It
 * reads each target's value, runs the service call, reads them again, and
 * inserts one `agent_changes` row per value that moved — all inside one
 * `BEGIN IMMEDIATE`, so a write and its record commit or roll back together.
 * Services are called, not bypassed (D36.5); their own `db.transaction`s nest
 * as savepoints inside this one.
 *
 * The transaction is held across the service's `await`. Every SQLite service
 * does its writing synchronously before it first yields, so nothing else gets
 * the connection in between — except `clearOverrides`, which reads each file
 * before it writes. A renderer write landing during that read joins this
 * transaction; it commits with it, and is only lost if the agent's own call
 * throws and rolls back, which the services avoid by design (an unreadable
 * file keeps its correction rather than throwing). Journal calls are
 * serialized among themselves, so two agent writes never nest.
 *
 * **Reverting.** {@link AgentJournal.revert} walks a changeset's unreverted
 * changes newest first and restores each one's *before* only while the entity
 * still holds its *after* — the operator's later edit, or another changeset's,
 * is skipped and reported, never overwritten. Each restore runs in its own
 * savepoint, so a failed one leaves nothing half-done; the whole revert is one
 * transaction and one `library.changed`. Restored changes are stamped
 * `reverted_at`, so reverting twice is a no-op.
 */

export interface JournalTarget {
  readonly kind: JournalEntityKind
  readonly entityId: number
  readonly field: string
}

export interface JournalWrite<T> {
  /** Every (entity, field) the call may change. Unchanged ones record nothing. */
  readonly targets: readonly JournalTarget[]
  /** The service call. */
  readonly apply: () => Promise<T>
  /**
   * Entities the call created, known only from its result (a new playlist's
   * id). Their value before is `null` — they did not exist — so name only
   * fields whose absent value reads as `null` (a playlist's `name`); a list
   * field such as `entries` reads `[]` either way and needs no record.
   */
  readonly created?: (result: T) => readonly JournalTarget[]
}

export interface JournalWriteResult<T> {
  readonly result: T
  /** Changes recorded: targets whose value actually moved. */
  readonly recorded: number
}

export interface OpenChangesetInput {
  readonly clientName: string | null
  readonly description: string | null
  readonly origin: AgentChangesetOrigin
}

export interface RevertOptions {
  /**
   * Whether a change of this capability may be reverted. The agent's
   * `revert_changeset` passes the live switches (D36.7); the operator's Revert
   * button passes nothing and may revert everything.
   */
  readonly allowed?: (capability: AgentCapability) => boolean
}

export class ChangesetNotFoundError extends Error {
  constructor(readonly changesetId: number) {
    super(`No changeset has id ${changesetId}.`)
  }
}

export interface AgentJournal {
  openChangeset(input: OpenChangesetInput): number
  /** Stamps `ended_at`. Ending an ended or unknown changeset does nothing. */
  endChangeset(changesetId: number): void
  record<T>(changesetId: number, write: JournalWrite<T>): Promise<JournalWriteResult<T>>
  revert(changesetId: number, options?: RevertOptions): Promise<AgentRevertResult>
  /** Most recent first. */
  list(limit: number, offset?: number): AgentChangesetSummary[]
  count(): number
  get(changesetId: number): AgentChangesetSummary | null
}

export interface AgentJournalDeps {
  db: Database.Database
  entities: JournalEntities
  changes: LibraryChangeNotifier
  now?: () => number
  /** A changeset opened, gained changes, ended or was reverted — Settings refetches. */
  onChanged?: () => void
}

interface ChangeRow {
  id: number
  kind: JournalEntityKind
  entityId: number
  field: string
  before: string
  after: string
}

const SUMMARY_PROJECTION = `
  c.id, c.client_name AS clientName, c.description, c.origin,
  c.started_at AS startedAt, c.ended_at AS endedAt,
  (SELECT COUNT(*) FROM agent_changes x WHERE x.changeset_id = c.id) AS changeCount,
  (SELECT COUNT(*) FROM agent_changes x
    WHERE x.changeset_id = c.id AND x.reverted_at IS NOT NULL) AS revertedCount`

export function createAgentJournal(deps: AgentJournalDeps): AgentJournal {
  const { db, entities, changes } = deps
  const now = deps.now ?? Date.now
  const changed = deps.onChanged ?? (() => {})

  const statements = {
    open: db.prepare(
      `INSERT INTO agent_changesets (client_name, description, origin, started_at)
       VALUES (?, ?, ?, ?) RETURNING id`
    ),
    end: db.prepare('UPDATE agent_changesets SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    exists: db.prepare('SELECT 1 FROM agent_changesets WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO agent_changes
         (changeset_id, entity_kind, entity_id, field, before_json, after_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    pending: db.prepare(
      `SELECT id, entity_kind AS kind, entity_id AS entityId, field,
              before_json AS before, after_json AS after
       FROM agent_changes WHERE changeset_id = ? AND reverted_at IS NULL
       ORDER BY id DESC`
    ),
    markReverted: db.prepare('UPDATE agent_changes SET reverted_at = ? WHERE id = ?'),
    list: db.prepare(
      `SELECT ${SUMMARY_PROJECTION} FROM agent_changesets c
       ORDER BY c.started_at DESC, c.id DESC LIMIT ? OFFSET ?`
    ),
    get: db.prepare(`SELECT ${SUMMARY_PROJECTION} FROM agent_changesets c WHERE c.id = ?`),
    count: db.prepare('SELECT COUNT(*) AS n FROM agent_changesets')
  }

  // A changeset left open is one whose session ended with the last run.
  db.prepare(
    `UPDATE agent_changesets
     SET ended_at = COALESCE(
       (SELECT MAX(recorded_at) FROM agent_changes WHERE changeset_id = agent_changesets.id),
       started_at)
     WHERE ended_at IS NULL`
  ).run()

  let chain: Promise<unknown> = Promise.resolve()
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn)
    chain = next.catch(() => {})
    return next
  }

  function entity(kind: JournalEntityKind) {
    const found = (entities as Partial<JournalEntities>)[kind]
    if (!found) throw new Error(`No journal entity for kind "${kind}".`)
    return found
  }

  function read(target: JournalTarget): string {
    return journalJson(entity(target.kind).read(target.entityId, target.field))
  }

  function dedupe(targets: readonly JournalTarget[]): JournalTarget[] {
    const seen = new Set<string>()
    return targets.filter((target) => {
      const key = `${target.kind}\u0000${target.entityId}\u0000${target.field}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  function rollback(): void {
    if (db.inTransaction) db.exec('ROLLBACK')
  }

  function toSummary(row: AgentChangesetSummary | undefined): AgentChangesetSummary | null {
    return row === undefined ? null : { ...row }
  }

  return {
    openChangeset(input) {
      const { id } = statements.open.get(
        input.clientName,
        input.description,
        input.origin,
        now()
      ) as { id: number }
      changed()
      return id
    },

    endChangeset(changesetId) {
      if (statements.end.run(now(), changesetId).changes > 0) changed()
    },

    record(changesetId, write) {
      return exclusive(() =>
        withChangeOrigin('agent', () =>
          changes.batch(async () => {
            if (statements.exists.get(changesetId) === undefined) {
              throw new ChangesetNotFoundError(changesetId)
            }
            const targets = dedupe(write.targets)
            // Read once outside the transaction so an unknown field fails
            // before anything is opened.
            for (const target of targets) read(target)

            db.exec('BEGIN IMMEDIATE')
            let recorded = 0
            let result: Awaited<ReturnType<typeof write.apply>>
            try {
              const before = targets.map(read)
              result = await write.apply()
              const created = dedupe(write.created?.(result) ?? [])
              const at = now()
              const rows: Array<[JournalTarget, string, string]> = [
                ...targets.map((target, i): [JournalTarget, string, string] => [
                  target,
                  before[i]!,
                  read(target)
                ]),
                ...created.map((target): [JournalTarget, string, string] => [
                  target,
                  journalJson(null),
                  read(target)
                ])
              ]
              for (const [target, from, to] of rows) {
                if (from === to) continue
                statements.insert.run(
                  changesetId,
                  target.kind,
                  target.entityId,
                  target.field,
                  from,
                  to,
                  at
                )
                recorded += 1
              }
              db.exec('COMMIT')
            } catch (error) {
              rollback()
              throw error
            }
            if (recorded > 0) changed()
            return { result, recorded }
          })
        )
      )
    },

    revert(changesetId, options = {}) {
      return exclusive(() =>
        changes.batch(async () => {
          if (statements.exists.get(changesetId) === undefined) {
            throw new ChangesetNotFoundError(changesetId)
          }
          const rows = statements.pending.all(changesetId) as ChangeRow[]
          let restored = 0
          let skipped = 0
          const skippedChanges: RevertSkippedChange[] = []
          const skip = (row: ChangeRow, reason: RevertSkipReason): void => {
            skipped += 1
            if (skippedChanges.length < MAX_REPORTED_SKIPS) {
              skippedChanges.push({
                kind: row.kind,
                entityId: row.entityId,
                field: row.field,
                reason
              })
            }
          }

          db.exec('BEGIN IMMEDIATE')
          try {
            for (const row of rows) {
              const target = { kind: row.kind, entityId: row.entityId, field: row.field }
              let handler
              try {
                handler = entity(row.kind)
              } catch {
                skip(row, 'failed')
                continue
              }
              if (options.allowed && !options.allowed(handler.capability)) {
                skip(row, 'capability')
                continue
              }
              db.exec('SAVEPOINT agent_revert')
              try {
                const current = read(target)
                if (current === row.before) {
                  // Already back where it was — by hand, or by another revert.
                  statements.markReverted.run(now(), row.id)
                  restored += 1
                } else if (current !== row.after) {
                  skip(row, 'conflict')
                } else {
                  const value = JSON.parse(row.before) as JournalValue
                  await handler.write(row.entityId, row.field, value)
                  if (read(target) !== row.before) {
                    throw new Error('The restore did not land on the recorded value.')
                  }
                  statements.markReverted.run(now(), row.id)
                  restored += 1
                }
                db.exec('RELEASE agent_revert')
              } catch (error) {
                db.exec('ROLLBACK TO agent_revert')
                db.exec('RELEASE agent_revert')
                if (!(error instanceof JournalConflictError)) {
                  console.warn('[mcp] a journaled change could not be reverted:', error)
                }
                skip(row, error instanceof JournalConflictError ? 'conflict' : 'failed')
              }
            }
            db.exec('COMMIT')
          } catch (error) {
            rollback()
            throw error
          }
          if (restored > 0) changed()
          return { changesetId, restored, skipped, skippedChanges }
        })
      )
    },

    list(limit, offset = 0) {
      return (statements.list.all(limit, offset) as AgentChangesetSummary[]).map((row) => ({
        ...row
      }))
    },

    count() {
      return (statements.count.get() as { n: number }).n
    },

    get(changesetId) {
      return toSummary(statements.get.get(changesetId) as AgentChangesetSummary | undefined)
    }
  }
}
