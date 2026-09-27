import type { OverrideFieldState } from '@shared/overrides'
import {
  TAG_FIELD_GROUP_LABELS,
  TAG_FIELD_GROUPS,
  TAG_FIELDS,
  TAG_TEXT_MAX_LENGTH,
  isEditableTagField,
  tagValuesEqual,
  type TagFieldDef,
  type TagFieldGroup,
  type TagFieldValue
} from '@shared/tagFields'

/**
 * The metadata editor's "All fields" area — **W16-18**, the pure half.
 *
 * Everything the generic editor decides that is not Vue: which sections and
 * fields to draw, how a folded cell becomes a form value, and how the form turns
 * back into a `tagOverrides.set` patch and a revert list. Every function takes
 * the registry as an argument (defaulting to {@link TAG_FIELDS}), so the
 * component iterates what this returns and a new registry entry needs no
 * component edit — the test proves it with a throwaway entry.
 */

/** One collapsible section of the editor: a registry group and its fields. */
export interface TagFieldSection {
  readonly group: TagFieldGroup
  readonly label: string
  readonly fields: readonly TagFieldDef[]
}

/**
 * The sections to draw, in group order: admitted fields only (Decision D), and
 * a group with none left is not drawn. Read-only fields stay — they display.
 */
export function tagFieldSections(registry: readonly TagFieldDef[] = TAG_FIELDS): TagFieldSection[] {
  const sections: TagFieldSection[] = []
  for (const group of TAG_FIELD_GROUPS) {
    const fields = registry.filter((field) => field.group === group && field.admitted)
    if (fields.length > 0) sections.push({ group, label: TAG_FIELD_GROUP_LABELS[group], fields })
  }
  return sections
}

/** Whether a text field is a free-text frame that wants a multi-line input. */
export function isMultiline(field: TagFieldDef): boolean {
  return field.kind === 'text' && field.maxLength > TAG_TEXT_MAX_LENGTH
}

/**
 * A field's value as the form holds it: text, int and real as the input's
 * string, a list as its entries, a flag as `true`/`false` — or `null` when the
 * batch disagrees, which the checkbox draws as indeterminate.
 */
export type TagFormValue = string | boolean | null | readonly string[]

/** The form's values by registry key. */
export type TagFormValues = Record<string, TagFormValue>

/** A read-only number's display: fractional, trimmed to four places. */
function formatReal(value: number): string {
  return String(Number(value.toFixed(4)))
}

/**
 * A folded cell as a form value. A `mixed` cell starts empty — the input shows
 * "Multiple values" instead — and an untouched empty cell stays out of the
 * patch, so opening a batch and saving it changes nothing.
 */
export function formValue(
  field: TagFieldDef,
  cell: OverrideFieldState<TagFieldValue> | undefined
): TagFormValue {
  const mixed = cell?.mixed ?? false
  const value = mixed ? null : (cell?.value ?? null)
  switch (field.kind) {
    case 'bool':
      return mixed ? null : value === true
    case 'list':
      return Array.isArray(value) ? [...(value as readonly string[])] : []
    case 'real':
      return typeof value === 'number' ? formatReal(value) : ''
    case 'int':
    case 'text':
      return value === null ? '' : String(value)
  }
}

/** The form's initial values for every field of every section. */
export function formValues(
  sections: readonly TagFieldSection[],
  state: Readonly<Record<string, OverrideFieldState<TagFieldValue> | undefined>>
): TagFormValues {
  const values: TagFormValues = {}
  for (const section of sections) {
    for (const field of section.fields) values[field.key] = formValue(field, state[field.key])
  }
  return values
}

/** What one field contributes to a save. */
export type TagFieldEdit =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'set'; readonly value: TagFieldValue | null }
  | { readonly kind: 'invalid'; readonly message: string }

function sameFormValue(a: TagFormValue, b: TagFormValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && tagValuesEqual(a, b)
  }
  return a === b
}

/**
 * One field's edit. Unchanged is left out; an emptied field is the clear
 * intent (`null`), which the generic tier has and the grouped numbers do not;
 * a number that does not parse is reported rather than silently dropped.
 */
