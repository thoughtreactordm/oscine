import { describe, expect, it } from 'vitest'
import { parseLrc, type LyricsDocument } from '@shared/lyrics'
import { resolveLyrics, type LyricsResolverDeps } from '../../../../src/main/library/lyrics/service'

const PATH = '/music/Album/Track.flac'

/** A resolver whose tiers default to empty; each test wires only what it needs. */
function deps(overrides: Partial<LyricsResolverDeps>): LyricsResolverDeps {
  return {
    readSidecar: async () => null,
    readEmbeddedLyrics: async () => null,
    ...overrides
  }
}

describe('resolveLyrics — tier order', () => {
  it('prefers the sidecar over embedded tags', async () => {
    const sidecar = parseLrc('[00:01.00]from sidecar', 'sidecar')
    const doc = await resolveLyrics(
      PATH,
      deps({
        readSidecar: async () => sidecar,
        readEmbeddedLyrics: async () => '[00:01.00]from embedded'
      })
    )
    expect(doc?.source).toBe('sidecar')
    expect(doc?.lines[0]?.text).toBe('from sidecar')
  })

  it('falls back to embedded tags when there is no sidecar', async () => {
    const doc = await resolveLyrics(
      PATH,
      deps({ readEmbeddedLyrics: async () => '[00:12.00]embedded line' })
    )
    expect(doc?.source).toBe('embedded')
    expect(doc?.lines[0]?.timeMs).toBe(12_000)
  })

  it('detects embedded LRC-in-USLT as synced', async () => {
    const doc = await resolveLyrics(
      PATH,
      deps({ readEmbeddedLyrics: async () => '[00:00.00]one\n[00:05.00]two' })
    )
    expect(doc?.synced).toBe(true)
  })

  it('treats embedded plain text as an unsynced document', async () => {
    const doc = await resolveLyrics(
      PATH,
      deps({ readEmbeddedLyrics: async () => 'just plain words\nno timing' })
    )
    expect(doc?.synced).toBe(false)
    expect(doc?.lines).toHaveLength(2)
  })

  it('falls through an empty-but-valid sidecar to the embedded tier', async () => {
    // A stray blank .lrc must not mask the embedded lyrics underneath it.
    const doc = await resolveLyrics(
      PATH,
      deps({
        readSidecar: async () => parseLrc('', 'sidecar'),
        readEmbeddedLyrics: async () => '[00:01.00]underneath'
      })
    )
    expect(doc?.source).toBe('embedded')
    expect(doc?.lines[0]?.text).toBe('underneath')
  })

  it('uses the network tier only when both local tiers are empty', async () => {
    const network: LyricsDocument = parseLrc('[00:01.00]from network', 'lrclib')
    const fetchNetworkLyrics = async (): Promise<LyricsDocument | null> => network
    const local = await resolveLyrics(
      PATH,
      deps({ readEmbeddedLyrics: async () => '[00:01.00]local', fetchNetworkLyrics })
    )
    expect(local?.source).toBe('embedded')

    const remote = await resolveLyrics(PATH, deps({ fetchNetworkLyrics }))
    expect(remote?.source).toBe('lrclib')
  })

  it('returns an instrumental network answer even though it carries no lines', async () => {
    // Instrumental is a real answer with zero lines; the network tier must not
    // drop it the way it drops an empty document from a local tier.
    const instrumental: LyricsDocument = {
      lines: [],
      synced: false,
      offsetMs: 0,
      source: 'lrclib',
      instrumental: true
    }
    const doc = await resolveLyrics(PATH, deps({ fetchNetworkLyrics: async () => instrumental }))
    expect(doc?.instrumental).toBe(true)
    expect(doc?.source).toBe('lrclib')
  })

  it('does not treat an empty non-instrumental network document as lyrics', async () => {
    const empty: LyricsDocument = { lines: [], synced: false, offsetMs: 0, source: 'lrclib' }
    expect(await resolveLyrics(PATH, deps({ fetchNetworkLyrics: async () => empty }))).toBeNull()
  })

  it('returns null when no tier has lyrics', async () => {
    expect(await resolveLyrics(PATH, deps({}))).toBeNull()
  })

  it('returns null rather than throwing when a moved file makes a tier reject', async () => {
    const doc = await resolveLyrics(
      PATH,
      deps({
        readSidecar: async () => {
          throw new Error('ENOENT')
        },
        readEmbeddedLyrics: async () => {
          throw new Error('ENOENT')
        }
      })
    )
    expect(doc).toBeNull()
  })
})
