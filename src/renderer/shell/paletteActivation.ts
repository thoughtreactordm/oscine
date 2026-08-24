import type { SearchEntityKind } from '@shared/search'

/**
 * What selecting a palette hit does — the shell's tab-level activation.
 *
 * This card wires navigation to the tab an entity lives on and no further: a
 * hit takes the operator to where the thing can be found. Deep targets — landing
 * on a specific playlist or artist — are W13-7's, layered on top of this through
 * the router. Pure and DOM-free so the "select navigates and closes" behaviour
 * is tested without a mounted palette.
 */

/**
 * The tab an entity kind lives on. `view` hits carry their own tab id and pass
 * it directly, so the branch here is only the fallback.
 */
export function homeTabForKind(kind: SearchEntityKind): string {
  switch (kind) {
    case 'playlist':
      return 'curate'
    case 'show':
      return 'podcasts'
    case 'view':
    case 'album':
    case 'artist':
    case 'track':
      return 'library'
  }
}

export interface PaletteSelection {
  /** The route name to switch to. */
  readonly tab: string
}

export interface SelectionDeps {
  navigate: (tab: string) => void
  close: () => void
}

/**
 * Runs a selection: navigate, then close. The order matters only in that the
 * palette should be gone by the time the destination paints.
 */
export function performSelection(selection: PaletteSelection, deps: SelectionDeps): void {
  deps.navigate(selection.tab)
  deps.close()
}
