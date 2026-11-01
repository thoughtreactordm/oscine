import type { AgentJournal, JournalWrite, JournalWriteResult } from './journal'

/**
 * One MCP session's view of the journal — **W24-6**, D36.6.
 *
 * Holds the session's open changeset. `begin_changeset` ends whatever was open
 * and opens an explicit one; a write with none open opens an implicit,
 * session-wide one on the spot, so every agent write has a changeset and the
 * session that made nothing opens nothing. The session closing ends it.
 *
 * Write tools call {@link AgentSessionJournal.write} and nothing else: it is
 * the journal's write wrapper with the changeset filled in and the title-bar
 * "writing" indicator (D36.10) held for the duration.
 */
export interface AgentSessionJournal {
  /** The open changeset's id, or null when this session has none open. */
  current(): number | null
  /** Ends the open changeset (if any) and opens an explicit one. Returns its id. */
  begin(description: string): number
  /** Ends the open changeset, if any. */
  end(): void
  write<T>(write: JournalWrite<T>): Promise<JournalWriteResult<T> & { changesetId: number }>
}

export interface AgentSessionJournalOptions {
  journal: AgentJournal
  /** The client's self-reported name, read when a changeset opens. */
  clientName: () => string | null
  /** Marks a write in flight; returns the function that ends it. */
  beginWrite?: () => () => void
}

export function createSessionJournal(options: AgentSessionJournalOptions): AgentSessionJournal {
  const { journal } = options
  const beginWrite = options.beginWrite ?? (() => () => {})
  let open: number | null = null

  function end(): void {
    if (open === null) return
    journal.endChangeset(open)
    open = null
  }

  return {
    current: () => open,

    begin(description) {
      end()
      open = journal.openChangeset({
        clientName: options.clientName(),
        description,
        origin: 'explicit'
      })
      return open
    },

    end,

    async write(write) {
      if (open === null) {
        open = journal.openChangeset({
          clientName: options.clientName(),
          description: null,
          origin: 'session'
        })
      }
      const changesetId = open
      const done = beginWrite()
      try {
        return { ...(await journal.record(changesetId, write)), changesetId }
      } finally {
        done()
      }
    }
  }
}
