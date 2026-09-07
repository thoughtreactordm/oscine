import { describe, expect, it } from 'vitest'
import { SIDEBAR_REFLOW_BELOW } from '../../../src/renderer/shell/shellLayout'
import {
  TRANSPORT_BAR_COMPACT_BELOW,
  TRANSPORT_COVER_FITS_ABOVE,
  TRANSPORT_STAGE_COMPACT_BELOW,
  transportCoverFits,
  transportIsCompact
} from '../../../src/renderer/panels/transport/transportLayout'

describe('transport layout breakpoints', () => {
  it('hides the cover thumbnail at the same width the frame drops the rail', () => {
    expect(TRANSPORT_COVER_FITS_ABOVE).toBe(SIDEBAR_REFLOW_BELOW)
    expect(transportCoverFits(0)).toBe(true)
    expect(transportCoverFits(SIDEBAR_REFLOW_BELOW - 1)).toBe(false)
    expect(transportCoverFits(SIDEBAR_REFLOW_BELOW)).toBe(true)
  })

  it('folds the flanks before an expanded volume slider can reach the verbs', () => {
    expect(TRANSPORT_BAR_COMPACT_BELOW).toBeGreaterThan(TRANSPORT_COVER_FITS_ABOVE)
    expect(TRANSPORT_STAGE_COMPACT_BELOW).toBeGreaterThan(TRANSPORT_BAR_COMPACT_BELOW)
    expect(transportIsCompact(0, TRANSPORT_BAR_COMPACT_BELOW)).toBe(false)
    expect(transportIsCompact(TRANSPORT_BAR_COMPACT_BELOW - 1, TRANSPORT_BAR_COMPACT_BELOW)).toBe(
      true
    )
    expect(transportIsCompact(TRANSPORT_BAR_COMPACT_BELOW, TRANSPORT_BAR_COMPACT_BELOW)).toBe(false)
  })
})
