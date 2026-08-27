import { describe, expect, it } from 'vitest'
import { COMMAND_PALETTE_AFFORDANCE_KEY, getSetting, TAB_NAV_BAR_KEY } from '@shared/settings'

/**
 * G5. The two Interface toggles ship visible: first run has the palette
 * affordance and the tab bar both ON. The frame and title bar read these keys
 * to opt out, so a default that regressed to `false` would hide chrome nobody
 * asked to lose. Locked here rather than left to the registry's own shape.
 */
describe('G5 interface toggles', () => {
  it('registers the Command Palette affordance as an interface toggle, ON by default', () => {
    const descriptor = getSetting(COMMAND_PALETTE_AFFORDANCE_KEY)
    expect(descriptor).not.toBeNull()
    expect(descriptor?.default).toBe(true)
    expect(descriptor?.scope).toBe('durable')
    expect(descriptor?.category).toBe('interface')
    expect(descriptor?.control?.kind).toBe('toggle')
  })

  it('registers the tab navigation bar as an interface toggle, ON by default', () => {
    const descriptor = getSetting(TAB_NAV_BAR_KEY)
    expect(descriptor).not.toBeNull()
    expect(descriptor?.default).toBe(true)
    expect(descriptor?.scope).toBe('durable')
    expect(descriptor?.category).toBe('interface')
    expect(descriptor?.control?.kind).toBe('toggle')
  })
})
