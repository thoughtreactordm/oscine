import { describe, expect, it } from 'vitest'
import {
  ByteVector,
  Picture,
  PictureType,
  type File as TagFile,
  type IPicture
} from 'node-taglib-sharp'
import type { GenreValue, PendingWrite } from '@shared/tagWriteback'
import {
  applyWritableTags,
  ARTWORK_UNCHANGED,
  resolveArtworkIntent,
  resolveCodecWriter,
  writableTagsFromPending,
  writtenGenreValue,
  type WritableTags
} from '../../../../src/main/library/writeback/writer'

/**
 * The per-codec tag writer — W16-3, design authority D28.
 *
 * These are the CI-safe half of the engine's coverage: the in-set gate, the
 * genre-join convention, the diff→engine bridge and the field mapping, none of
 * which needs a real audio file or the native container. The atomic IO and the
 * real five-codec round-trip live in `engine.test.ts`.
 */

const AMBIENT: GenreValue = { key: 'ambient', label: 'Ambient' }
const ELECTRONIC: GenreValue = { key: 'electronic', label: 'Electronic' }

const SCALARS = {
  title: 'T' as string | null,
  artist: 'A' as string | null,
  album: 'Al' as string | null,
  trackNo: 1 as number | null,
  discNo: 1 as number | null,
  year: 2000 as number | null,
  genres: [AMBIENT] as readonly GenreValue[]
}

describe('resolveCodecWriter — the in-set gate', () => {
  it('resolves each v1 codec to its tag family', () => {
    expect(resolveCodecWriter('/m/a.flac')).toEqual({ codec: 'flac', tagFamily: 'vorbis' })
    expect(resolveCodecWriter('/m/a.mp3')).toEqual({ codec: 'mp3', tagFamily: 'id3v2' })
    expect(resolveCodecWriter('/m/a.ogg')).toEqual({ codec: 'vorbis', tagFamily: 'vorbis' })
    expect(resolveCodecWriter('/m/a.oga')).toEqual({ codec: 'vorbis', tagFamily: 'vorbis' })
    expect(resolveCodecWriter('/m/a.opus')).toEqual({ codec: 'opus', tagFamily: 'vorbis' })
    expect(resolveCodecWriter('/m/a.m4a')).toEqual({ codec: 'aac', tagFamily: 'mp4' })
    expect(resolveCodecWriter('/m/a.mp4')).toEqual({ codec: 'aac', tagFamily: 'mp4' })
  })

  it('is case-insensitive on the extension', () => {
    expect(resolveCodecWriter('/m/A.FLAC')?.codec).toBe('flac')
    expect(resolveCodecWriter('/m/A.Mp3')?.codec).toBe('mp3')
  })

  it('refuses out-of-set formats explicitly', () => {
    for (const path of ['/m/a.wav', '/m/a.aiff', '/m/a.wma', '/m/a.ape', '/m/a.txt', '/m/noext']) {
      expect(resolveCodecWriter(path)).toBeNull()
    }
  })
})

describe('writtenGenreValue — one delimited string, not one frame per genre', () => {
  it('joins the frame with "; " so a rescan reads back the same set', () => {
    expect(writtenGenreValue([AMBIENT, ELECTRONIC])).toEqual(['Ambient; Electronic'])
  })

  it('keeps a single genre as itself', () => {
    expect(writtenGenreValue([AMBIENT])).toEqual(['Ambient'])
  })

  it('clears with an empty list', () => {
    expect(writtenGenreValue([])).toEqual([])
  })

  it('preserves display spelling and order', () => {
    const frame: GenreValue[] = [
      { key: 'idm', label: 'IDM' },
      { key: 'r&b', label: 'R&B' }
    ]
    expect(writtenGenreValue(frame)).toEqual(['IDM; R&B'])
  })
})

