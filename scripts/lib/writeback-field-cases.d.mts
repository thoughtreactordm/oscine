/** Types for `writeback-field-cases.mjs`, so the registry-sync test can typecheck against it. */

export type FieldCaseKind = 'text' | 'int' | 'bool' | 'list' | 'real'

export interface FieldCase {
  readonly key: string
  readonly taglib: string
  readonly kind: FieldCaseKind
  readonly readOnly: boolean
  readonly value: string | number | boolean | readonly string[]
  /** Present on `list` cases only: the ordered two-entry write. */
  readonly multi?: readonly string[]
}

export const CLEAR_VALUE: Readonly<{
  text: undefined
  list: readonly string[]
  int: number
  bool: boolean
}>

export const FIELD_CASES: readonly FieldCase[]

export const REAL_TOLERANCE: number
