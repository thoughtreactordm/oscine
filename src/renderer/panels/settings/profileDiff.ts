/**
 * The import preview's presentation layer: how a status reads, how a value
 * reads, and what order the rows come in.
 *
 * Separated from the dialog because it is the part worth testing. The plan
 * itself is `@shared/settings`' business and is tested there; what this owns is
 * the claim that an operator looking at the preview can tell what will happen
 * from what will not — and that is a claim about ordering and wording, both of
 * which are assertable without mounting anything.
 */

import {
  summarizeSettingsImport,
  type SettingsImportEntry,
  type SettingsImportPlan,
  type SettingsImportStatus
} from '@shared/settings'

export interface ImportStatusMeta {
  label: string
  /** A Nuxt UI colour, so the badge never names a raw one. */
  tone: 'primary' | 'neutral' | 'warning' | 'error'
  icon: string
  /**
   * Sort order in the preview.
   *
   * What the import does comes before what it declines to do. An operator
   * scanning the list is deciding whether to press the button, and burying the
   * three changed keys under twenty excluded ones is how that decision gets made
   * on the strength of the first screenful.
   */
  rank: number
}

export const IMPORT_STATUS_META: Record<SettingsImportStatus, ImportStatusMeta> = {
  changed: { label: 'Changes', tone: 'primary', icon: 'i-tabler-arrow-right', rank: 0 },
  new: { label: 'New', tone: 'primary', icon: 'i-tabler-plus', rank: 1 },
  cleared: { label: 'Back to default', tone: 'warning', icon: 'i-tabler-rotate-2', rank: 2 },
  unchanged: { label: 'Already matches', tone: 'neutral', icon: 'i-tabler-equal', rank: 3 },
  excluded: { label: 'Left behind', tone: 'neutral', icon: 'i-tabler-device-desktop', rank: 4 },
  incompatible: { label: 'Newer build', tone: 'warning', icon: 'i-tabler-versions', rank: 5 },
  invalid: { label: 'Refused', tone: 'error', icon: 'i-tabler-alert-triangle', rank: 6 },
  unknown: { label: 'Unrecognised', tone: 'neutral', icon: 'i-tabler-help-circle', rank: 7 }
}

/**
 * A setting value, as one line of a diff.
 *
 * Deliberately not the control's own rendering: this has to say something
 * useful about every key at once, including the ones whose control is a custom
 * component and the ones this build has never heard of. Long values are cut
 * because the row is one line — the file is human-readable and is the place to
 * read a token map in full.
 */
export function formatSettingValue(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'none'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value === 'string') return value.trim() === '' ? 'empty' : value
  if (typeof value === 'number') return String(value)

  const json = JSON.stringify(value)
  if (json === undefined) return '—'
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  const count = Object.keys(value as object).length
  return json.length <= 48 ? json : `${count} ${count === 1 ? 'entry' : 'entries'}`
}

/** The entries in the order the preview draws them. */
export function importPreviewEntries(plan: SettingsImportPlan): readonly SettingsImportEntry[] {
  return [...plan.entries].sort((a, b) => {
    const rank = IMPORT_STATUS_META[a.status].rank - IMPORT_STATUS_META[b.status].rank
    return rank !== 0 ? rank : a.key.localeCompare(b.key)
  })
}

/**
 * The header line: what pressing the button costs, in one sentence fragment.
 *
 * Counted from the plan rather than tracked alongside it, so a status that stops
 * being produced stops being counted.
 */
export function importSummaryLine(plan: SettingsImportPlan): string {
  const counts = summarizeSettingsImport(plan)
  const parts: string[] = []

  if (counts.changed > 0) parts.push(`${counts.changed} changed`)
  if (counts.new > 0) parts.push(`${counts.new} new`)
  if (counts.cleared > 0) parts.push(`${counts.cleared} back to default`)
  if (counts.unchanged > 0) parts.push(`${counts.unchanged} already matching`)

  const skipped = counts.excluded + counts.incompatible + counts.invalid
  if (skipped > 0) parts.push(`${skipped} not applied`)
  if (counts.unknown > 0) parts.push(`${counts.unknown} kept for another build`)

  return parts.length > 0 ? parts.join(' · ') : 'This file changes nothing here.'
}

/** Does this import do anything at all? The confirm button reads it. */
export function importAppliesSomething(plan: SettingsImportPlan): boolean {
  return plan.apply.length > 0 || plan.preserve.length > 0 || plan.clear.length > 0
}
