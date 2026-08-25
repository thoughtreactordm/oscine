import { settingsInScope, type SettingDescriptor } from '@shared/settings'
import { LEGACY_VIEW_STORAGE_PREFIX, VIEW_STORAGE_PREFIX, type ViewStorageArea } from './viewStore'

/**
 * Moves a pre-rename profile's view keys onto the current prefix, once.
 *
 * The Oscine rename changed the namespace the view store writes under, from
 * `fermata.view.*` to `oscine.view.*`. Every entry a pre-rename build left
 * behind is otherwise a pane size, open tab or column layout the store no
 * longer looks for — so the first launch after the rename would paint defaults
 * and read as a wipe. This copies each known key across before the store's
 * first `load`, then removes the old one.
 *
 * Bounded to the `view`-scoped descriptors on purpose, the same rule the store
 * itself follows: a `fermata.view.*` entry with no descriptor is one a
 * neighbouring build owns and the store never read, so leaving it untouched is
 * how it was always going to be treated. Enumerating storage instead would risk
 * dragging such a key onto the new prefix under a shape this build cannot
 * validate.
 *
 * Idempotent by construction. A value already at the new address wins — a build
 * that has run since the rename knows more than a stale pre-rename blob — and
 * the old key is removed only after the copy, so a crash in between re-runs the
 * move rather than dropping the value at neither address. Returns the keys it
 * moved, for a test to assert on.
 */
export function migrateViewStoragePrefix(
  storage: ViewStorageArea | undefined,
  descriptors: readonly SettingDescriptor[] = settingsInScope('view')
): string[] {
  if (!storage) return []

  const migrated: string[] = []
  for (const descriptor of descriptors) {
    const legacyKey = LEGACY_VIEW_STORAGE_PREFIX + descriptor.key
    const raw = storage.read(legacyKey)
    if (raw === null) continue

    const currentKey = VIEW_STORAGE_PREFIX + descriptor.key
    if (storage.read(currentKey) === null) storage.write(currentKey, raw)
    storage.remove(legacyKey)
    migrated.push(descriptor.key)
  }
  return migrated
}
