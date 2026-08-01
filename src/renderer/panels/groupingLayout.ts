import { computed } from 'vue'
import type { AlbumArtSize } from '@shared/settings'
import type { ViewSettings } from '../settings/viewStore'

/**
 * Whether the track list draws album headers, and how large their sleeves are.
 *
 * Its own module for the same reason as `columnLayout`: the sizes are worth
 * testing without a DOM, and the geometry below is the only part of this that
 * is a renderer concern at all.
 *
 * Sizes are numbers rather than utility classes because they are arithmetic
 * before they are styling: the virtualizer is told the height of every row in
 * advance, and scrolling a track into view multiplies them out to a pixel
 * offset. A class name cannot be added up.
 *
 * What used to be here — a `browserLayoutStorage` call, a JSON `try`/`catch`,
 * and a `normalizeGroupingPreference` that repaired two fields independently —
 * is gone. The two fields are two keys now, so one being rejected cannot take
 * the other with it, which is what "field by field" was for.
 */

export const GROUPING_ENABLED_KEY = 'view.trackGroupingEnabled'
export const GROUPING_ART_SIZE_KEY = 'view.trackGroupingArtSize'

/**
 * Sleeve and row heights per size.
 *
 * Keyed by the shared `AlbumArtSize`, not by its own union: the settings
 * descriptor decides which sizes exist, and typing the table by that union is
 * what makes adding one there a compile error here rather than a lookup that
 * returns undefined at runtime.
 */
export const ALBUM_ART_SIZES: Readonly<
  Record<AlbumArtSize, { label: string; art: number; row: number }>
> = {
  small: { label: 'Small', art: 40, row: 56 },
  medium: { label: 'Medium', art: 64, row: 80 },
  large: { label: 'Large', art: 96, row: 112 }
}

export type { AlbumArtSize }

export const ALBUM_ART_SIZE_KEYS = Object.keys(ALBUM_ART_SIZES) as readonly AlbumArtSize[]

export interface GroupingPreferenceDeps {
  settings: ViewSettings
}

export function createGroupingPreference(deps: GroupingPreferenceDeps) {
  const settings = deps.settings
  const enabled = settings.value<boolean>(GROUPING_ENABLED_KEY)
  const artSize = settings.value<AlbumArtSize>(GROUPING_ART_SIZE_KEY)

  /** Sleeve edge, in pixels. */
  const artPx = computed(() => ALBUM_ART_SIZES[artSize.value].art)
  /** Header row height, which is the sleeve plus its padding. */
  const rowPx = computed(() => ALBUM_ART_SIZES[artSize.value].row)

  function setEnabled(next: boolean): void {
    enabled.value = next
  }

  function toggleEnabled(): void {
    setEnabled(!enabled.value)
  }

  /**
   * Choosing a size turns grouping on.
   *
   * Picking "Large" while headers are hidden otherwise does nothing visible,
   * which reads as a broken control rather than as a setting that will apply
   * later.
   */
  function setArtSize(next: AlbumArtSize): void {
    if (!(next in ALBUM_ART_SIZES)) return
    artSize.value = next
    enabled.value = true
  }

  function reset(): void {
    settings.reset(GROUPING_ENABLED_KEY)
    settings.reset(GROUPING_ART_SIZE_KEY)
  }

  return { enabled, artSize, artPx, rowPx, setEnabled, toggleEnabled, setArtSize, reset }
}