export function tagFieldEdit(
  field: TagFieldDef,
  value: TagFormValue,
  initial: TagFormValue
): TagFieldEdit {
  if (!isEditableTagField(field) || sameFormValue(value, initial)) return { kind: 'unchanged' }
  switch (field.kind) {
    case 'bool':
      // `null` is "mixed, untouched" and cannot differ from its own initial.
      return typeof value === 'boolean' ? { kind: 'set', value } : { kind: 'unchanged' }
    case 'list': {
      const entries = Array.isArray(value) ? (value as readonly string[]) : []
      return { kind: 'set', value: entries.length === 0 ? null : [...entries] }
    }
    case 'int': {
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed === '') return { kind: 'set', value: null }
      const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN
      if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
        return {
          kind: 'invalid',
          message: `${field.label} must be a whole number from ${field.min} to ${field.max}.`
        }
      }
      return { kind: 'set', value: parsed }
    }
    case 'text': {
      const text = typeof value === 'string' ? value : ''
      if (text.length > field.maxLength) {
        return {
          kind: 'invalid',
          message: `${field.label} must not exceed ${field.maxLength} characters.`
        }
      }
      return { kind: 'set', value: text === '' ? null : text }
    }
    case 'real':
      return { kind: 'unchanged' }
  }
}

/** A save's generic half: the patch for `set`, the keys for `revert`, any errors. */
export interface TagFieldSave {
  readonly patch: Record<string, TagFieldValue | null>
  readonly revert: string[]
  readonly errors: string[]
}

/**
 * The generic half of a save. A field marked to revert goes to `revert` and
 * never into the patch; an untouched field goes nowhere, so a batch keeps every
 * track's own value for it.
 */
export function buildTagFieldSave(
  sections: readonly TagFieldSection[],
  values: Readonly<TagFormValues>,
  initial: Readonly<TagFormValues>,
  reverting: Readonly<Record<string, boolean>>
): TagFieldSave {
  const patch: Record<string, TagFieldValue | null> = {}
  const revert: string[] = []
  const errors: string[] = []
  for (const section of sections) {
    for (const field of section.fields) {
      if (!isEditableTagField(field)) continue
      if (reverting[field.key] === true) {
        revert.push(field.key)
        continue
      }
      const edit = tagFieldEdit(field, values[field.key] ?? null, initial[field.key] ?? null)
      if (edit.kind === 'set') patch[field.key] = edit.value
      else if (edit.kind === 'invalid') errors.push(edit.message)
    }
  }
  return { patch, revert, errors }
}

/** Whether any generic field has an edit or a revert standing. */
export function tagFormDirty(
  sections: readonly TagFieldSection[],
  values: Readonly<TagFormValues>,
  initial: Readonly<TagFormValues>,
  reverting: Readonly<Record<string, boolean>>
): boolean {
  return sections.some((section) =>
    section.fields.some(
      (field) =>
        isEditableTagField(field) &&
        (reverting[field.key] === true ||
          !sameFormValue(values[field.key] ?? null, initial[field.key] ?? null))
    )
  )
}

/**
 * A generic value's display, for the review's cells: a list reads as its
 * entries joined, a flag as yes/no, a fractional number trimmed. An em dash is
 * the empty value.
 */
export function formatTagValue(field: TagFieldDef, value: TagFieldValue | null): string {
  if (value === null) return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join('; ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number' && field.kind === 'real') return formatReal(value)
  return String(value)
}

/** One read-only row of the Track Info dialog's generic sections. */
export interface TagInfoRow {
  readonly key: string
  readonly label: string
  readonly value: string
  /** A free-text frame (lyrics, description) that wants its own block, not a cell. */
  readonly multiline: boolean
}

/** One Track Info section: a registry group and the rows that carry something. */
export interface TagInfoSection {
  readonly group: TagFieldGroup
  readonly label: string
  readonly rows: readonly TagInfoRow[]
}

/** Whether a folded cell has anything to show: not mixed, not empty, not a lowered flag. */
function hasInfoValue(value: TagFieldValue | null | undefined): value is TagFieldValue {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim() !== ''
  // An absent flag and a lowered one read the same off the file, so only a raised one is a fact.
  if (typeof value === 'boolean') return value
  return true
}

/**
 * The Track Info dialog's view of the generic surface: the editor's sections,
 * in the editor's order, keeping only the fields that hold a value — a fact we
 * do not have is not a row. The read-only group is left out because the
 * dialog's own ReplayGain section already reads those values from the index.
 */
export function buildTagInfoSections(
  state: Readonly<Record<string, OverrideFieldState<TagFieldValue> | undefined>>,
  registry: readonly TagFieldDef[] = TAG_FIELDS
): TagInfoSection[] {
  const sections: TagInfoSection[] = []
  for (const section of tagFieldSections(registry)) {
    if (section.group === 'readOnly') continue
    const rows: TagInfoRow[] = []
    for (const field of section.fields) {
      const cell = state[field.key]
      if (cell === undefined || cell.mixed || !hasInfoValue(cell.value)) continue
      rows.push({
        key: field.key,
        label: field.label,
        value: formatTagValue(field, cell.value),
        multiline: isMultiline(field)
      })
    }
    if (rows.length > 0) sections.push({ group: section.group, label: section.label, rows })
  }
  return sections
}
