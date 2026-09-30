import type { Migration } from '../migrate'

/**
 * `track_tag_overrides` — the generic correction layer, **W16-15**, design
 * authority `oscine-tag-writeback` → "The full tag surface", Decision E.
 *
 * The grouped fields keep a column each on `track_overrides`, because each one
 * re-keys the browse and needs hand-written apply/revert. The generic fields —
 * credits, totals, sort fields, MusicBrainz ids and the rest — touch nothing the
 * library indexes, so they share one key/value table instead of forty columns.
 * Adding a field is a registry entry (`src/shared/tagFields.ts`), not a
 * migration.
 *
 * The row is **tri-state** per field, the same distinction a text override and
 * `artwork_overrides` draw between clear and absent:
 *
 * - no row → the file's own value;
 * - `value` a JSON value → set the field to it;
 * - `value` the JSON literal `null` → clear the frame on flush.
 *
 * `field` is a registry key, deliberately not constrained: a row whose key this
 * build does not know (a branch switch, a field withdrawn from the registry) is
 * preserved, not dropped, so the correction survives until a build that knows it
 * returns. `ON DELETE CASCADE` from `tracks` matches the other override tables.
 * No `tracks` column and no scan-path change: generic fields are read from the
 * file on demand, never indexed.
 */
export const trackTagOverrides: Migration = {
  version: 26,
  name: 'track-tag-overrides',
  sql: `
    CREATE TABLE track_tag_overrides (
      track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      field      TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (track_id, field)
    ) WITHOUT ROWID;
  `
}
