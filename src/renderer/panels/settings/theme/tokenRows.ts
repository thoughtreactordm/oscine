/**
 * The token editor's row model: which rows the editor draws, in what order, and
 * which of them the operator has moved.
 *
 * Split out of the component because it is the half worth testing without a
 * DOM — the grouping, the search and the orphan handling are where the
 * unknown-key rule either holds or quietly stops holding, and a test that has to
 * mount a modal to check it is a test nobody writes twice.
 *
 * Group headings are rows in the same list as tokens rather than section
 * wrappers around them. `visibleRange` is uniform-row arithmetic — a row's
 * offset is its index times one number — and a heading of a different height
 * would turn that into a running sum over every row above it. So a heading is
 * the same height as a token row, and the whole surface stays one virtualized
 * list however many groups the catalog grows.
 */

import {
  PUBLIC_TOKENS,
  TOKEN_GROUPS,
  type ThemeOverrides,
  type TokenDescriptor
} from '@shared/theme'

/** One row's height, and the number the editor's list is virtualized on. */
export const TOKEN_ROW_PX = 60

export interface TokenGroupRow {
  readonly kind: 'group'
  readonly key: string
  readonly id: string
  readonly label: string
  readonly help: string
  /** Token rows drawn under it, after the query. */
  readonly total: number
  /** How many of those carry an override — what the group's revert would clear. */
  readonly overridden: number
}

export interface TokenValueRow {
  readonly kind: 'token'
  readonly key: string
  readonly descriptor: TokenDescriptor
  readonly overridden: boolean
}

/**
 * An override naming a token this build does not define.
 *
 * Shown rather than dropped, and shown as what it is: the operator switched
 * theme, or downgraded, and the value they authored is still here waiting for
 * the name to come back. The only thing offered is a revert, because there is no
 * descriptor to say what kind of value it holds or what it would do.
 */
export interface OrphanRow {
  readonly kind: 'orphan'
  readonly key: string
  readonly id: string
}

export type TokenEditorRow = TokenGroupRow | TokenValueRow | OrphanRow

export interface TokenRowsInput {
  readonly overrides: ThemeOverrides
  /** `resolveTheme().unknown` — overrides naming no token in this build. */
  readonly unknown: readonly string[]
  readonly query?: string
  /** Draw only what the operator has actually moved. */
  readonly overriddenOnly?: boolean
}

export interface TokenRows {
  readonly rows: readonly TokenEditorRow[]
  /** Token and orphan rows drawn; headings excluded. */
  readonly matched: number
  /** Public tokens carrying an override, whatever the query is hiding. */
  readonly overridden: number
  /** True when a query or the changed filter is narrowing the list. */
  readonly filtered: boolean
}

/** The heading the orphans sit under, kept out of `TOKEN_GROUPS` on purpose. */
const ORPHAN_GROUP = {
  id: 'unknown',
  label: 'Not in this theme',
  help: 'Overrides naming a token this build does not define. Kept, and inert until it comes back.'
} as const

export function isOverridden(id: string, overrides: ThemeOverrides): boolean {
  return Object.hasOwn(overrides, id)
}

/**
 * Search runs over everything a person might type, not just the label.
 *
 * `keywords` exists for exactly this — an operator hunting for "dark mode
 * background" does not know the token is called Window, and one who knows the
 * custom property is called `--oscine-surface-base` should be able to paste it.
 */
function matches(descriptor: TokenDescriptor, needle: string, groupLabel: string): boolean {
  if (needle.length === 0) return true
  if (descriptor.label.toLowerCase().includes(needle)) return true
  if (descriptor.id.toLowerCase().includes(needle)) return true
  if (descriptor.cssVar.toLowerCase().includes(needle)) return true
  if (descriptor.help.toLowerCase().includes(needle)) return true
  if (groupLabel.toLowerCase().includes(needle)) return true
  return descriptor.keywords.some((word) => word.toLowerCase().includes(needle))
}

export function buildTokenRows(input: TokenRowsInput): TokenRows {
  const needle = (input.query ?? '').trim().toLowerCase()
  const overriddenOnly = input.overriddenOnly ?? false
  const { overrides } = input

  const rows: TokenEditorRow[] = []
  let matched = 0

  for (const group of TOKEN_GROUPS) {
    const tokens = PUBLIC_TOKENS.filter(
      (token) =>
        token.group === group.id &&
        matches(token, needle, group.label) &&
        (!overriddenOnly || isOverridden(token.id, overrides))
    ).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))

    if (tokens.length === 0) continue

    rows.push({
      kind: 'group',
      key: `group:${group.id}`,
      id: group.id,
      label: group.label,
      help: group.help,
      total: tokens.length,
      overridden: tokens.filter((token) => isOverridden(token.id, overrides)).length
    })

    for (const descriptor of tokens) {
      rows.push({
        kind: 'token',
        key: descriptor.id,
        descriptor,
        overridden: isOverridden(descriptor.id, overrides)
      })
    }

    matched += tokens.length
  }

  /*
   * Orphans last, and never hidden by the changed filter — every one of them is
   * by definition something the operator changed, so filtering to "changed"
   * and losing them would be the one filter that drops what it promises to show.
   */
  const orphans = input.unknown
    .filter((id) => needle.length === 0 || id.toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => a.localeCompare(b))

  if (orphans.length > 0) {
    rows.push({
      kind: 'group',
      key: `group:${ORPHAN_GROUP.id}`,
      id: ORPHAN_GROUP.id,
      label: ORPHAN_GROUP.label,
      help: ORPHAN_GROUP.help,
      total: orphans.length,
      overridden: orphans.length
    })

    for (const id of orphans) {
      rows.push({ kind: 'orphan', key: `unknown:${id}`, id })
    }

    matched += orphans.length
  }

  return {
    rows,
    matched,
    overridden: PUBLIC_TOKENS.filter((token) => isOverridden(token.id, overrides)).length,
    filtered: needle.length > 0 || overriddenOnly
  }
}

/**
 * The token ids a group heading's revert would clear.
 *
 * The whole group, not the drawn rows — the same choice `SettingsPane` makes
 * for a category. A sweep that silently skipped what the query was hiding would
 * leave the operator convinced they had cleared Surfaces.
 *
 * Orphans come from the `unknown` list rather than from "every override with no
 * public descriptor", because those are not the same set: an override on an
 * internal token resolves perfectly well and is not an orphan.
 */
export function groupTokenIds(
  groupId: string,
  overrides: ThemeOverrides,
  unknown: readonly string[]
): string[] {
  if (groupId === ORPHAN_GROUP.id) {
    return unknown.filter((id) => isOverridden(id, overrides))
  }
  return PUBLIC_TOKENS.filter(
    (token) => token.group === groupId && isOverridden(token.id, overrides)
  ).map((token) => token.id)
}
