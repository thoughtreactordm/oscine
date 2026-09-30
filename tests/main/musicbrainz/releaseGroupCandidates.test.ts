/**
 * Release-group candidates for the edit-time cover picker — **W7-17**.
 *
 * The corroboration search ({@link parseReleaseGroupSearch}) throws the MBID
 * away; this projection keeps it, because the MBID is the key the Cover Art
 * Archive front lookup takes. The two read the same endpoint, so this asserts the
 * MBID survives and the ranking is by relevance.
 */

import { describe, expect, it } from 'vitest'

import {
  parseReleaseGroupCandidates,
  searchReleaseGroupCandidates
} from '../../../src/main/musicbrainz/releaseGroups'
import { createNetClient } from '../../../src/main/net/client'
import { CONSENT_GRANTED, type NetworkConsent } from '../../../src/main/net/consent'
import type { RateLimiter } from '../../../src/main/net/rateLimiter'
import { createScopeRegistry } from '../../../src/main/net/scopes'

const REPLY = {
  'release-groups': [
    {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Rumours',
      score: 90,
      'first-release-date': '1977-02-04',
      'artist-credit': [{ name: 'Fleetwood Mac', joinphrase: '' }]
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      title: 'Rumours',
      score: 100,
      disambiguation: '2013 reissue',
      'artist-credit': [
        { name: 'Fleetwood', joinphrase: ' ' },
        { name: 'Mac', joinphrase: '' }
      ]
    },
    // No id: cannot be a cover key, so it is dropped.
    { title: 'Rumours (bootleg)', score: 5, 'artist-credit': [{ name: 'Someone' }] }
  ]
}

function passiveLimiter(): RateLimiter {
  return { acquire: () => Promise.resolve(), waiting: () => 0 }
}

function makeClient(fetchImpl: typeof fetch, consent: NetworkConsent = CONSENT_GRANTED) {
  return createNetClient({
    consent,
    limiter: passiveLimiter(),
    scopes: createScopeRegistry(),
    fetchImpl
  })
}

describe('parseReleaseGroupCandidates', () => {
  it('keeps the MBID, captions, and ranks by score', () => {
    const candidates = parseReleaseGroupCandidates(REPLY)
    expect(candidates).toEqual([
      {
        mbid: '22222222-2222-2222-2222-222222222222',
        title: 'Rumours',
        artist: 'Fleetwood Mac',
        detail: '2013 reissue',
        score: 100
      },
      {
        mbid: '11111111-1111-1111-1111-111111111111',
        title: 'Rumours',
        artist: 'Fleetwood Mac',
        detail: '1977',
        score: 90
      }
    ])
  })

  it('drops an entry with no MBID', () => {
    const candidates = parseReleaseGroupCandidates(REPLY)
    expect(candidates.some((candidate) => candidate.title.includes('bootleg'))).toBe(false)
  })

  it('is empty for a malformed reply', () => {
    expect(parseReleaseGroupCandidates(null)).toEqual([])
    expect(parseReleaseGroupCandidates({})).toEqual([])
  })
})

describe('searchReleaseGroupCandidates', () => {
  it('searches on the cover-art scope and parses the reply', async () => {
    let requested = ''
    const fetchImpl = ((input: RequestInfo | URL) => {
      requested = String(input)
      return Promise.resolve(new Response(JSON.stringify(REPLY)))
    }) as unknown as typeof fetch

    const result = await searchReleaseGroupCandidates(
      makeClient(fetchImpl),
      'Fleetwood Mac',
      'Rumours'
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(2)
    expect(new URL(requested).hostname).toBe('musicbrainz.org')
  })

  it('returns an empty list rather than a failure when there is nothing to ask', async () => {
    const fetchImpl = (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch
    const result = await searchReleaseGroupCandidates(makeClient(fetchImpl), '', '')
    expect(result).toEqual({ ok: true, value: [] })
  })
})
