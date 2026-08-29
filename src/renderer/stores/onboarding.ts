import { defineStore } from 'pinia'
import { useSettings } from '@renderer/settings'
import { hasOnboardingRoot } from '@renderer/onboarding/rootStep'
import { ONBOARDING_STEPS } from '@renderer/onboarding/steps'
import { createOnboardingWizard } from '@renderer/onboarding/wizard'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { ONBOARDING_COMPLETED_KEY } from '@shared/settings'

/**
 * First-run wizard state.
 *
 * A store rather than component state because the launch gate in `AppShell`,
 * the modal, the Settings re-run button, and the palette's `onboarding.rerun`
 * all flip the same flag, and none of them may own it. `openWizard` resets to
 * step 1 and does not clear the done-key; `close` keeps applied work and marks
 * onboarding complete.
 *
 * Next on the root step is gated on `libraryRoots` having at least one folder,
 * so re-running with a library already present walks straight through, and a
 * fresh profile cannot leave the first step empty-handed.
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  const settings = useSettings()
  const roots = useLibraryRootsStore()

  return createOnboardingWizard({
    steps: ONBOARDING_STEPS,
    markCompleted: () => {
      void settings.set(ONBOARDING_COMPLETED_KEY, true)
    },
    canAdvance: () => hasOnboardingRoot(roots.roots)
  })
})
