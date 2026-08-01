/**
 * What the settings surface draws, derived from descriptors and nothing else.
 *
 * The components below this file place things; this file decides what there is
 * to place. That split is the whole point of the card: adding a setting must be
 * adding a descriptor, so the only code that can make a new key fail to appear
 * is this function — which is why it is the piece with a test, and why that test
 * can hand it a descriptor the registry has never held and watch it arrive in
 * the right section with the right control. A component test would prove less
 * and would need a DOM to do it.
 *
 * Everything here is pure and imports only `@shared`, so it runs under the plain
 * Node test environment the way `listViewport` and `trackWindow` do.
 */

import {
  SETTING_CATEGORIES,
  SETTINGS_REGISTRY,
  type SettingCategoryId,
  type SettingDescriptor
} from '@shared/settings'

/**
 * Prefix on every row's DOM id.
 *
 * This is the addressing W8-8 links into, so it is a published shape rather than
 * an implementation detail: a panel that wants to point at a setting builds the
 * id from the key with `settingAnchorId` and never guesses at it.
 */
export const SETTING_ANCHOR_PREFIX = 'setting-'

/**
 * Height of one row in the virtualized body, in pixels.
 *
 * Rows are a fixed height on purpose. The every-list-is-virtualized rule applies
 * to a settings category as much as to a track list — a domain like Interface
 * will pass a screenful long before the surface is finished — and uniform rows
 * are what let `visibleRange` do the arithmetic without measuring anything. The
 * cost is that help text is one clamped line; the row's `title` carries the rest.
 */
export const SETTING_ROW_PX = 64

/**
 * The row's id, from its key.
 *
 * Injective over dotted lowercase keys, which is every key the registry accepts:
 * only a pair differing solely in punctuation could collide, and `auditRegistry`
 * would have to admit both for that to happen.
 */
export function settingAnchorId(key: string): string {
  return `${SETTING_ANCHOR_PREFIX}${key.replace(/[^A-Za-z0-9]+/g, '-')}`
}

export interface SettingsRow {
  readonly key: string
  readonly descriptor: SettingDescriptor
  readonly category: SettingCategoryId
  /** The category's display name, so a search result can say where it lives. */
  readonly categoryLabel: string
  readonly anchorId: string
  readonly advanced: boolean
  readonly requiresRestart: boolean
}

export interface SettingsSection {
  readonly id: SettingCategoryId
  readonly label: string
  readonly icon: string
  /** Rows the section holds, ignoring the query. */
  readonly total: number
  /** How many of `total` are advanced — what the disclosure is worth offering for. */
  readonly advancedTotal: number
  /**
   * Rows surviving whatever is narrowing the catalog — the query, the
   * changed-from-default filter, or both. Equal to `total` when neither is on.
   */
  readonly matches: number
  /** How many of `total` differ from their default, whatever is narrowing. */
  readonly changed: number
}

export interface SettingsCatalogOptions {
  /** Free text, matched across key, label, help and keywords. */
  query?: string
  /** Which section the body shows. Ignored while a query is active. */
  category?: SettingCategoryId | null
  /**
   * Which sections have their advanced disclosure open, by category id.
   *
   * A map rather than a flag for the section being shown, because which section
   * that *is* is decided in here — a caller that had not chosen one yet would
   * have to ask, get an answer, and then ask again with the right disclosure
   * state, and the intermediate answer would be the one it painted.
   */
  advanced?: Readonly<Record<string, boolean>>
  /**
   * Keys whose value differs from their descriptor default — the store's
   * `changedKeys`.
   *
   * Passed in rather than read, because this module is pure and the values live
   * in a reactive store two layers away. Handing it a set keeps the same
   * property the `descriptors` parameter has: a test can state the delta it
   * wants without building a store to hold one.
   */
  changed?: ReadonlySet<string>
  /** Show only the rows in `changed`, across every category at once. */
  changedOnly?: boolean
}

export interface SettingsCatalog {
  /** Every category holding at least one row, in category order. */
  readonly sections: readonly SettingsSection[]
  /** The rows the body draws, in order. */
  readonly rows: readonly SettingsRow[]
  /** The section actually being shown, or null while something spans all of them. */
  readonly category: SettingCategoryId | null
  /** Rows withheld only because the advanced disclosure is shut. */
  readonly withheldAdvanced: number
  /** Whether a query is narrowing `rows`. */
  readonly filtered: boolean
  /** Whether the changed-from-default filter is narrowing `rows`. */
  readonly changedOnly: boolean
  /**
   * `rows` is drawn from every category rather than from one.
   *
   * True for a query and for the changed filter alike, because both answer "show
   * me this wherever it lives" — and a caller that had to spell out which of the
   * two was on every time it wanted to know whether to print a category name
   * would get it wrong the first time a third one landed.
   */
  readonly spanning: boolean
  /** How many rows differ from their default, in the whole catalog. */
  readonly changedTotal: number
}

