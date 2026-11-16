import type { File as TagFile, Tag } from 'node-taglib-sharp'

/** Types for `writeback-tag-access.mjs`, the corpus gate's mirror of the writer's accessors. */

export interface TagAccessContext {
  readonly opus: boolean
}

export const PLAIN_TAG_CONTEXT: TagAccessContext
export function tagAccessContext(file: TagFile): TagAccessContext

export function gainDbToR128Q78(gainDb: number): number
export function parseR128Q78(text: string | undefined | null): number | null
export function r128Q78ToGainDb(value: number): number

export const OPUS_GAIN_SCOPES: Readonly<
  Record<string, { readonly r128: string; readonly legacy: readonly string[] }>
>

export function readTagProperty(tag: Tag, property: string, context?: TagAccessContext): unknown
export function writeTagProperty(
  tag: Tag,
  property: string,
  value: unknown,
  context?: TagAccessContext
): void
