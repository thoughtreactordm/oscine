import { describe, expect, it } from 'vitest'
import {
  briefChanged,
  exclusionLabel,
  exclusionSourceLabel,
  normalizeBrief,
  refreshedLabel,
  SMART_PLAYLIST_LABEL
} from '../../../src/renderer/panels/smartPlaylist'
import type { PlaylistExclusion } from '../../../src/shared/playlists'

const exclusion = (over: Partial<PlaylistExclusion> = {}): PlaylistExclusion => ({
  trackId: 7,
  title: 'Night Bus',
  artist: 'Aria',
  source: 'operator',
  createdAt: '2026-10-31T00:00:00.000Z',
  ...over
})

describe('smart playlist header model (W24-9)', () => {
  it('says what smart means here, and offers nothing that runs an agent', () => {
    expect(SMART_PLAYLIST_LABEL).toBe('Smart: kept up to date by your agent')
    expect(SMART_PLAYLIST_LABEL.toLowerCase()).not.toContain('ai')
  })

  it('saves a trimmed brief, blank meaning none, and only when it changed', () => {
    expect(normalizeBrief('  Rainy folk \n')).toBe('Rainy folk')
    expect(normalizeBrief('   ')).toBeNull()
    expect(briefChanged('Rainy folk ', 'Rainy folk')).toBe(false)
    expect(briefChanged('', null)).toBe(false)
    expect(briefChanged('', 'Rainy folk')).toBe(true)
    expect(briefChanged('Sunny folk', 'Rainy folk')).toBe(true)
  })

  it('names an excluded track and who kept it out', () => {
    expect(exclusionLabel(exclusion())).toBe('Night Bus — Aria')
    expect(exclusionLabel(exclusion({ artist: null }))).toBe('Night Bus')
    expect(exclusionLabel(exclusion({ title: '  ', artist: null }))).toBe('Track 7')
    expect(exclusionSourceLabel(exclusion())).toBe('Removed by you')
    expect(exclusionSourceLabel(exclusion({ source: 'agent' }))).toBe('Removed by your agent')
  })

  it('says when an agent last refreshed it, or that none has', () => {
    expect(refreshedLabel(null)).toBe('Not refreshed by an agent yet')
    expect(refreshedLabel('not a date')).toBe('Not refreshed by an agent yet')
    expect(refreshedLabel('2026-10-31T12:00:00.000Z', 'en-US')).toMatch(
      /^Last refreshed Oct 31, 2026/
    )
  })
})
