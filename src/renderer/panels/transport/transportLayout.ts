// Reached relatively: this module is unit-tested, and `tests/` compiles under
// tsconfig.node.json, which has no `@renderer` alias.
import { SIDEBAR_REFLOW_BELOW } from '../../shell/shellLayout'

/**
 * Widths at which the transport changes shape.
 *
 * Measured on the bar (or the stage transport) rather than the viewport, so
 * Tunedeck squeezing the row still folds the flanks (§1). Compact is the
 * *expanded-volume* layout: the slider wipes open to 6rem, and the older 860 / 900
 * floors were the resting (collapsed) row — which is how an open slider reached
 * the verbs before the popover took over. The stage number is higher because the
 * same right cluster is mirrored across two equal `flex-1` sides with more side
 * padding (`sm:px-8` against the bar's `px-3`).
 *
 * Cover thumbnail: the same figure the frame uses to drop the rail's cover pane
 * (`SIDEBAR_REFLOW_BELOW`). Below it the art eclipses the track line; hiding the
 * pane and leaving the thumbnail would just move the collision into the bar.
 * Measured on the bar so a Tunedeck squeeze that reflows the rail does not hide a
 * thumbnail the bar still has room for.
 */
export const TRANSPORT_BAR_COMPACT_BELOW = 1040
export const TRANSPORT_STAGE_COMPACT_BELOW = 1080
export const TRANSPORT_COVER_FITS_ABOVE = SIDEBAR_REFLOW_BELOW

export function transportIsCompact(width: number, below: number): boolean {
  return width > 0 && width < below
}

export function transportCoverFits(width: number): boolean {
  return width === 0 || width >= TRANSPORT_COVER_FITS_ABOVE
}