describe('applyWritableTags — sets only the modelled fields', () => {
  function capture(desired: WritableTags): Record<string, unknown> {
    const tag: Record<string, unknown> = {}
    applyWritableTags({ tag } as unknown as TagFile, desired)
    return tag
  }

  it('maps every scalar field and joins genres', () => {
    expect(
      capture({
        title: 'Title',
        artist: 'Artist',
        album: 'Album',
        trackNo: 4,
        discNo: 1,
        year: 2026,
        genres: [AMBIENT, ELECTRONIC],
        artwork: ARTWORK_UNCHANGED
      })
    ).toEqual({
      title: 'Title',
      performers: ['Artist'],
      album: 'Album',
      genres: ['Ambient; Electronic'],
      year: 2026,
      track: 4,
      disc: 1
    })
  })

  it('clears each field a null proposal targets', () => {
    expect(
      capture({
        title: null,
        artist: null,
        album: null,
        trackNo: null,
        discNo: null,
        year: null,
        genres: [],
        artwork: ARTWORK_UNCHANGED
      })
    ).toEqual({
      title: '',
      performers: [],
      album: '',
      genres: [],
      year: 0,
      track: 0,
      disc: 0
    })
  })

  it('never sets an unmodelled field, so artwork and custom frames survive', () => {
    const tag = capture({
      ...SCALARS,
      artwork: ARTWORK_UNCHANGED
    })
    expect(Object.keys(tag).sort()).toEqual(
      ['album', 'disc', 'genres', 'performers', 'title', 'track', 'year'].sort()
    )
    expect(tag).not.toHaveProperty('pictures')
    expect(tag).not.toHaveProperty('albumArtists')
  })
})

describe('writableTagsFromPending — the diff→engine bridge', () => {
  it('takes the proposed side of every field', () => {
    const pending: PendingWrite = {
      trackId: 7,
      title: { current: 'old', proposed: 'new', changed: true },
      artist: { current: 'a', proposed: 'a', changed: false },
      album: { current: null, proposed: 'Album', changed: true },
      trackNo: { current: 2, proposed: 3, changed: true },
      discNo: { current: 1, proposed: null, changed: true },
      year: { current: 1999, proposed: 2026, changed: true },
      genres: {
        current: [AMBIENT],
        proposed: [AMBIENT, ELECTRONIC],
        changed: true
      },
      hasChanges: true
    }
    expect(writableTagsFromPending(pending)).toEqual({
      title: 'new',
      artist: 'a',
      album: 'Album',
      trackNo: 3,
      discNo: null,
      year: 2026,
      genres: [AMBIENT, ELECTRONIC],
      artwork: ARTWORK_UNCHANGED
    })
  })
})

function picture(type: PictureType, payload: string): Picture {
  return Picture.fromFullData(ByteVector.fromByteArray(Buffer.from(payload)), type, 'image/png', '')
}

function payloadOf(pic: IPicture): string {
  return Buffer.from(pic.data.toByteArray()).toString()
}

