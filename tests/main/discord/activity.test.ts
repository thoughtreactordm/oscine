import { describe, expect, it } from 'vitest'
import type { PresenceSignal, PresenceTrack } from '@shared/presence'
import type { DiscordSettings } from '@shared/settings/discord'
import {
  buildActivity,
  DISCORD_ACTIVITY_TYPE_LISTENING,
  GENERIC_DETAILS,
  STATUS_DISPLAY_DETAILS,
  STATUS_DISPLAY_NAME
} from '../../../src/main/discord/activity'
import { OSCINE_LOGO_ASSET_KEY } from '../../../src/main/discord/appId'

const NOW = 1_700_000_000_000

const TRACK: PresenceTrack = {
  title: 'Teardrop',
  artist: 'Massive Attack',
  album: 'Mezzanine',
  albumArtist: 'Massive Attack',
  durationMs: 330_000
}

function settings(overrides: Partial<DiscordSettings> = {}): DiscordSettings {
  return {
    enabled: true,
    display: 'title-artist',
    showAlbumArt: false,
    showTimestamp: true,
    whenPaused: 'paused',
    ...overrides
  }
}

function playing(overrides: Partial<PresenceSignal> = {}): PresenceSignal {
  return { track: TRACK, positionMs: 30_000, paused: false, playing: true, ...overrides }
}

describe('buildActivity — clears', () => {
  it('clears when disabled', () => {
    expect(buildActivity(settings({ enabled: false }), playing(), NOW)).toBeNull()
  })

  it('clears when not playing', () => {
    expect(buildActivity(settings(), playing({ playing: false }), NOW)).toBeNull()
  })

  it('clears when there is no track', () => {
    expect(
      buildActivity(settings(), { track: null, positionMs: 0, paused: false, playing: false }, NOW)
    ).toBeNull()
  })
})

describe('buildActivity — display modes', () => {
  it('title-artist puts title in details and artist in state', () => {
    const activity = buildActivity(settings({ display: 'title-artist' }), playing(), NOW)
    expect(activity?.type).toBe(DISCORD_ACTIVITY_TYPE_LISTENING)
    expect(activity?.details).toBe('Teardrop')
    expect(activity?.state).toBe('Massive Attack')
  })

  it('title-only omits the state line', () => {
    const activity = buildActivity(settings({ display: 'title-only' }), playing(), NOW)
    expect(activity?.details).toBe('Teardrop')
    expect(activity?.state).toBeUndefined()
  })

  it('title-artist collapses to title-only when the track has no artist', () => {
    const activity = buildActivity(
      settings({ display: 'title-artist' }),
      playing({ track: { ...TRACK, artist: null } }),
      NOW
    )
    expect(activity?.details).toBe('Teardrop')
    expect(activity?.state).toBeUndefined()
  })

  it('generic shows the fixed floor and leaks neither title nor artist anywhere', () => {
    const activity = buildActivity(settings({ display: 'generic' }), playing(), NOW)
    expect(activity?.details).toBe(GENERIC_DETAILS)
    expect(activity?.state).toBeUndefined()
    const serialized = JSON.stringify(activity)
    expect(serialized).not.toContain('Teardrop')
    expect(serialized).not.toContain('Massive Attack')
    expect(serialized).not.toContain('Mezzanine')
  })
})

describe('buildActivity — timestamps', () => {
  it('computes start/end from position and duration when playing', () => {
    const activity = buildActivity(
      settings({ showTimestamp: true }),
      playing({ positionMs: 30_000 }),
      NOW
    )
    expect(activity?.timestamps).toEqual({ start: NOW - 30_000, end: NOW - 30_000 + 330_000 })
  })

  it('omits timestamps when the progress bar is turned off', () => {
    const activity = buildActivity(settings({ showTimestamp: false }), playing(), NOW)
    expect(activity?.timestamps).toBeUndefined()
  })

  it('is heartbeat-stable: a steady advance yields the same start anchor', () => {
    const first = buildActivity(settings(), playing({ positionMs: 30_000 }), NOW)
    // 15s later, 15s further into the track — the anchors must not drift.
    const second = buildActivity(settings(), playing({ positionMs: 45_000 }), NOW + 15_000)
    expect(second?.timestamps).toEqual(first?.timestamps)
  })
})

describe('buildActivity — paused', () => {
  it('hides presence when whenPaused is hide', () => {
    expect(
      buildActivity(settings({ whenPaused: 'hide' }), playing({ paused: true }), NOW)
    ).toBeNull()
  })

  it('shows a Paused indicator with no timestamps when whenPaused is paused', () => {
    const activity = buildActivity(
      settings({ whenPaused: 'paused', display: 'title-artist' }),
      playing({ paused: true }),
      NOW
    )
    expect(activity?.details).toBe('Teardrop')
    expect(activity?.state).toBe('Paused')
    expect(activity?.timestamps).toBeUndefined()
  })

  it('keeps the generic floor while paused — still no leak', () => {
    const activity = buildActivity(
      settings({ whenPaused: 'paused', display: 'generic' }),
      playing({ paused: true }),
      NOW
    )
    expect(activity?.details).toBe(GENERIC_DETAILS)
    expect(activity?.state).toBe('Paused')
    expect(JSON.stringify(activity)).not.toContain('Teardrop')
  })
})

describe('buildActivity — status line', () => {
  it('points the status line at the song title in the detail modes', () => {
    for (const display of ['title-artist', 'title-only'] as const) {
      const activity = buildActivity(settings({ display }), playing(), NOW)
      expect(activity?.status_display_type).toBe(STATUS_DISPLAY_DETAILS)
      expect(activity?.details).toBe('Teardrop')
    }
  })

  it('keeps the status line on the app name in generic mode — no title leak', () => {
    const activity = buildActivity(settings({ display: 'generic' }), playing(), NOW)
    expect(activity?.status_display_type).toBe(STATUS_DISPLAY_NAME)
  })
})

describe('buildActivity — assets', () => {
  it('carries the static logo, with the real album as the hover label at full detail', () => {
    const activity = buildActivity(settings({ display: 'title-artist' }), playing(), NOW)
    expect(activity?.assets).toEqual({
      large_image: OSCINE_LOGO_ASSET_KEY,
      large_text: 'Mezzanine'
    })
  })

  it('omits the album hover label in title-only mode', () => {
    const activity = buildActivity(settings({ display: 'title-only' }), playing(), NOW)
    expect(activity?.assets).toEqual({ large_image: OSCINE_LOGO_ASSET_KEY })
  })

  it('omits the album hover label in generic mode — no leak', () => {
    const activity = buildActivity(settings({ display: 'generic' }), playing(), NOW)
    expect(activity?.assets).toEqual({ large_image: OSCINE_LOGO_ASSET_KEY })
  })

  it('omits the album hover label when the track has no album', () => {
    const activity = buildActivity(
      settings({ display: 'title-artist' }),
      playing({ track: { ...TRACK, album: null } }),
      NOW
    )
    expect(activity?.assets).toEqual({ large_image: OSCINE_LOGO_ASSET_KEY })
  })
})
