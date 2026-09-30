import { describe, expect, it } from 'vitest'
import type { PresenceTrack } from '@shared/presence'
import { renderStatusLine, STATUS_LINE_MAX_LENGTH } from '../../../src/main/discord/statusLine'

const TRACK: PresenceTrack = {
  title: 'Teardrop',
  artist: 'Massive Attack',
  album: 'Mezzanine',
  albumArtist: 'Massive Attack',
  durationMs: 330_000
}

function track(overrides: Partial<PresenceTrack> = {}): PresenceTrack {
  return { ...TRACK, ...overrides }
}

describe('renderStatusLine — substitution', () => {
  it('substitutes each known token from the track', () => {
    expect(renderStatusLine('{title}', track())).toBe('Teardrop')
    expect(renderStatusLine('{artist}', track())).toBe('Massive Attack')
    expect(renderStatusLine('{album}', track())).toBe('Mezzanine')
    expect(renderStatusLine('{albumArtist}', track())).toBe('Massive Attack')
  })

  it('renders literal text around tokens verbatim', () => {
    expect(renderStatusLine('{artist} — {title}', track())).toBe('Massive Attack — Teardrop')
    expect(renderStatusLine('now: {title}', track())).toBe('now: Teardrop')
  })

  it('strips unknown tokens', () => {
    expect(renderStatusLine('{genre} {title}', track())).toBe('Teardrop')
    expect(renderStatusLine('{Title}', track())).toBe('Teardrop') // token names are case-sensitive
  })
})

describe('renderStatusLine — collapsing empties', () => {
  it('drops a leading token that resolves empty, with its separator', () => {
    expect(renderStatusLine('{artist} — {title}', track({ artist: null }))).toBe('Teardrop')
  })

  it('drops a trailing token that resolves empty, with its separator', () => {
    expect(renderStatusLine('{title} — {album}', track({ album: null }))).toBe('Teardrop')
  })

  it('collapses a stranded connector when a middle token vanishes', () => {
    expect(renderStatusLine('{artist} — {album} — {title}', track({ album: null }))).toBe(
      'Massive Attack — Teardrop'
    )
  })

  it('removes the empty bracket pair a missing field leaves', () => {
    expect(renderStatusLine('{title} ({album})', track({ album: null }))).toBe('Teardrop')
    expect(renderStatusLine('{title} ({album})', track())).toBe('Teardrop (Mezzanine)')
  })

  it('handles comma-style separators too', () => {
    expect(renderStatusLine('{artist}, {album}, {title}', track({ album: null }))).toBe(
      'Massive Attack, Teardrop'
    )
  })

  it('falls back to the title when the whole template renders empty', () => {
    expect(renderStatusLine('{album}', track({ album: null }))).toBe('Teardrop')
    expect(renderStatusLine('{genre}', track())).toBe('Teardrop')
  })
})

describe('renderStatusLine — bounds', () => {
  it('caps the rendered line at the Discord field limit', () => {
    const long = 'x'.repeat(400)
    const rendered = renderStatusLine('{title}', track({ title: long }))
    expect(rendered.length).toBe(STATUS_LINE_MAX_LENGTH)
  })

  it('collapses whitespace runs to a single space', () => {
    expect(renderStatusLine('{artist}    {title}', track())).toBe('Massive Attack Teardrop')
  })
})
