import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeDiscId, manualDiscProposal } from '@shared/cdrip'
import { createDiscLookup, parseDiscReleases } from '../../../src/main/cdrip/discLookup'
import { createNetClient } from '../../../src/main/net/client'
import { createScopeRegistry } from '../../../src/main/net/scopes'
import { createCacheService } from '../../../src/main/cache/service'
import { CACHE_MIGRATIONS } from '../../../src/main/cache/migrations'
import { migrate } from '../../../src/main/db/migrate'
import payload from './fixtures/musicbrainz-disc.json'
import fixtures from './fixtures/disc-ids.json'
import { fromToc } from './tocFixture'
import { cdText, pack } from './cdTextFixture'
const toc = fromToc(fixtures[2].toc)
const id = computeDiscId(toc)
const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function harness(status = 200, allowed = true, body: unknown = payload) {
  const db = new Database(':memory:')
  databases.push(db)
  migrate(db, CACHE_MIGRATIONS)
  let now = 0
  const cache = createCacheService({ db, now: () => now })
  const scopes = createScopeRegistry()
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))
  const client = createNetClient({
    consent: { granted: () => allowed },
    limiter: { acquire: async () => {}, waiting: () => 0 },
    scopes,
    fetchImpl,
    maxAttempts: 1
  })
  return {
    cache,
    fetchImpl,
    scopes,
    service: createDiscLookup({ client, cache }),
    disable: () => {
      allowed = false
    },
    stale: () => {
      now += 31 * 86400000
    }
  }
}
describe('disc metadata tiers', () => {
  it('maps a recorded response and keeps the matching medium only', async () => {
    const h = harness()
    const result = await h.service.lookup(toc)
    expect(result.discId).toBe(id)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      source: 'musicbrainz',
      album: 'Ettella Diamant',
      releaseMbid: 'd3dc4be9-9749-4959-99e5-133d0cb467fe',
      country: 'SK',
      format: 'CD'
    })
    expect(result.candidates[0].tracks).toHaveLength(6)
    expect(result.candidates[0].tracks[0].recordingMbid).toBe(
      payload.releases[0].media[0].tracks[0].recording.id
    )
    const url = new URL(String(h.fetchImpl.mock.calls[0][0]))
    expect(url.searchParams.get('inc')).toBe('recordings artist-credits release-groups')
    expect(h.cache.read('musicbrainz.disc', id)?.fresh).toBe(true)
  })
  it('returns every candidate in deterministic order and ignores unrelated media', () => {
    const release = payload.releases[0]
    const later = { ...release, id: '11111111-1111-4111-8111-111111111111', date: '2020' }
    const earlier = { ...release, id: '22222222-2222-4222-8222-222222222222', date: '1990' }
    const unrelated = {
      ...release,
      media: [{ tracks: release.media[0].tracks, discs: [{ id: 'other' }] }]
    }
    const result = parseDiscReleases({ releases: [later, unrelated, earlier] }, id, toc)
    expect(result.map((p) => p.releaseMbid)).toEqual([earlier.id, later.id])
  })
  it('404 falls through to CD-TEXT and is negatively cached', async () => {
    const h = harness(404)
    const textToc = { ...toc, cdText: cdText(pack(0x80, 0, 'Album\0')) }
    expect((await h.service.lookup(textToc)).candidates[0].source).toBe('cdtext')
    expect((await h.service.lookup(toc)).candidates[0]).toEqual(manualDiscProposal(toc))
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
    expect(h.cache.read('musicbrainz.disc', id)?.value).toBeNull()
  })
  it('consent off opens no socket and returns usable manual fields', async () => {
    const h = harness(200, false)
    const proposal = (await h.service.lookup(toc)).candidates[0]
    expect(proposal).toEqual(manualDiscProposal(toc))
    proposal.album = 'My disc'
    proposal.tracks[0].title = 'My song'
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.cache.read('musicbrainz.disc', id)).toBeNull()
  })
  it.each([503, 429, 400])(
    'HTTP %s does not obstruct manual entry or poison the cache',
    async (status) => {
      const h = harness(status)
      expect((await h.service.lookup(toc)).candidates[0].source).toBe('manual')
      expect(h.cache.read('musicbrainz.disc', id)).toBeNull()
    }
  )
  it('offline and malformed responses fall back without negative caching', async () => {
    const h = harness(200, true, { unexpected: true })
    expect((await h.service.lookup(toc)).candidates[0].source).toBe('manual')
    h.fetchImpl.mockRejectedValue(new TypeError('offline'))
    expect((await h.service.lookup(toc)).candidates[0].source).toBe('manual')
    expect(h.cache.read('musicbrainz.disc', id)).toBeNull()
  })
  it('warm and stale positive cache answers remain available with consent off', async () => {
    const h = harness()
    const result = await h.service.lookup(toc)
    h.disable()
    expect(await h.service.lookup(toc)).toEqual(result)
    h.stale()
    expect(await h.service.lookup(toc)).toEqual(result)
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('cancels the cdrip scope at the transport and does not cache cancellation', async () => {
    const h = harness()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    h.fetchImpl.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
          started()
        })
    )
    const pending = h.service.lookup(toc)
    await ready
    expect(h.scopes.cancel('cdrip')).toBe(1)
    expect((await pending).candidates[0].source).toBe('manual')
    expect(h.cache.read('musicbrainz.disc', id)).toBeNull()
    expect(h.scopes.size('cdrip')).toBe(0)
  })
  it('manual proposals exclude enhanced-CD data tracks', () => {
    const enhanced = fromToc(fixtures[3].toc)
    enhanced.entries[7].isAudio = false
    expect(manualDiscProposal(enhanced).tracks).toHaveLength(7)
  })
})
