import { describe, expect, it } from 'vitest'
import type { File as TagFile } from 'node-taglib-sharp'
import type { GenreValue, PendingWrite } from '@shared/tagWriteback'
import {
  applyWritableTags,
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
        genres: [AMBIENT, ELECTRONIC]
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
        genres: []
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
      title: 'T',
      artist: 'A',
      album: 'Al',
      trackNo: 1,
      discNo: 1,
      year: 2000,
      genres: [AMBIENT]
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
      genres: [AMBIENT, ELECTRONIC]
    })
  })
})