describe('applyWritableTags — Decision B, replace front, preserve rest', () => {
  function applyTo(existing: IPicture[], artwork: WritableTags['artwork']): IPicture[] {
    const tag: { pictures: IPicture[] } & Record<string, unknown> = { pictures: existing }
    applyWritableTags({ tag } as unknown as TagFile, { ...SCALARS, artwork })
    return tag.pictures
  }

  it('does not assign pictures when the intent is unchanged', () => {
    const front = picture(PictureType.FrontCover, 'front')
    const back = picture(PictureType.BackCover, 'back')
    const existing = [front, back]
    const tag: { pictures: IPicture[] } & Record<string, unknown> = { pictures: existing }
    applyWritableTags({ tag } as unknown as TagFile, { ...SCALARS, artwork: ARTWORK_UNCHANGED })
    expect(tag.pictures).toBe(existing)
    expect(payloadOf(tag.pictures[0])).toBe('front')
    expect(payloadOf(tag.pictures[1])).toBe('back')
  })

  it('replaces only the front cover and leaves the back cover byte-identical', () => {
    const after = applyTo(
      [picture(PictureType.FrontCover, 'old-front'), picture(PictureType.BackCover, 'back')],
      { kind: 'set', bytes: Buffer.from('new-front'), mime: 'image/png' }
    )
    expect(after).toHaveLength(2)
    expect(after[0].type).toBe(PictureType.FrontCover)
    expect(payloadOf(after[0])).toBe('new-front')
    expect(after[1].type).toBe(PictureType.BackCover)
    expect(payloadOf(after[1])).toBe('back')
  })

  it('replaces a sole untyped picture as the de-facto front cover', () => {
    const after = applyTo([picture(PictureType.Other, 'only')], {
      kind: 'set',
      bytes: Buffer.from('new-front'),
      mime: 'image/png'
    })
    expect(after).toHaveLength(1)
    expect(after[0].type).toBe(PictureType.FrontCover)
    expect(payloadOf(after[0])).toBe('new-front')
  })

  it('does not treat a sole back cover as a front cover', () => {
    const after = applyTo([picture(PictureType.BackCover, 'back-only')], {
      kind: 'set',
      bytes: Buffer.from('new-front'),
      mime: 'image/png'
    })
    expect(after).toHaveLength(2)
    expect(after[0].type).toBe(PictureType.FrontCover)
    expect(payloadOf(after[0])).toBe('new-front')
    expect(after[1].type).toBe(PictureType.BackCover)
    expect(payloadOf(after[1])).toBe('back-only')
  })

  it('collapses multiple front covers into one new front and keeps the rest', () => {
    const after = applyTo(
      [
        picture(PictureType.FrontCover, 'front-a'),
        picture(PictureType.FrontCover, 'front-b'),
        picture(PictureType.BackCover, 'back')
      ],
      { kind: 'set', bytes: Buffer.from('new-front'), mime: 'image/png' }
    )
    expect(after.map((pic) => [pic.type, payloadOf(pic)])).toEqual([
      [PictureType.FrontCover, 'new-front'],
      [PictureType.BackCover, 'back']
    ])
  })

  it('adds a front cover when the file has none', () => {
    const after = applyTo([picture(PictureType.Artist, 'artist')], {
      kind: 'set',
      bytes: Buffer.from('new-front'),
      mime: 'image/png'
    })
    expect(after).toHaveLength(2)
    expect(after[0].type).toBe(PictureType.FrontCover)
    expect(payloadOf(after[1])).toBe('artist')
  })

  it('removes only the front cover on clear', () => {
    const after = applyTo(
      [picture(PictureType.FrontCover, 'front'), picture(PictureType.BackCover, 'back')],
      { kind: 'clear' }
    )
    expect(after).toHaveLength(1)
    expect(after[0].type).toBe(PictureType.BackCover)
    expect(payloadOf(after[0])).toBe('back')
  })

  it('clears a sole untyped picture as the de-facto front cover', () => {
    const after = applyTo([picture(PictureType.Other, 'only')], { kind: 'clear' })
    expect(after).toEqual([])
  })

  it('leaves a sole back cover in place on clear', () => {
    const after = applyTo([picture(PictureType.BackCover, 'back-only')], { kind: 'clear' })
    expect(after).toHaveLength(1)
    expect(payloadOf(after[0])).toBe('back-only')
  })
})

describe('resolveArtworkIntent — fresh from the override store', () => {
  const HASH = 'a'.repeat(64)
  const BYTES = Buffer.from('chosen-cover')

  it('is unchanged when there is no override row', async () => {
    expect(
      await resolveArtworkIntent({
        override: null,
        readOriginal: async () => BYTES
      })
    ).toEqual(ARTWORK_UNCHANGED)
  })

  it('is clear when the override row has a null hash', async () => {
    expect(
      await resolveArtworkIntent({
        override: { imageHash: null, mime: null },
        readOriginal: async () => BYTES
      })
    ).toEqual({ kind: 'clear' })
  })

  it('is set with the original bytes when the hash is present', async () => {
    const reads: string[] = []
    expect(
      await resolveArtworkIntent({
        override: { imageHash: HASH, mime: 'image/png' },
        readOriginal: async (hash) => {
          reads.push(hash)
          return BYTES
        }
      })
    ).toEqual({ kind: 'set', bytes: BYTES, mime: 'image/png' })
    expect(reads).toEqual([HASH])
  })

  it('sniffs MIME from the bytes when the row does not carry one', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    expect(
      await resolveArtworkIntent({
        override: { imageHash: HASH, mime: null },
        readOriginal: async () => png
      })
    ).toEqual({ kind: 'set', bytes: png, mime: 'image/png' })
  })

  it('throws when the original is missing rather than skipping the cover', async () => {
    await expect(
      resolveArtworkIntent({
        override: { imageHash: HASH, mime: 'image/png' },
        readOriginal: async () => null
      })
    ).rejects.toThrow(/missing from the override store/)
  })
})
