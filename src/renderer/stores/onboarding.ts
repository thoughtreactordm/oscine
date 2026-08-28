import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * First-run wizard state.
 *
 * W8-14a needs a name for the launch gate to call after hydration. The modal,
 * the step machine and cancel-marks-done land in W8-14b; until then `openWizard`
 * only flips `open` so the call site in `AppShell` is the real one and a fresh
 * install does not crash waiting on a store that is not there.
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  const open = ref(false)

  function openWizard(): void {
    open.value = true
  }

  function close(): void {
    open.value = false
  }

  return { open, openWizard, close }
})
