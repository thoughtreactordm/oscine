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

  /**
   * Show only the keys that differ from their default.
   *
   * Held here rather than derived, and *only* as a flag: which keys those are is
   * a question about values, and this store's whole discipline is that it holds
   * where you are looking and never what a setting is. `buildSettingsCatalog`
   * takes the flag and the set separately for that reason.
   */
  const changedOnly = ref(false)

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
    // A category, a query and the changed filter are three answers to "what am I
    // looking at", and both of the others win over a section while they are set —
    // so choosing one has to retire them, or the click would appear to do
    // nothing.
    query.value = ''
    changedOnly.value = false
  }

  function toggleChangedOnly(): void {
    changedOnly.value = !changedOnly.value
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
   *
   * The changed filter follows the same rule and cannot check it for itself, so
   * the caller says. A jump from inside the filtered list passes `changed: true`
   * and keeps the filter; a deep link from elsewhere says nothing and clears it,
   * because a link that landed on a row the filter had hidden would be a link
   * that did nothing.
   */
  function reveal(key: string, options: { changed?: boolean } = {}): void {
    const descriptor = getSetting(key)
    if (!descriptor || descriptor.internal || descriptor.control === null) return

    if (!matchesSettingQuery(descriptor, query.value.trim())) query.value = ''
    if (options.changed !== true) changedOnly.value = false
    if (query.value.trim().length === 0 && !changedOnly.value) category.value = descriptor.category
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
    changedOnly,
    scrollTo,
    highlighted,
    setQuery,
    selectCategory,
    isAdvancedOpen,
    toggleAdvanced,
    toggleChangedOnly,
    reveal,
    scrolled
  }
})
