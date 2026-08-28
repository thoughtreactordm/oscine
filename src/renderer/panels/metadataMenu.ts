import type { ContextMenuItem } from '@nuxt/ui'

/**
 * The one "Edit metadata…" context-menu entry — **W16 (editor)**.
 *
 * Authored here so a track, a multiselection, an album and an artist all offer
 * it identically, the pair to "Write tags to files…": edit the correction, then
 * flush it.
 */
export function editMetadataMenuItem(onSelect: () => void): ContextMenuItem {
  return { label: 'Edit metadata…', icon: 'i-tabler-edit', onSelect }
}
