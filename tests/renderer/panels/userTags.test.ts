import { describe, expect, it } from 'vitest'
import type { TrackTagView } from '@shared/tags'
import { countUserTags } from '../../../src/renderer/panels/tunedeck/userTags'

/** A track view with the two vocabularies kept apart, as the store hands it over. */
function view(overrides: Partial<TrackTagView> = {}): TrackTagView {
  return { file: [], user: [], ...overrides }
}

describe('countUserTags', () => {
  it('shows nothing before the track has been fetched', () => {
    expect(countUserTags(undefined)).toBeNull()
  })

  it('shows nothing for a track with no tags of the operator’s own', () => {
    expect(countUserTags(view())).toBeNull()
  })

  /**
   * The badge answers "what have I said about this", so the file's genres do not
   * count — a track carrying three ID3 genres and no user tag has nothing of the
   * operator's in it, and the shut group says so by staying blank.
   */
  it('does not count the file’s genres', () => {
    expect(countUserTags(view({ file: ['Rock', 'Jazz', 'Blues'] }))).toBeNull()
  })

  it('counts the operator’s own tags', () => {
    expect(
      countUserTags(
        view({
          file: ['Rock'],
          user: [
            { id: 1, label: 'mellow', source: 'user' },
            { id: 2, label: 'roadtrip', source: 'user' }
          ]
        })
      )
    ).toBe('2')
  })
})
