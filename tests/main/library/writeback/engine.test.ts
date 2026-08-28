import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { splitGenres } from '@shared/genre'
import {
  readEmbeddedArtwork,
  readTrackTags,
  resolveFrontCover,
  type MetadataReader,
  type TrackTags
} from '../../../../src/main/library/metadata'
import { writeTags, type WriteOutcome } from '../../../../src/main/library/writeback/engine'
import { ARTWORK_UNCHANGED, type WritableTags } from '../../../../src/main/library/writeback/writer'
import { artworkHash } from '../../../../src/main/library/derivedArtwork'
import { ByteVector, File as TagFile, Picture, PictureType } from 'node-taglib-sharp'
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
  genres: [{ key: 'ambient', label: 'Ambient' }],
  artwork: ARTWORK_UNCHANGED
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

  it('does not read pictures when the artwork intent is unchanged', async () => {
    const path = join(dir, 'song.flac')
    writeFileSync(path, 'ORIGINAL')

    const outcome = await writeTags(path, A_TAGS, {
      applyTags: stamp('WRITTEN'),
      read: async () => matchingRead(),
      readArtwork: async () => {
        throw new Error('should not read artwork')
      }
    })

    expect(outcome).toEqual({ ok: true, codec: 'flac', path })
  })

  it('accepts a set cover whose hash matches the write', async () => {
    const path = join(dir, 'song.flac')
    writeFileSync(path, 'ORIGINAL')
    const bytes = Buffer.from('new-cover')

    const outcome = await writeTags(
      path,
      { ...A_TAGS, artwork: { kind: 'set', bytes, mime: 'image/png' } },
      {
        applyTags: stamp('WRITTEN'),
        read: async () => matchingRead(),
        readArtwork: async () => [{ index: 0, format: 'image/png', type: 'Cover (front)', bytes }]
      }
    )

    expect(outcome).toEqual({ ok: true, codec: 'flac', path })
    expect(readFileSync(path, 'utf8')).toBe('WRITTEN')
  })

  it('compares cover bytes by hash, not by presence, and rolls back byte-identical', async () => {
    const path = join(dir, 'song.mp3')
    writeFileSync(path, 'ORIGINAL')
    const intended = Buffer.from('intended-cover')
    const shortWritten = Buffer.from('short')

    const outcome = await writeTags(
      path,
      { ...A_TAGS, artwork: { kind: 'set', bytes: intended, mime: 'image/png' } },
      {
        applyTags: stamp('CORRUPT'),
        read: async () => matchingRead(),
        readArtwork: async () => [
          { index: 0, format: 'image/png', type: 'Cover (front)', bytes: shortWritten }
        ]
      }
    )

    expect(outcome).toMatchObject({ ok: false, code: 'verify-failed' })
    expect(outcome.ok === false && outcome.reason).toContain('artwork')
    expect(outcome.ok === false && outcome.reason).toContain(artworkHash(intended))
    // W16-4: the backup already contains the pictures, so artwork rollback is
    // the same rename as a scalar mismatch — the file is byte-identical.
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['song.mp3'])
  })

  it('rolls back when a clear leaves a front cover behind', async () => {
    const path = join(dir, 'song.opus')
    writeFileSync(path, 'ORIGINAL')

    const outcome = await writeTags(
      path,
      { ...A_TAGS, artwork: { kind: 'clear' } },
      {
        applyTags: stamp('STILL-HAS-COVER'),
        read: async () => matchingRead(),
        readArtwork: async () => [
          {
            index: 0,
            format: 'image/png',
            type: 'Cover (front)',
            bytes: Buffer.from('left-behind')
          }
        ]
      }
    )

    expect(outcome).toMatchObject({ ok: false, code: 'verify-failed' })
    expect(outcome.ok === false && outcome.reason).toContain('artwork')
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
  })

  it('accepts a clear whose file no longer has a front cover', async () => {
    const path = join(dir, 'song.flac')
    writeFileSync(path, 'ORIGINAL')

    const outcome = await writeTags(
      path,
      { ...A_TAGS, artwork: { kind: 'clear' } },
      {
        applyTags: stamp('WRITTEN'),
        read: async () => matchingRead(),
        readArtwork: async () => [
          { index: 0, format: 'image/png', type: 'Cover (back)', bytes: Buffer.from('back') }
        ]
      }
    )

    expect(outcome).toEqual({ ok: true, codec: 'flac', path })
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
      ],
      artwork: ARTWORK_UNCHANGED
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

      // Unmodelled data survives the scalar write: the front cover is unchanged,
      // and a typed back cover (every codec except AAC) is still there. Apple
      // `covr` has no picture-type field, so both seeded pictures survive as
      // untyped and `resolveFrontCover` cannot pick a front among two.
      const artwork = await readEmbeddedArtwork(track.path)
      if (track.id === 'aac') {
        expect(artwork.length, track.id).toBe(2)
        const blobs = artwork.map((picture) => Buffer.from(picture.bytes))
        expect(
          blobs.some((bytes) => bytes.equals(Buffer.from(manifest.cover.bytes))),
          track.id
        ).toBe(true)
        expect(
          blobs.some((bytes) => bytes.equals(Buffer.from(manifest.backCover.bytes))),
          track.id
        ).toBe(true)
      } else {
        const front = resolveFrontCover(artwork)
        expect(front, track.id).not.toBeNull()
        expect(Buffer.from(front!.bytes).equals(Buffer.from(manifest.cover.bytes)), track.id).toBe(
          true
        )
        const back = artwork.find((picture) => (picture.type ?? '').toLowerCase().includes('back'))
        expect(back, track.id).not.toBeNull()
        expect(
          Buffer.from(back!.bytes).equals(Buffer.from(manifest.backCover.bytes)),
          track.id
        ).toBe(true)
      }
    }

    // Atomicity leaves nothing staged behind.
    expect(readdirSync(manifest.libraryDir).filter((name) => name.includes('oscine-wb-'))).toEqual(
      []
    )
  }, 120_000)

  it('replaces the front cover by hash on every codec and leaves a back cover byte-identical', async () => {
    // Apple `covr` has no picture-type field, so AAC cannot preserve a typed
    // back cover across a write — Decision B applies to the four codecs whose
    // containers actually distinguish front from the rest.
    const typed = manifest.tracks.filter((track) => track.id !== 'aac')
    const newCover = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64'
    )
    const backCover = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
      'base64'
    )

    for (const track of typed) {
      embedPictures(track.path, [
        { type: PictureType.FrontCover, bytes: manifest.cover.bytes },
        { type: PictureType.BackCover, bytes: backCover }
      ])

      const outcome = await writeTags(track.path, {
        ...A_TAGS,
        artwork: { kind: 'set', bytes: newCover, mime: 'image/png' }
      })
      expect(outcome, track.id).toMatchObject({ ok: true, codec: track.id })

      const pictures = await readEmbeddedArtwork(track.path)
      const front = pictures.find((p) => (p.type ?? '').toLowerCase().includes('front'))
      const back = pictures.find((p) => (p.type ?? '').toLowerCase().includes('back'))
      expect(front, track.id).toBeDefined()
      expect(artworkHash(front!.bytes), track.id).toBe(artworkHash(newCover))
      expect(back, track.id).toBeDefined()
      expect(Buffer.from(back!.bytes).equals(backCover), track.id).toBe(true)
    }
  }, 120_000)

  it('clears only the front cover and leaves the back cover on every typed codec', async () => {
    const typed = manifest.tracks.filter((track) => track.id !== 'aac')
    const backCover = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
      'base64'
    )

    for (const track of typed) {
      embedPictures(track.path, [
        { type: PictureType.FrontCover, bytes: manifest.cover.bytes },
        { type: PictureType.BackCover, bytes: backCover }
      ])

      const outcome = await writeTags(track.path, { ...A_TAGS, artwork: { kind: 'clear' } })
      expect(outcome, track.id).toMatchObject({ ok: true, codec: track.id })

      const pictures = await readEmbeddedArtwork(track.path)
      const front = pictures.find((p) => (p.type ?? '').toLowerCase().includes('front'))
      const back = pictures.find((p) => (p.type ?? '').toLowerCase().includes('back'))
      expect(front, track.id).toBeUndefined()
      expect(back, track.id).toBeDefined()
      expect(Buffer.from(back!.bytes).equals(backCover), track.id).toBe(true)
    }
  }, 120_000)

  it('sets and clears the sole front cover on every codec including AAC', async () => {
    const newCover = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64'
    )

    for (const track of manifest.tracks) {
      const setOutcome = await writeTags(track.path, {
        ...A_TAGS,
        artwork: { kind: 'set', bytes: newCover, mime: 'image/png' }
      })
      expect(setOutcome, track.id).toMatchObject({ ok: true, codec: track.id })
      const afterSet = await readEmbeddedArtwork(track.path)
      const front =
        afterSet.find((p) => (p.type ?? '').toLowerCase().includes('front')) ??
        (afterSet.length === 1 ? afterSet[0] : undefined)
      expect(front, track.id).toBeDefined()
      expect(artworkHash(front!.bytes), track.id).toBe(artworkHash(newCover))

      const clearOutcome = await writeTags(track.path, { ...A_TAGS, artwork: { kind: 'clear' } })
      expect(clearOutcome, track.id).toMatchObject({ ok: true, codec: track.id })
      const afterClear = await readEmbeddedArtwork(track.path)
      const stillFront =
        afterClear.find((p) => (p.type ?? '').toLowerCase().includes('front')) ??
        (afterClear.length === 1 && (afterClear[0].type ?? '') === '' ? afterClear[0] : undefined)
      expect(stillFront, track.id).toBeUndefined()
    }
  }, 120_000)
})

function embedPictures(
  absPath: string,
  frames: Array<{ type: PictureType; bytes: Uint8Array }>
): void {
  const file = TagFile.createFromPath(absPath)
  try {
    file.tag.pictures = frames.map((frame) =>
      Picture.fromFullData(
        ByteVector.fromByteArray(frame.bytes),
        frame.type,
        'image/png',
        frame.type === PictureType.FrontCover ? 'cover' : 'back'
      )
    )
    file.save()
  } finally {
    file.dispose()
  }
}
