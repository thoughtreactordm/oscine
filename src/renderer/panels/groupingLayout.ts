import { computed, ref } from 'vue'
import { browserLayoutStorage, type LayoutStorage } from './columnLayout'

/**
 * Whether the track list draws album headers, and how large their sleeves are.
 *
 * Its own module for the same two reasons as `columnLayout`: it has to survive a
 * restart, so what comes back from storage is validated rather than trusted — a
 * hand-edited blob must degrade to the defaults, not to a header of some
 * arbitrary height — and the rules are worth testing without a DOM.
 *
 * Sizes are numbers rather than utility classes because they are arithmetic
 * before they are styling: the virtualizer is told the height of every row in
 * advance, and scrolling a track into view multiplies them out to a pixel
 * offset. A class name cannot be added up.
 */

export const ALBUM_ART_SIZES = {
  small: { label: 'Small', art: 40, row: 56 },
  medium: { label: 'Medium', art: 64, row: 80 },
  large: { label: 'Large', art: 96, row: 112 }
} as const

export type AlbumArtSize = keyof typeof ALBUM_ART_SIZES

export const ALBUM_ART_SIZE_KEYS = Object.keys(ALBUM_ART_SIZES) as readonly AlbumArtSize[]

export interface TrackGroupingPreference {
  /** Album headers are drawn at all. Off leaves a plain flat list. */
  enabled: boolean
  artSize: AlbumArtSize
}

export const GROUPING_STORAGE_KEY = 'fermata.trackGrouping.v1'

export function defaultGroupingPreference(): TrackGroupingPreference {
  return { enabled: true, artSize: 'small' }
}

function isArtSize(value: unknown): value is AlbumArtSize {
  return typeof value === 'string' && value in ALBUM_ART_SIZES
}

/**
 * Coerces anything at all into a usable preference.
 *
 * Field by field rather than all-or-nothing: a blob written by a future version
 * that adds a setting should still yield the two settings this version knows,
 * and one bad field should not discard a good one.
 */
export function normalizeGroupingPreference(value: unknown): TrackGroupingPreference {
  const fallback = defaultGroupingPreference()
  if (typeof value !== 'object' || value === null) return fallback

  const raw = value as Partial<Record<keyof TrackGroupingPreference, unknown>>
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    artSize: isArtSize(raw.artSize) ? raw.artSize : fallback.artSize
  }
}

export interface GroupingPreferenceDeps {
  storage?: LayoutStorage
}

export function createGroupingPreference(deps: GroupingPreferenceDeps = {}) {
  const storage = deps.storage
  const preference = ref<TrackGroupingPreference>(read())

  function read(): TrackGroupingPreference {
    const stored = storage?.read()
    if (stored === null || stored === undefined) return defaultGroupingPreference()
    try {
      return normalizeGroupingPreference(JSON.parse(stored))
    } catch {
      return defaultGroupingPreference()
    }
  }

  function persist(): void {
    storage?.write(JSON.stringify(preference.value))
  }

  const enabled = computed(() => preference.value.enabled)
  const artSize = computed(() => preference.value.artSize)
  /** Sleeve edge, in pixels. */
  const artPx = computed(() => ALBUM_ART_SIZES[preference.value.artSize].art)
  /** Header row height, which is the sleeve plus its padding. */
  const rowPx = computed(() => ALBUM_ART_SIZES[preference.value.artSize].row)

  function setEnabled(next: boolean): void {
    preference.value = { ...preference.value, enabled: next }
    persist()
  }

  function toggleEnabled(): void {
    setEnabled(!preference.value.enabled)
  }

  /**
   * Choosing a size turns grouping on.
   *
   * Picking "Large" while headers are hidden otherwise does nothing visible,
   * which reads as a broken control rather than as a setting that will apply
   * later.
   */
  function setArtSize(next: AlbumArtSize): void {
    if (!isArtSize(next)) return
    preference.value = { enabled: true, artSize: next }
    persist()
  }

  function reset(): void {
    preference.value = defaultGroupingPreference()
    persist()
  }

  return { enabled, artSize, artPx, rowPx, setEnabled, toggleEnabled, setArtSize, reset }
}

export { browserLayoutStorage }
