import type { Migration } from '../migrate'

/**
 * `interface.theme` becomes `theme.mode`.
 *
 * W8-12 gave theming its own settings category — a token editor over ~30 named
 * tokens is a section, not a row — and left the one key most obviously about
 * theming sitting outside it. This carries the stored row across.
 *
 * ## Why a migration rather than an upgrade
 *
 * The kernel's `version` / `upgrade` machinery upgrades a *value* across shape
 * changes for a key that keeps its name. It has nothing to say about a rename,
 * and deliberately so: a renamed key is indistinguishable from an unknown one
 * at read time, and unknown keys are preserved rather than resolved. Left to
 * that path, `interface.theme` would have survived untouched and been ignored
 * forever while `theme.mode` quietly reported its default — the operator's
 * choice intact on disk and invisible in the app, which is the worst of both.
 *
 * ## Which rows move
 *
 * Only global ones. `interface.theme` never cascaded — a per-playlist colour
 * scheme is not a thing this app has ever offered — so a row at any other scope
 * would be something no build wrote, and moving it would be inventing intent.
 *
 * `NOT EXISTS` rather than `INSERT OR REPLACE`, matching `007`: a `theme.mode`
 * row that somehow already exists was written by a build that already knew the
 * new name, which makes it newer than the one being retired. Spelling the
 * condition out keeps that a decision rather than a swallowed conflict.
 *
 * The old row is deleted afterwards. Leaving it would be harmless — it would
 * resolve as an unknown key and be handed back to disk untouched — but it would
 * also silently reappear as an override the day anything else claims that name,
 * and `theme.mode` is now the only answer to the question it asked.
 *
 * Version 1 is hardcoded because that is the version the key had when this was
 * written, for the same reason `007` hardcodes it: `migrateValue` upgrades the
 * row on read.
 */
export const themeKeys: Migration = {
  version: 8,
  name: 'theme-keys',
  sql: `
INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at)
SELECT 'theme.mode', s.scope_kind, s.scope_id, s.value, 1, s.updated_at
FROM settings s
WHERE s.key = 'interface.theme'
  AND s.scope_kind = 'global'
  AND NOT EXISTS (
    SELECT 1 FROM settings t
    WHERE t.key = 'theme.mode'
      AND t.scope_kind = 'global'
      AND t.scope_id IS s.scope_id
  );

DELETE FROM settings WHERE key = 'interface.theme';
`
}
