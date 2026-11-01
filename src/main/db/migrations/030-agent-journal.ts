import type { Migration } from '../migrate'

/**
 * The agent change journal — **W24-6**, `oscine-mcp` → D36.6.
 *
 * Every write an agent makes is recorded here as it is made: which entity, which
 * field, and the value before and after, each as JSON. A changeset groups the
 * writes of one task (opened by `begin_changeset`) or, failing that, of one MCP
 * session, so the operator can take the whole of it back at once.
 *
 * - `agent_changesets.origin` is `'explicit'` (the agent named the task) or
 *   `'session'` (opened implicitly by the session's first write).
 * - `agent_changes.entity_id` has no foreign key on purpose. The entity is a
 *   playlist or a track, and either can be deleted after the change; the row
 *   survives so a revert can report it as skipped rather than lose it.
 * - `reverted_at` is set on a change once a revert has restored it, which is
 *   what makes a second revert of the same changeset a no-op. A change a revert
 *   skipped keeps it NULL, so a later revert tries it again (and again only
 *   restores it if the value is still the agent's).
 *
 * Machine-local: excluded from the export bundle like `play_history`
 * (`src/main/bundle/tables.ts`). Not readable through `query_library`, whose
 * allowlist is the `mcp_*` views.
 */
export const agentJournal: Migration = {
  version: 30,
  name: 'agent-journal',
  sql: `
CREATE TABLE agent_changesets (
  id          INTEGER PRIMARY KEY,
  client_name TEXT,
  description TEXT,
  origin      TEXT    NOT NULL,          -- 'explicit' | 'session'
  started_at  INTEGER NOT NULL,          -- UTC ms
  ended_at    INTEGER                    -- NULL while the changeset is open
);

CREATE TABLE agent_changes (
  id           INTEGER PRIMARY KEY,
  changeset_id INTEGER NOT NULL REFERENCES agent_changesets(id) ON DELETE CASCADE,
  entity_kind  TEXT    NOT NULL,         -- 'playlist' | 'playlistEntries' | 'override' | 'tagOverride' | 'tags'
  entity_id    INTEGER NOT NULL,         -- playlist id or track id; no FK, see above
  field        TEXT    NOT NULL,
  before_json  TEXT    NOT NULL,
  after_json   TEXT    NOT NULL,
  recorded_at  INTEGER NOT NULL,         -- UTC ms
  reverted_at  INTEGER                   -- UTC ms; NULL until a revert restores it
);

CREATE INDEX idx_agent_changes_changeset ON agent_changes(changeset_id, id);
CREATE INDEX idx_agent_changesets_started ON agent_changesets(started_at);
`
}
