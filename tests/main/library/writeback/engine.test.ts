import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { splitGenres } from '@shared/genre'
import {
  readEmbeddedArtwork,
  readTrackTags,
  type MetadataReader,
  type TrackTags
} from '../../../../src/main/library/metadata'
import { writeTags, type WriteOutcome } from '../../../../src/main/library/writeback/engine'
import type { WritableTags } from '../../../../src/main/library/writeback/writer'
import {
  buildWritebackCorpus,
  CORRECTED,
  type WritebackCorpusManifest
} from '../../../../scripts/lib/writeback-corpus.mjs'

/**
 * The atomic tag-write engine — W16-3, design authority D28.
 *
 * Two suites. The first drives the atomic mechanics with injected seams, so the
 * copy → apply → fsync → rename → verify sequence and every failure branch run
 * under plain `npm test` with no native tag library and no ffmpeg. The second is
 * the real thing: it synthesises the W16-2 corpus and round-trips all five codecs
 * through the engine and back out through the app's own reader — the card's
 * "verified by read-back on the corpus" acceptance — and is skipped where ffmpeg
 * is absent, exactly as the corpus probe gate is.
 */

const A_TAGS: WritableTags = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  trackNo: 4,
  discNo: 1,
  year: 2026,
  genres: [{ key: 'ambient', label: 'Ambient' }]
}

/** A full `TrackTags` reading back exactly what {@link A_TAGS} proposed. */
function matchingRead(over: Partial<TrackTags> = {}): TrackTags {
  return {
    title: 'Title',
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: 4,
    discNo: 1,
    year: 2026,
    durationMs: null,
    codec: 'flac',
    sampleRate: null,
    channels: null,
    bitDepth: null,
    genre: 'Ambient',
    replayGain: null,
    ...over
  }
}

