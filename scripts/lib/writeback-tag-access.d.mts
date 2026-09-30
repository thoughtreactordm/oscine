/** Types for `writeback-tag-access.mjs`, so the parity test can typecheck against it. */
import type { Tag } from 'node-taglib-sharp'

export function readTagProperty(tag: Tag, property: string): unknown
export function writeTagProperty(tag: Tag, property: string, value: unknown): void
