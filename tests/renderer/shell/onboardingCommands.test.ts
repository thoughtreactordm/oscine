import { describe, expect, it, vi } from 'vitest'
import {
  buildOnboardingCommands,
  type OnboardingCommandDeps
} from '../../../src/renderer/shell/onboardingCommands'
import { matchCommands } from '../../../src/renderer/shell/commandRegistry'

/**
 * D-ONB-6's palette action. The contract: `onboarding.rerun` opens the wizard
 * at step 1 via the same `openWizard` the Settings button uses, dismisses the
 * palette first, and never touches the done-key — that is `openWizard`'s job,
 * and this module does not even receive it.
 */

function deps(overrides: Partial<OnboardingCommandDeps> = {}): OnboardingCommandDeps {
  return {
    openWizard: vi.fn(),
    close: vi.fn(),
    ...overrides
  }
}

function command(commands: ReturnType<typeof buildOnboardingCommands>, id: string) {
  const found = commands.find((c) => c.id === id)
  if (!found) throw new Error(`no command ${id}`)
  return found
}

describe('buildOnboardingCommands', () => {
  it("offers onboarding.rerun with the card's label and a keyword set", () => {
    const commands = buildOnboardingCommands(deps())
    expect(commands).toHaveLength(1)
    expect(commands[0]?.id).toBe('onboarding.rerun')
    expect(commands[0]?.label).toBe('Run first-run setup again')
    expect(commands[0]?.keywords.length).toBeGreaterThan(0)
  })

  it('closes the palette, then opens the wizard', () => {
    const order: string[] = []
    const d = deps({
      close: vi.fn(() => order.push('close')),
      openWizard: vi.fn(() => order.push('openWizard'))
    })

    command(buildOnboardingCommands(d), 'onboarding.rerun').run()

    expect(d.close).toHaveBeenCalledOnce()
    expect(d.openWizard).toHaveBeenCalledOnce()
    expect(order).toEqual(['close', 'openWizard'])
  })
})

describe('matchCommands over the onboarding group', () => {
  const commands = buildOnboardingCommands(deps())

  it('returns the command for empty text', () => {
    expect(matchCommands(commands, '').map((c) => c.id)).toEqual(['onboarding.rerun'])
  })

  it('matches a keyword the label does not contain', () => {
    expect(matchCommands(commands, 'onboarding').map((c) => c.id)).toEqual(['onboarding.rerun'])
    expect(matchCommands(commands, 'welcome').map((c) => c.id)).toEqual(['onboarding.rerun'])
  })

  it('matches on the label too', () => {
    expect(matchCommands(commands, 'first-run').map((c) => c.id)).toEqual(['onboarding.rerun'])
    expect(matchCommands(commands, 'setup').map((c) => c.id)).toEqual(['onboarding.rerun'])
  })
})
