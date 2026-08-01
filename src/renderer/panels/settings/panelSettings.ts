/**
 * Which settings a panel keeps under its own gear, and where a setting turns up
 * besides the settings view.
 *
 * A setting is easiest to reason about next to the thing it affects, so the
 * common ones are reachable from the panel they act on: grouping over a song
 * list, crossfade on the transport, watcher behaviour over the library roots.
 * What this module refuses to allow is a *second* settings UI. The popover is a
 * filtered projection of the same descriptors the full view renders — it does
 * not get to name a key the full view has never heard of, phrase a label its own
 * way, or offer a control the full view does not. That is the failure mode of
 * every hand-written settings dialog and the registry exists to prevent it.
 *
 * The mechanism is that a panel declares *keys*, not widgets, and the rows come
 * back from `settingsRowFor` — the same constructor `buildSettingsCatalog` uses,
 * handing back the same descriptor by reference. Two renderings of one
 * definition, structurally rather than by agreement.
 *
 * The declarations live here rather than in the panels for the reverse link's
 * sake: a row in the full view can say where else it appears only if there is
 * one list to ask, and a list assembled from four templates is a list that goes
 * stale the first time a gear moves.
 *
 * Pure, and importing only `@shared` and its sibling `catalog`, so it runs under
 * the plain Node test environment the way `catalog` and `trackWindow` do.
 */

import { SETTINGS_REGISTRY, type SettingDescriptor, type SettingEntityKind } from '@shared/settings'
import { isSurfacedSetting, settingsRowFor, type SettingsRow } from './catalog'

/** One panel's gear: what it holds and what to call the place it sits. */
export interface PanelSettingsSurface {
  /** Stable id, for a test to name one and for a key to be traced back to it. */
  readonly id: string
  /** The popover's heading. */
  readonly title: string
  /**
   * Where this is, phrased to follow "Also on" — the reverse link a row in the
   * full settings view draws so the operator learns the gear exists.
   */
  readonly where: string
  readonly icon: string
  /**
   * The keys, in the order the panel wants them drawn.
   *
   * Order is the panel's rather than the registry's, because a popover holding
   * three knobs is a sentence about this panel and the registry's ordering is a
   * sentence about the category. `buildSettingsCatalog` still owns the ordering
   * everywhere it matters, which is the full view.
   */
  readonly keys: readonly string[]
  /**
   * The entity these keys are edited at, when the panel is showing one thing
   * rather than everything — the playlist header edits *this playlist's*
   * crossfade, not the global one.
   *
   * A surface with an entity may only declare keys that cascade to that kind;
   * anything else comes back in `unscoped` rather than being rendered as a
   * control that would throw on write.
   */
  readonly entity?: SettingEntityKind
}

/** The projection: the rows a panel's gear draws, and what it could not draw. */
export interface PanelSettings {
  readonly surface: PanelSettingsSurface
  readonly rows: readonly SettingsRow[]
  /** Declared keys no descriptor answers to, or whose descriptor has no control. */
  readonly unknown: readonly string[]
  /** Declared keys that do not cascade to this surface's entity kind. */
  readonly unscoped: readonly string[]
}

/**
 * The rows for one surface.
 *
 * `descriptors` is a parameter rather than a closed-over import for the reason
 * `buildSettingsCatalog`'s is: a test proving that a *new* descriptor reaches a
 * popover has to be able to pass one that does not ship.
 *
 * Advanced keys are drawn when a surface names them. The disclosure in the full
 * view is there because a category is a list the operator is scanning and the
 * rare keys are noise in it; a panel that has named three keys has already made
 * that judgement, and hiding one of them behind a chevron in a popover the size
 * of a business card would be ceremony with nothing behind it.
 */
export function buildPanelSettings(
  surface: PanelSettingsSurface,
  descriptors: readonly SettingDescriptor[] = SETTINGS_REGISTRY
): PanelSettings {
  const rows: SettingsRow[] = []
  const unknown: string[] = []
  const unscoped: string[] = []

  for (const key of surface.keys) {
    const descriptor = descriptors.find((candidate) => candidate.key === key)
    if (!descriptor || !isSurfacedSetting(descriptor)) {
      unknown.push(key)
      continue
    }
    if (surface.entity !== undefined && !descriptor.cascade.includes(surface.entity)) {
      unscoped.push(key)
      continue
    }
    rows.push(settingsRowFor(descriptor))
  }

  return { surface, rows, unknown, unscoped }
}

/**
 * Every panel that surfaces a key, for the row in the full view that names where
 * it also appears.
 *
 * Cheap because the declarations are already one list. A scoped surface counts:
 * the operator who finds crossfade in the settings view is worth telling that
 * a playlist can override it, and where they would do that.
 */
export function surfacesForKey(
  key: string,
  surfaces: readonly PanelSettingsSurface[] = PANEL_SETTINGS_SURFACES
): readonly PanelSettingsSurface[] {
  return surfaces.filter((surface) => surface.keys.includes(key))
}

/**
 * The gears that ship.
 *
 * Deliberately short lists. A popover is for the knobs turned often enough to be
 * worth having to hand — everything else is one click away through the row's
 * link into the full view, which is what keeps this from growing into the
 * settings dialog it exists instead of.
 */
export const PANEL_SETTINGS_SURFACES: readonly PanelSettingsSurface[] = [
  {
    id: 'track-grouping',
    title: 'Albums',
    where: 'the album grouping button over any song list',
    icon: 'i-tabler-library',
    keys: ['view.trackGroupingEnabled', 'view.trackGroupingArtSize']
  },
  {
    id: 'transport',
    title: 'Playback',
    where: 'the transport',
    icon: 'i-tabler-adjustments-horizontal',
    keys: ['audio.crossfadeMs', 'audio.replayGainMode', 'audio.replayGainPreampDb']
  },
  {
    id: 'library-roots',
    title: 'Watching folders',
    where: 'the library sources header',
    icon: 'i-tabler-folder-cog',
    keys: ['library.watcherEnabled', 'library.watcherDebounceMs', 'library.followSymlinks']
  },
  {
    // The one that exercises W8-5's inheriting/overridden affordance outside the
    // settings view: the same descriptor, the same control, resolved against a
    // playlist rather than against the global row.
    id: 'playlist-playback',
    title: 'This playlist',
    where: 'the playlist header, where a playlist can override it',
    icon: 'i-tabler-adjustments-horizontal',
    keys: ['audio.crossfadeMs'],
    entity: 'playlist'
  }
]

/** Look one up, for a panel that would rather name its gear than hold it. */
export function panelSettingsSurface(id: string): PanelSettingsSurface {
  const surface = PANEL_SETTINGS_SURFACES.find((candidate) => candidate.id === id)
  if (!surface) throw new RangeError(`No panel settings surface: ${id}`)
  return surface
}
