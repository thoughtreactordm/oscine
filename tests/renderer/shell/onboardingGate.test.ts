import { describe, expect, it, vi } from 'vitest'
import { ONBOARDING_COMPLETED_KEY } from '../../../src/shared/settings'
import { maybeOpenOnboardingWizard } from '../../../src/renderer/shell/onboardingGate'

/**
 * The renderer launch gate. Main has already decided the key; this only reads
 * it, and only after hydration.
 */

describe('maybeOpenOnboardingWizard', () => {
  it('opens the wizard after hydration when the key is false', async () => {
    const openWizard = vi.fn()

    await maybeOpenOnboardingWizard({
      ready: Promise.resolve(),
      get: (key) => {
        expect(key).toBe(ONBOARDING_COMPLETED_KEY)
        return false as never
      },
      openWizard
    })

    expect(openWizard).toHaveBeenCalledOnce()
  })

  it('does not open the wizard when the key is true', async () => {
    const openWizard = vi.fn()

    await maybeOpenOnboardingWizard({
      ready: Promise.resolve(),
      get: () => true as never,
      openWizard
    })

    expect(openWizard).not.toHaveBeenCalled()
  })

  it('waits for hydration before reading, so a default false cannot race the load', async () => {
    let hydrated = false
    const openWizard = vi.fn()
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })

    const pending = maybeOpenOnboardingWizard({
      ready,
      get: () => {
        expect(hydrated).toBe(true)
        return false as never
      },
      openWizard
    })

    expect(openWizard).not.toHaveBeenCalled()
    hydrated = true
    resolveReady()
    await pending
    expect(openWizard).toHaveBeenCalledOnce()
  })
})
