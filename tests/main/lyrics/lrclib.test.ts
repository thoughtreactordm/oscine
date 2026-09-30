import { describe, expect, it } from 'vitest'
import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import type { NetClient, NetGetRequest } from '../../../src/main/net/client'
import {
  fetchLrclibLyrics,
  lrclibGetUrl,
  type LrclibQuery
} from '../../../src/main/library/lyrics/lrclib'

const QUERY: LrclibQuery = {
  artist: 'Radiohead',
  title: 'Creep',
  album: 'Pablo Honey',
  durationSec: 238
}

/** A `NetClient` that answers `getJson` from one canned value and records the request. */
function stubClient(answer: unknown | NetFailure, seen?: NetGetRequest[]): NetClient {
  const unused = <T>(): Promise<NetResult<T>> =>
    Promise.resolve(netFailed<T>({ kind: 'rejected', message: 'unused' }))
  return {
    getText: () => unused<string>(),
    postJson: () => unused<never>(),
    getBytes: () => unused<Uint8Array>(),
    getJson<T>(request: NetGetRequest): Promise<NetResult<T>> {
      seen?.push(request)
      if (answer !== null && typeof answer === 'object' && 'kind' in (answer as object)) {
        return Promise.resolve(netFailed<T>(answer as NetFailure))
      }
      return Promise.resolve(netOk(answer as T))
    }
  }
}

describe('lrclibGetUrl', () => {
  it('sends artist, title, album and duration (seconds)', () => {
    const url = new URL(lrclibGetUrl(QUERY))
    expect(url.origin + url.pathname).toBe('https://lrclib.net/api/get')
    expect(url.searchParams.get('artist_name')).toBe('Radiohead')
    expect(url.searchParams.get('track_name')).toBe('Creep')
    expect(url.searchParams.get('album_name')).toBe('Pablo Honey')
    expect(url.searchParams.get('duration')).toBe('238')
  })

  it('omits duration and album when they are absent', () => {
    const url = new URL(lrclibGetUrl({ artist: 'X', title: 'Y', album: null, durationSec: null }))
    expect(url.searchParams.has('duration')).toBe(false)
    expect(url.searchParams.has('album_name')).toBe(false)
  })

  it('rounds a fractional duration to whole seconds', () => {
    const url = new URL(lrclibGetUrl({ ...QUERY, durationSec: 238.6 }))
    expect(url.searchParams.get('duration')).toBe('239')
  })
})

describe('fetchLrclibLyrics', () => {
  it('sends the request on the lyrics scope as JSON', async () => {
    const seen: NetGetRequest[] = []
    await fetchLrclibLyrics(stubClient({ syncedLyrics: '[00:01.00]hi' }, seen), QUERY)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.scope).toBe('lyrics')
    expect(seen[0]!.accept).toBe('application/json')
  })

  it('parses synced lyrics into a timed document', async () => {
    const synced = '[00:19.16]When you were here before\n[00:24.00]Couldn’t look you in the eye'
    const result = await fetchLrclibLyrics(
      stubClient({ syncedLyrics: synced, duration: 238 }),
      QUERY
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('lrclib')
    expect(result.value.synced).toBe(true)
    expect(result.value.lines).toHaveLength(2)
    expect(result.value.lines[0]).toMatchObject({
      timeMs: 19160,
      text: 'When you were here before'
    })
  })

  it('surfaces instrumental as its own answer, not a miss', async () => {
    const result = await fetchLrclibLyrics(
      stubClient({ instrumental: true, plainLyrics: null, syncedLyrics: null, duration: 238 }),
      QUERY
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.instrumental).toBe(true)
    expect(result.value.synced).toBe(false)
    expect(result.value.lines).toHaveLength(0)
  })

  it('degrades malformed synced lyrics to the plain field rather than throwing', async () => {
    const result = await fetchLrclibLyrics(
      stubClient({
        syncedLyrics: 'no timestamps here at all',
        plainLyrics: 'PLAIN LINE ONE\nPLAIN LINE TWO',
        duration: 238
      }),
      QUERY
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.synced).toBe(false)
    expect(result.value.lines[0]?.text).toBe('PLAIN LINE ONE')
  })

  it('rejects a returned cut whose duration does not match', async () => {
    const result = await fetchLrclibLyrics(
      stubClient({ syncedLyrics: '[00:01.00]wrong song', duration: 180 }),
      QUERY
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('not-found')
  })

  it('accepts a duration within the tolerance', async () => {
    const result = await fetchLrclibLyrics(
      stubClient({ syncedLyrics: '[00:01.00]right song', duration: 239 }),
      QUERY
    )
    expect(result.ok).toBe(true)
  })

  it('passes a 404 through as not-found', async () => {
    const result = await fetchLrclibLyrics(
      stubClient({ kind: 'not-found', message: 'TrackNotFound' }),
      QUERY
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('not-found')
  })

  it('treats a 200 with no lyrics and no instrumental flag as a miss', async () => {
    const result = await fetchLrclibLyrics(
      stubClient({ plainLyrics: '', syncedLyrics: '', duration: 238 }),
      QUERY
    )
    expect(result.ok).toBe(false)
  })
})