describe('writeTags — atomic mechanics (injected seams)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-wb-unit-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** An `applyTags` seam that stamps a marker into the temp copy. */
  const stamp =
    (marker: string) =>
    (tempPath: string): void =>
      writeFileSync(tempPath, marker)

  it('replaces the original atomically and leaves no temp behind', async () => {
    const path = join(dir, 'song.flac')
    writeFileSync(path, 'ORIGINAL')

    const outcome = await writeTags(path, A_TAGS, {
      applyTags: stamp('WRITTEN'),
      read: async () => matchingRead()
    })

    expect(outcome).toEqual({ ok: true, codec: 'flac', path })
    expect(readFileSync(path, 'utf8')).toBe('WRITTEN')
    expect(readdirSync(dir)).toEqual(['song.flac'])
  })

  it('refuses an out-of-set format without touching the file', async () => {
    const path = join(dir, 'song.wav')
    writeFileSync(path, 'ORIGINAL')

    const outcome = await writeTags(path, A_TAGS, {
      applyTags: stamp('WRITTEN'),
      read: async () => matchingRead()
    })

    expect(outcome).toMatchObject({ ok: false, code: 'unsupported-format', path })
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['song.wav'])
  })

  it('leaves the original byte-identical when the container write throws', async () => {
    const path = join(dir, 'song.mp3')
    writeFileSync(path, 'ORIGINAL')

    const outcome = await writeTags(path, A_TAGS, {
      applyTags: () => {
        throw new Error('libtag exploded')
      },
      read: async () => matchingRead()
    })

    expect(outcome).toMatchObject({ ok: false, code: 'write-failed' })
    expect(outcome.ok === false && outcome.reason).toContain('libtag exploded')
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['song.mp3'])
  })

  it('rolls the original back byte-identical and names the field when the read-back disagrees', async () => {
    const path = join(dir, 'song.opus')
    writeFileSync(path, 'ORIGINAL')

    const outcome = await writeTags(path, A_TAGS, {
      applyTags: stamp('WRITTEN'),
      read: async () => matchingRead({ title: 'Something Else' })
    })

    expect(outcome).toMatchObject({ ok: false, code: 'verify-failed' })
    expect(outcome.ok === false && outcome.reason).toContain('title')
    // W16-4: the swap already happened, so the failed verify rolls the preserved
    // original back over the bad write — byte-identical — and leaves nothing staged.
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['song.opus'])
  })

  it('reports verify-failed when a genre cannot survive the join and re-split', async () => {
    const path = join(dir, 'song.flac')
    writeFileSync(path, 'ORIGINAL')

    // A label carrying a separator splits into two on re-read — surfaced, not silent.
    const outcome = await writeTags(
      path,
      { ...A_TAGS, genres: [{ key: 'hip-hop/rap', label: 'Hip-Hop/Rap' }] },
      { applyTags: stamp('WRITTEN'), read: async () => matchingRead({ genre: 'Hip-Hop/Rap' }) }
    )

    expect(outcome).toMatchObject({ ok: false, code: 'verify-failed' })
    expect(outcome.ok === false && outcome.reason).toContain('genres')
    // Rolled back byte-identical, no staged sibling left behind.
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['song.flac'])
  })

  it('propagates a read failure as verify-failed and rolls back', async () => {
    const path = join(dir, 'song.m4a')
    writeFileSync(path, 'ORIGINAL')

    const boom: MetadataReader = async () => {
      throw new Error('file vanished')
    }
    const outcome = await writeTags(path, A_TAGS, { applyTags: stamp('WRITTEN'), read: boom })

    expect(outcome).toMatchObject({ ok: false, code: 'verify-failed' })
    expect(outcome.ok === false && outcome.reason).toContain('file vanished')
    // A read that throws is as unsound as a mismatch: the original is restored.
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['song.m4a'])
  })

  it('isolates a verify failure mid-batch: neighbours are written and the report names it', async () => {
    // Three files flushed in sequence, as a batch caller (W16-6) will drive them.
    // The middle one's read-back disagrees; it must roll back byte-identical while
    // its neighbours take the write, and the per-file outcomes must name the failure.
    const paths = ['a.flac', 'b.mp3', 'c.opus'].map((name) => join(dir, name))
    for (const path of paths) writeFileSync(path, 'ORIGINAL')

    const outcomes: WriteOutcome[] = []
    for (const path of paths) {
      const fails = path.endsWith('b.mp3')
      outcomes.push(
        await writeTags(path, A_TAGS, {
          applyTags: stamp('WRITTEN'),
          read: async () => matchingRead(fails ? { title: 'Something Else' } : {})
        })
      )
    }

    expect(outcomes[0]).toMatchObject({ ok: true, path: paths[0] })
    expect(outcomes[2]).toMatchObject({ ok: true, path: paths[2] })
    expect(outcomes[1]).toMatchObject({ ok: false, code: 'verify-failed', path: paths[1] })
    expect(outcomes[1].ok === false && outcomes[1].reason).toContain('title')

    // The failed file is byte-identical; its neighbours took the write; nothing staged.
    expect(readFileSync(paths[0], 'utf8')).toBe('WRITTEN')
    expect(readFileSync(paths[1], 'utf8')).toBe('ORIGINAL')
    expect(readFileSync(paths[2], 'utf8')).toBe('WRITTEN')
    expect(readdirSync(dir).sort()).toEqual(['a.flac', 'b.mp3', 'c.opus'])
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const roundTrip = hasFfmpeg ? describe : describe.skip

roundTrip('writeTags — five-codec round-trip on the corpus (needs ffmpeg)', () => {
  let root: string
  let manifest: WritebackCorpusManifest

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'oscine-wb-corpus-'))
    manifest = await buildWritebackCorpus(root)
  }, 120_000)
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('writes every codec atomically and it reads back through the app reader', async () => {
    const desired: WritableTags = {
      title: CORRECTED.title,
      artist: CORRECTED.artists[0],
      album: CORRECTED.album,
      trackNo: CORRECTED.track,
      discNo: CORRECTED.disc,
      year: CORRECTED.year,
      genres: [
        { key: 'ambient', label: 'Ambient' },
        { key: 'electronic', label: 'Electronic' }
      ]
    }

    for (const track of manifest.tracks) {
      const outcome = await writeTags(track.path, desired)
      expect(outcome, track.id).toMatchObject({ ok: true, codec: track.id })

      const after = await readTrackTags(track.path)
      expect(after.title, track.id).toBe(CORRECTED.title)
      expect(after.artist, track.id).toBe(CORRECTED.artists[0])
      expect(after.album, track.id).toBe(CORRECTED.album)
      expect(after.year, track.id).toBe(CORRECTED.year)
      expect(after.trackNo, track.id).toBe(CORRECTED.track)
      expect(after.discNo, track.id).toBe(CORRECTED.disc)
      expect(
        splitGenres(after.genre).map((genre) => genre.genre),
        track.id
      ).toEqual(['Ambient', 'Electronic'])

      // Unmodelled data survives the scalar write: the cover is present, unchanged.
      const artwork = await readEmbeddedArtwork(track.path)
      expect(artwork.length, track.id).toBe(1)
      expect(
        Buffer.from(artwork[0].bytes).equals(Buffer.from(manifest.cover.bytes)),
        track.id
      ).toBe(true)
    }

    // Atomicity leaves nothing staged behind.
    expect(readdirSync(manifest.libraryDir).filter((name) => name.includes('oscine-wb-'))).toEqual(
      []
    )
  }, 120_000)
})
