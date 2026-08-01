import { defineStore } from 'pinia'
import { ref } from 'vue'
import { matchesSettingQuery } from '@renderer/panels/settings/catalog'
import { getSetting, type SettingCategoryId } from '@shared/settings'

/** How long a revealed row stays marked, in milliseconds. */
export const SETTING_HIGHLIGHT_MS = 2_400

/**
 * Where the settings surface is looking.
 *
 * A store rather than component state because the two halves of the surface are
 * two routed components: the rail is mounted in the frame's sidebar slot and the
 * body in its main region, and they are siblings only in the sense that the
 * frame draws both. Passing a query between them would mean the frame knowing
 * what a settings query is.
 *
 * It holds *where you are looking*, never *what a setting is* — no values, no
 * descriptors, no defaults. `buildSettingsCatalog` turns this plus the registry
 * into rows, and it does that in both halves independently, which is what keeps
 * them islands: neither reads the other's derivation.
 */
export const useSettingsNavStore = defineStore('settingsNav', () => {
  const query = ref('')
  const category = ref<SettingCategoryId | null>(null)

  /**
   * Advanced disclosure, per section rather than global.
   *
   * Opening Advanced under Library to raise the artwork cache should not also
   * unfold the decode budgets under Audio; a disclosure that is really one
   * global switch is a checkbox wearing a chevron.
   */
  const advanced = ref<Record<string, boolean>>({})

  /** The row a reveal is asking the body to scroll to. Cleared once it has. */
  const scrollTo = ref<string | null>(null)
  /** The row drawn as just-arrived-at. Fades on a timer. */
  const highlighted = ref<string | null>(null)

  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  function setQuery(next: string): void {
    query.value = next
  }

  function selectCategory(next: SettingCategoryId): void {
    category.value = next
    // A category and a query are two answers to "what am I looking at" and the
    // query wins while it is set, so choosing a section has to retire it — or
    // the click would appear to do nothing.
    query.value = ''
  }

  function isAdvancedOpen(id: SettingCategoryId | null): boolean {
    return id !== null && advanced.value[id] === true
  }

  function toggleAdvanced(id: SettingCategoryId): void {
    advanced.value = { ...advanced.value, [id]: !advanced.value[id] }
  }

  /**
   * Put a key on screen: the entry point for a deep link, and for Enter in the
   * search box.
   *
   * The query survives when the target still matches it — jumping to the first
   * search result must not throw away the search that found it — and is dropped
   * when it does not, because a link from a panel's gear has no idea what the
   * operator last typed here and would otherwise land on a filtered-out row.
   */
  function reveal(key: string): void {
    const descriptor = getSetting(key)
    if (!descriptor || descriptor.internal || descriptor.control === null) return

    if (!matchesSettingQuery(descriptor, query.value.trim())) query.value = ''
    if (query.value.trim().length === 0) category.value = descriptor.category
    if (descriptor.advanced) {
      advanced.value = { ...advanced.value, [descriptor.category]: true }
    }

    scrollTo.value = key
    highlighted.value = key

    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      highlighted.value = null
      highlightTimer = null
    }, SETTING_HIGHLIGHT_MS)
  }

  /** The body says it has scrolled, so a later reveal of the same key still moves. */
  function scrolled(): void {
    scrollTo.value = null
  }

  return {
    query,
    category,
    advanced,
    scrollTo,
    highlighted,
    setQuery,
    selectCategory,
    isAdvancedOpen,
    toggleAdvanced,
    reveal,
    scrolled
  }
})
