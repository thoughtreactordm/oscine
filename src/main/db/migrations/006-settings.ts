import type { Migration } from '../migrate'

/**
 * Durable settings, one row per key per scope.
 *
 * `value` is JSON rather than a typed column because the registry decides what a
 * key holds and that can be a boolean, a number or a record; `version` is the
 * descriptor version the value was *written* under, which is what lets a read
 * run the upgrade chain instead of guessing.
 *
 * `scope_kind`/`scope_id` address the cascade W8-5 builds. They are laid in now
 * and left unused because a primary key is the one thing that cannot be widened
 * later without rewriting the table.
 *
 * The extra unique index is not redundant. SQLite does not imply NOT NULL on
 * PRIMARY KEY columns of a rowid table, and a unique index treats two NULLs as
 * distinct — so the declared key permits *two* global rows for `audio.crossfadeMs`,
 * and a read would then pick between them by whichever the query planner reached
 * first. Folding the null into a sentinel is what makes the constraint real.
 */
export const settings: Migration = {
  version: 6,
  name: 'settings',
  sql: `
CREATE TABLE settings (
  key         TEXT    NOT NULL,
  scope_kind  TEXT    NOT NULL,
  scope_id    INTEGER,
  value       TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (key, scope_kind, scope_id)
);

CREATE UNIQUE INDEX settings_identity ON settings(key, scope_kind, COALESCE(scope_id, -1));

CREATE INDEX settings_scope ON settings(scope_kind, scope_id);
`
}
