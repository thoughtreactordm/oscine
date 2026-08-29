import type { Command } from './commandRegistry'

/**
 * D-ONB-6's palette entry: re-run first-run setup.
 *
 * Its own builder rather than a row on `actionCommands` because it is not a
 * transport verb, and rather than a generated settings command because the
 * done-key is `internal` and must stay out of `/` mode. The Actions group is
 * still the home: the card calls this a palette *action*, `>` is the prefix
 * for verbs, and "Run first-run setup again" is a verb.
 *
 * Pure and injected like the other command builders. `openWizard` is the same
 * store method the Settings button and the launch gate call, so all three
 * reset to step 1 without clearing the done-key. The wizard appearing is the
 * confirmation (D22's owning surface); a toast on top of the modal would sit
 * behind the overlay.
 */

export interface OnboardingCommandDeps {
  /** Reset to step 1 and show the wizard. Does not clear the done-key. */
  openWizard: () => void
  /** Dismiss the palette before the wizard takes the overlay. */
  close: () => void
}

export function buildOnboardingCommands(deps: OnboardingCommandDeps): Command[] {
  return [
    {
      id: 'onboarding.rerun',
      label: 'Run first-run setup again',
      icon: 'i-tabler-flag',
      keywords: ['onboarding', 'setup', 'wizard', 'welcome', 'rerun', 'first run'],
      run: () => {
        deps.close()
        deps.openWizard()
      }
    }
  ]
}
