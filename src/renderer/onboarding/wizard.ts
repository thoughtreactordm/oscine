/**
 * The first-run wizard's step machine, without Pinia or a modal.
 *
 * `openWizard` resets to step 1 and does not touch the done-key — re-running
 * from Settings is not un-onboarding (D-ONB-6). `close` is Cancel, X, Esc and
 * Finish: keep everything already applied, mark the done-key, hide the modal
 * (D-ONB-4). There is no rollback and no end-of-wizard flush.
 *
 * `canAdvance` is the root step's gate (14c). Skippable steps always let Next
 * through; a missing `canAdvance` is treated as true so a test of next/back
 * does not have to invent a library.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { OnboardingStep } from './steps'

export interface OnboardingWizardDeps {
  steps: readonly OnboardingStep[]
  /** Write `interface.onboardingCompleted = true`. Not called by `openWizard`. */
  markCompleted: () => void
  /**
   * Whether a non-skippable step will let Next through. Injected so the root
   * step can require a folder without this file knowing about `library.addRoot`.
   */
  canAdvance?: () => boolean
}

export interface OnboardingWizard {
  readonly open: Ref<boolean>
  /** 1-based, as the card writes it. */
  readonly step: ComputedRef<number>
  readonly current: ComputedRef<OnboardingStep>
  readonly isFirst: ComputedRef<boolean>
  readonly isLast: ComputedRef<boolean>
  readonly canAdvance: ComputedRef<boolean>
  readonly stepCount: number
  openWizard(): void
  close(): void
  next(): void
  back(): void
}

export function createOnboardingWizard(deps: OnboardingWizardDeps): OnboardingWizard {
  const steps = deps.steps
  if (steps.length === 0) throw new RangeError('onboarding needs at least one step')

  const open = ref(false)
  const index = ref(0)

  const current = computed(() => steps[index.value] as OnboardingStep)
  const step = computed(() => index.value + 1)
  const isFirst = computed(() => index.value === 0)
  const isLast = computed(() => index.value === steps.length - 1)
  const canAdvance = computed(() => {
    if (current.value.skippable) return true
    return deps.canAdvance ? deps.canAdvance() : true
  })

  function openWizard(): void {
    index.value = 0
    open.value = true
  }

  function close(): void {
    const wasOpen = open.value
    open.value = false
    // Only the transition from open marks done. A second dismiss — overlay
    // click echoing `open = false` — must not write the key again, and a close
    // of an already-closed wizard is not a completion.
    if (wasOpen) deps.markCompleted()
  }

  function next(): void {
    if (!canAdvance.value) return
    if (isLast.value) {
      close()
      return
    }
    index.value += 1
  }

  function back(): void {
    if (index.value === 0) return
    index.value -= 1
  }

  return {
    open,
    step,
    current,
    isFirst,
    isLast,
    canAdvance,
    stepCount: steps.length,
    openWizard,
    close,
    next,
    back
  }
}
