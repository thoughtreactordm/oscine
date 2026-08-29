import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createOnboardingWizard } from '../../../src/renderer/onboarding/wizard'
import type { OnboardingStep } from '../../../src/renderer/onboarding/steps'

/**
 * The wizard's step machine: open resets to 1 without touching the done-key,
 * close keeps applied work and marks complete, next/back walk the list.
 */

const STEPS: readonly OnboardingStep[] = [
  {
    id: 'one',
    kind: 'special',
    title: 'One',
    blurb: 'First',
    skippable: false,
    keys: []
  },
  {
    id: 'two',
    kind: 'surface',
    title: 'Two',
    blurb: 'Second',
    skippable: true,
    keys: ['theme.mode']
  },
  {
    id: 'three',
    kind: 'special',
    title: 'Three',
    blurb: 'Last',
    skippable: true,
    keys: []
  }
]

function wizard(over: { canAdvance?: () => boolean } = {}) {
  const markCompleted = vi.fn()
  const model = createOnboardingWizard({
    steps: STEPS,
    markCompleted,
    ...over
  })
  return { model, markCompleted }
}

describe('createOnboardingWizard', () => {
  it('starts closed on step 1', () => {
    const { model, markCompleted } = wizard()
    expect(model.open.value).toBe(false)
    expect(model.step.value).toBe(1)
    expect(model.current.value.id).toBe('one')
    expect(model.isFirst.value).toBe(true)
    expect(model.isLast.value).toBe(false)
    expect(markCompleted).not.toHaveBeenCalled()
  })

  it('openWizard shows the modal at step 1 and does not clear the done-key', () => {
    const { model, markCompleted } = wizard()
    model.openWizard()
    model.next()
    expect(model.step.value).toBe(2)

    model.openWizard()

    expect(model.open.value).toBe(true)
    expect(model.step.value).toBe(1)
    expect(markCompleted).not.toHaveBeenCalled()
  })

  it('close hides the modal and marks onboarding complete', () => {
    const { model, markCompleted } = wizard()
    model.openWizard()
    model.close()

    expect(model.open.value).toBe(false)
    expect(markCompleted).toHaveBeenCalledOnce()
  })

  it('does not mark complete again when already closed', () => {
    const { model, markCompleted } = wizard()
    model.openWizard()
    model.close()
    model.close()
    expect(markCompleted).toHaveBeenCalledOnce()
  })

  it('walks next and back between steps', () => {
    const { model } = wizard()
    model.openWizard()

    model.next()
    expect(model.current.value.id).toBe('two')
    expect(model.step.value).toBe(2)
    expect(model.isFirst.value).toBe(false)
    expect(model.isLast.value).toBe(false)

    model.next()
    expect(model.current.value.id).toBe('three')
    expect(model.isLast.value).toBe(true)

    model.back()
    expect(model.current.value.id).toBe('two')

    model.back()
    expect(model.current.value.id).toBe('one')
    expect(model.isFirst.value).toBe(true)

    model.back()
    expect(model.current.value.id).toBe('one')
  })

  it('Finish on the last step is close: marks complete and hides', () => {
    const { model, markCompleted } = wizard()
    model.openWizard()
    model.next()
    model.next()
    expect(model.isLast.value).toBe(true)

    model.next()

    expect(model.open.value).toBe(false)
    expect(markCompleted).toHaveBeenCalledOnce()
  })

  it('re-running after Finish opens at step 1 and does not un-complete', () => {
    const { model, markCompleted } = wizard()
    model.openWizard()
    model.next()
    model.next()
    model.next()
    expect(markCompleted).toHaveBeenCalledOnce()

    model.openWizard()

    expect(model.open.value).toBe(true)
    expect(model.step.value).toBe(1)
    expect(markCompleted).toHaveBeenCalledOnce()

    model.next()
    model.next()
    model.next()

    expect(model.open.value).toBe(false)
    expect(markCompleted).toHaveBeenCalledTimes(2)
  })

  it('refuses Next when canAdvance is false', () => {
    const { model, markCompleted } = wizard({ canAdvance: () => false })
    model.openWizard()

    model.next()

    expect(model.step.value).toBe(1)
    expect(model.open.value).toBe(true)
    expect(markCompleted).not.toHaveBeenCalled()
  })

  it('recomputes canAdvance when its dependency changes', () => {
    const ready = ref(false)
    const { model } = wizard({ canAdvance: () => ready.value })
    model.openWizard()

    expect(model.canAdvance.value).toBe(false)
    model.next()
    expect(model.step.value).toBe(1)

    ready.value = true
    expect(model.canAdvance.value).toBe(true)
    model.next()
    expect(model.current.value.id).toBe('two')
  })

  it('lets Next through a skippable step even when canAdvance is false', () => {
    const markCompleted = vi.fn()
    const model = createOnboardingWizard({
      steps: [
        {
          id: 'skip',
          kind: 'surface',
          title: 'Skip',
          blurb: 'Optional',
          skippable: true,
          keys: []
        },
        STEPS[1]!
      ],
      markCompleted,
      canAdvance: () => false
    })
    model.openWizard()

    expect(model.canAdvance.value).toBe(true)
    model.next()
    expect(model.current.value.id).toBe('two')
  })

  it('Finish on a skippable last step is not gated on canAdvance', () => {
    const markCompleted = vi.fn()
    const model = createOnboardingWizard({
      steps: [
        {
          id: 'rootish',
          kind: 'special',
          title: 'Root',
          blurb: 'Folder',
          skippable: true,
          keys: []
        },
        {
          id: 'scan',
          kind: 'special',
          title: 'Ready',
          blurb: 'Indexing',
          skippable: true,
          keys: []
        }
      ],
      markCompleted,
      canAdvance: () => false
    })
    model.openWizard()
    model.next()
    expect(model.current.value.id).toBe('scan')
    expect(model.isLast.value).toBe(true)
    expect(model.canAdvance.value).toBe(true)

    model.next()

    expect(model.open.value).toBe(false)
    expect(markCompleted).toHaveBeenCalledOnce()
  })
})
