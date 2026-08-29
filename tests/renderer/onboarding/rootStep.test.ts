import { describe, expect, it, vi } from 'vitest'
import { OscineError } from '../../../src/shared/errors'
import type { LibraryRoot } from '../../../src/shared/library'
import { hasOnboardingRoot, pickOnboardingRoot } from '../../../src/renderer/onboarding/rootStep'

/**
 * The root step's contract: one folder, scan starts immediately, re-run does
 * not duplicate, and a cancelled dialog is not an error.
 */

function root(over: Partial<LibraryRoot> = {}): LibraryRoot {
  return {
    id: 1,
    path: '/music',
    addedAt: '2026-01-01T00:00:00.000Z',
    trackCount: 0,
    watchMode: 'starting',
    ...over
  }
}

describe('hasOnboardingRoot', () => {
  it('is false with no folders and true with one', () => {
    expect(hasOnboardingRoot([])).toBe(false)
    expect(hasOnboardingRoot([root()])).toBe(true)
  })
})

describe('pickOnboardingRoot', () => {
  it('adds a folder and kicks off scanRoot without waiting for it', async () => {
    const added = root()
    let finishScan!: (value: void) => void
    const scanRoot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishScan = resolve
        })
    )
    const addRoot = vi.fn(async () => added)

    const result = await pickOnboardingRoot({
      roots: [],
      addRoot,
      scanRoot
    })

    expect(result).toBe(added)
    expect(addRoot).toHaveBeenCalledOnce()
    expect(scanRoot).toHaveBeenCalledOnce()
    expect(scanRoot).toHaveBeenCalledWith(added.id)
    // Indexing is still in flight — pick has already returned so Next is free.
    expect(finishScan).toBeTypeOf('function')
    finishScan()
  })

  it('returns null when the dialog is cancelled, and does not scan', async () => {
    const addRoot = vi.fn(async () => null)
    const scanRoot = vi.fn()

    await expect(pickOnboardingRoot({ roots: [], addRoot, scanRoot })).resolves.toBeNull()
    expect(scanRoot).not.toHaveBeenCalled()
  })

  it('does not open the picker or scan when a root already exists', async () => {
    const existing = root({ id: 7, path: '/already' })
    const addRoot = vi.fn()
    const scanRoot = vi.fn()

    await expect(pickOnboardingRoot({ roots: [existing], addRoot, scanRoot })).resolves.toBe(
      existing
    )
    expect(addRoot).not.toHaveBeenCalled()
    expect(scanRoot).not.toHaveBeenCalled()
  })

  it('does not scan when addRoot rejects', async () => {
    const addRoot = vi.fn(async () => {
      throw new OscineError('conflict', 'That folder is already in your library.')
    })
    const scanRoot = vi.fn()

    await expect(pickOnboardingRoot({ roots: [], addRoot, scanRoot })).rejects.toThrow(OscineError)
    expect(scanRoot).not.toHaveBeenCalled()
  })
})
