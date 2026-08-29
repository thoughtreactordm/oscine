import { describe, expect, it } from 'vitest'
import type { ScanProgress } from '../../../src/shared/library'
import { describeScanStep, libraryTrackCount } from '../../../src/renderer/onboarding/scanStep'

function progress(over: Partial<ScanProgress> = {}): ScanProgress {
  return {
    rootId: 1,
    filesSeen: 4,
    tracksIndexed: 2,
    currentFile: '01.flac',
    done: false,
    ...over
  }
}

describe('describeScanStep', () => {
  it('shows live counts and the current file while a scan is in flight', () => {
    const view = describeScanStep(progress(), 0)
    expect(view.active).toBe(true)
    expect(view.headline).toBe('Indexing…')
    expect(view.counts).toBe('4 found · 2 indexed')
    expect(view.file).toBe('01.flac')
  })

  it('prefers the in-flight scan over tracks already in the library', () => {
    const view = describeScanStep(progress(), 40)
    expect(view.active).toBe(true)
    expect(view.headline).toBe('Indexing…')
  })

  it('treats a finished library as ready, not as still indexing', () => {
    const view = describeScanStep(null, 40)
    expect(view.active).toBe(false)
    expect(view.headline).toBe('Your library is ready')
    expect(view.counts).toMatch(/40/)
    expect(view.file).toBeNull()
  })

  it('does not claim the library is ready while waiting on the first progress event', () => {
    const view = describeScanStep(null, 0)
    expect(view.active).toBe(false)
    expect(view.headline).toBe('Indexing in the background')
    expect(view.file).toBeNull()
  })
})

describe('libraryTrackCount', () => {
  it('sums every root', () => {
    expect(libraryTrackCount([{ trackCount: 3 }, { trackCount: 7 }])).toBe(10)
    expect(libraryTrackCount([])).toBe(0)
  })
})
