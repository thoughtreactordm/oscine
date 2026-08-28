import { ONBOARDING_COMPLETED_KEY } from '@shared/settings'

/**
 * The renderer half of D-ONB-7.
 *
 * Main has already decided what `interface.onboardingCompleted` *is* — including
 * backfilling it true on an existing install. This only reads that answer, and
 * only after hydration, because until `settings.getAll` lands the surface holds
 * the descriptor default (`false`) and would open the wizard on every launch.
 *
 * `openWizard` is injected so this file does not import the onboarding store:
 * the store is a stub until W8-14b, and a test of the gate should not need Pinia.
 */
export async function maybeOpenOnboardingWizard(deps: {
  ready: Promise<void>
  get: <T>(key: string) => T
  openWizard: () => void
}): Promise<void> {
  await deps.ready
  if (deps.get<boolean>(ONBOARDING_COMPLETED_KEY)) return
  deps.openWizard()
}
