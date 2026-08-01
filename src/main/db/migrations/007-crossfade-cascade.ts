import type { Migration } from '../migrate'

/**
 * The per-playlist crossfade column becomes an override row on
 * `audio.crossfadeMs`.
 *
 * W8-5's premise is that "this playlist plays differently" has one resolution
 * path. `playlists.crossfade_ms` was the ad-hoc one — its own column, its own
 * IPC channel, and its own answer to "is this inherited or set here?" that no
 * other per-entity value could reuse. After this there is no settings column
 * outside `settings`.
 *
 * ## Which values move
 *
 * Non-zero ones. The column is `NOT NULL DEFAULT 0`, so a zero in it is
 * indistinguishable from a playlist nobody ever touched — and every playlist
 * ever created without an explicit crossfade holds one. Migrating those would
 * write an explicit "always gapless" override onto every playlist in the
 * library, pinning each of them against a global the operator later changes.
 * That is the opposite of preserving a choice.
 *
 * The cost is real and worth naming: a playlist deliberately set to 0 to force
 * gapless against a non-zero global loses that, and inherits instead. The column
 * cannot tell the two cases apart, so this is a judgement about which reading is
 * more often true rather than a lossless move. Under the new shape the
 * distinction is representable — an override row holding 0 is exactly "gapless,
 * explicitly" — so it is only this one-way step that has to choose.
 *
 * `NOT EXISTS` rather than `INSERT OR IGNORE`: an override row that somehow
 * already exists was written deliberately and is newer than a column this
 * migration is retiring, so it wins. Spelling the condition out keeps that a
 * decision rather than a swallowed constraint failure.
 *
 * Version 1 is hardcoded because it is the version `audio.crossfadeMs` had when
 * this migration was written. A later bump does not come back to edit this —
 * `migrateValue` upgrades the row on read, which is the whole reason the column
 * is there.
 */
export const crossfadeCascade: Migration = {
  version: 7,
  name: 'crossfade-cascade',
  sql: `
INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at)
SELECT 'audio.crossfadeMs', 'playlist', p.id, CAST(p.crossfade_ms AS TEXT), 1, p.updated_at
FROM playlists p
WHERE p.crossfade_ms > 0
  AND NOT EXISTS (
    SELECT 1 FROM settings s
    WHERE s.key = 'audio.crossfadeMs'
      AND s.scope_kind = 'playlist'
      AND s.scope_id = p.id
  );

ALTER TABLE playlists DROP COLUMN crossfade_ms;
`
}