/**
 * Does this descriptor answer to this query?
 *
 * Across key, label, help and keywords — a search that only reads labels finds
 * "Group tracks by album" and misses the operator who typed "gapless" at a help
 * string that explains it, which is most of what a search on a large surface is
 * for. Whitespace splits into terms that must all match somewhere, so "cross ms"
 * finds crossfade; each term is a plain substring, so a partial word still hits.
 */
export function matchesSettingQuery(descriptor: SettingDescriptor, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const haystack = [descriptor.key, descriptor.label, descriptor.help, ...descriptor.keywords]
    .join('\n')
    .toLowerCase()

  return terms.every((term) => haystack.includes(term))
}

/** Category order, then the descriptor's own order, then label — stable and total. */
function compareDescriptors(a: SettingDescriptor, b: SettingDescriptor): number {
  const byCategory = categoryOrder(a.category) - categoryOrder(b.category)
  if (byCategory !== 0) return byCategory
  if (a.order !== b.order) return a.order - b.order
  const byLabel = a.label.localeCompare(b.label)
  return byLabel !== 0 ? byLabel : a.key.localeCompare(b.key)
}

function categoryOrder(id: SettingCategoryId): number {
  return SETTING_CATEGORIES.find((category) => category.id === id)?.order ?? Number.MAX_SAFE_INTEGER
}

function toRow(descriptor: SettingDescriptor): SettingsRow {
  return {
    key: descriptor.key,
    descriptor,
    category: descriptor.category,
    categoryLabel:
      SETTING_CATEGORIES.find((category) => category.id === descriptor.category)?.label ??
      descriptor.category,
    anchorId: settingAnchorId(descriptor.key),
    advanced: descriptor.advanced,
    requiresRestart: descriptor.requiresRestart
  }
}

/**
 * The whole model for one paint of the settings view.
 *
 * `descriptors` is a parameter rather than a closed-over import for the same
 * reason the stores take one: the registry is the production argument, and a
 * test that wants to prove a *new* descriptor renders has to be able to pass one
 * that does not ship.
 */
export function buildSettingsCatalog(
  descriptors: readonly SettingDescriptor[] = SETTINGS_REGISTRY,
  options: SettingsCatalogOptions = {}
): SettingsCatalog {
  const query = (options.query ?? '').trim()
  const filtered = query.length > 0
  const changedKeys = options.changed ?? EMPTY
  const changedOnly = options.changedOnly === true
  const spanning = filtered || changedOnly

  const narrows = (descriptor: SettingDescriptor): boolean =>
    matchesSettingQuery(descriptor, query) && (!changedOnly || changedKeys.has(descriptor.key))

  // `internal` keys are the ones with no control — pane sizes, open tabs, column
  // layouts. They are settings in every other sense and are deliberately not on
  // this surface: the operator sets them by dragging the thing they describe.
  const shown = descriptors
    .filter((descriptor) => !descriptor.internal && descriptor.control !== null)
    .slice()
    .sort(compareDescriptors)

  const sections = SETTING_CATEGORIES.map((category): SettingsSection => {
    const inCategory = shown.filter((descriptor) => descriptor.category === category.id)
    return {
      id: category.id,
      label: category.label,
      icon: category.icon,
      total: inCategory.length,
      advancedTotal: inCategory.filter((descriptor) => descriptor.advanced).length,
      matches: inCategory.filter(narrows).length,
      changed: inCategory.filter((descriptor) => changedKeys.has(descriptor.key)).length
    }
  })
    .filter((section) => section.total > 0)
    .sort((a, b) => categoryOrder(a.id) - categoryOrder(b.id))

  // A query spans every category: the operator who typed "crossfade" is asking
  // where it is, and answering only from the section they happen to be standing
  // in would be a search that requires you to already know the answer. The
  // changed filter is the same question asked without a name to type — the whole
  // delta on one screen is the point, and one section of it is not.
  const category = spanning ? null : resolveCategory(options.category, sections)

  const scoped = shown.filter(
    (descriptor) =>
      (spanning || category === null || descriptor.category === category) && narrows(descriptor)
  )

  // A query discloses advanced rows wherever they are, and so does the changed
  // filter — hiding a knob the operator has actually turned is exactly the
  // failure mode that filter exists to prevent, and hiding one they have just
  // gone looking for by name is the same failure with a different cause.
  const disclosed = spanning || (category !== null && options.advanced?.[category] === true)
  const rows = scoped.filter((descriptor) => disclosed || !descriptor.advanced)

  return {
    sections,
    rows: rows.map(toRow),
    category,
    withheldAdvanced: scoped.length - rows.length,
    filtered,
    changedOnly,
    spanning,
    changedTotal: shown.filter((descriptor) => changedKeys.has(descriptor.key)).length
  }
}

const EMPTY: ReadonlySet<string> = new Set()

/**
 * The section to show when nothing has been chosen, or when what was chosen is
 * empty — a category can lose its last key to a rename, and a rail pointing at a
 * section that no longer exists would render a blank body with no way back.
 */
function resolveCategory(
  requested: SettingCategoryId | null | undefined,
  sections: readonly SettingsSection[]
): SettingCategoryId | null {
  if (requested && sections.some((section) => section.id === requested)) return requested
  return sections[0]?.id ?? null
}
