import { describe, expect, it } from 'vitest'
import type { GenreValue } from '@shared/tagWriteback'
import type { TrackTags } from '../../../src/main/library/metadata'
import { computePendingWrite, NO_OVERRIDE } from '../../../src/main/library/writeback/diff'
import { makeCanonicalizer, type GenreAlias } from '../../../src/main/genre/canonicalize'

/**
 * The genre canonicalization engine — W16-5.
 *
 * The pure suite drives {@link makeCanonicalizer} against synthesised rule sets:
 * it owns every claim about the fold — collapsing variants, chains, cycles, and
 * the canonical spelling winning. The flow suite proves the one thing the card's
 * acceptance names: a real canonicalizer, passed to the W16-1 merge, turns an
 * aliased file genre into a pending genre write. The DB-backed store is its own
 * suite (`aliasStore.test.ts`).
 */

function alias(aliasKey: string, canonicalKey: string, canonicalLabel: string): GenreAlias {
  return { aliasKey, canonicalKey, canonicalLabel }
}

function gv(key: string, label: string): GenreValue {
  return { key, label }
}

describe('makeCanonicalizer — the fold', () => {
  it('passes the set through untouched when there are no rules', () => {
    const canon = makeCanonicalizer([])
    const set = [gv('rock', 'Rock'), gv('rap', 'Rap')]

    expect(canon(set)).toBe(set)
  })

  it('leaves genres no rule touches unchanged', () => {
    const canon = makeCanonicalizer([alias('rap', 'hip-hop', 'Hip-Hop')])

    expect(canon([gv('rock', 'Rock'), gv('jazz', 'Jazz')])).toEqual([
      gv('rock', 'Rock'),
      gv('jazz', 'Jazz')
    ])
  })

  it('folds a variant onto the canonical key and spelling', () => {
    const canon = makeCanonicalizer([alias('hiphop', 'hip-hop', 'Hip-Hop')])

    expect(canon([gv('hiphop', 'hiphop')])).toEqual([gv('hip-hop', 'Hip-Hop')])
  })

  it('collapses several variants of one idea into a single genre, canonical spelling', () => {
    const canon = makeCanonicalizer([
      alias('hiphop', 'hip-hop', 'Hip-Hop'),
      alias('rap', 'hip-hop', 'Hip-Hop')
    ])

    expect(canon([gv('hiphop', 'hiphop'), gv('rap', 'Rap')])).toEqual([gv('hip-hop', 'Hip-Hop')])
  })

  it('re-spells a genre already on the canonical key inconsistently', () => {
    // `hip-hop` is a canonical target (via the rap rule) but arrives spelled
    // lower-case; canonicalizing is what makes the whole library read one spelling.
    const canon = makeCanonicalizer([alias('rap', 'hip-hop', 'Hip-Hop')])

    expect(canon([gv('hip-hop', 'hip-hop')])).toEqual([gv('hip-hop', 'Hip-Hop')])
  })

  it('preserves first-occurrence order across a collapse', () => {
    const canon = makeCanonicalizer([alias('rap', 'hip-hop', 'Hip-Hop')])

    expect(canon([gv('rock', 'Rock'), gv('rap', 'Rap'), gv('jazz', 'Jazz')])).toEqual([
      gv('rock', 'Rock'),
      gv('hip-hop', 'Hip-Hop'),
      gv('jazz', 'Jazz')
    ])
  })

  it('resolves a chain fully to its endpoint', () => {
    // metal → heavy metal → thrash: `metal` lands on the end of the chain, not one
    // hop along it, so a rule set that renames a canonical still converges.
    const canon = makeCanonicalizer([
      alias('metal', 'heavy metal', 'Heavy Metal'),
      alias('heavy metal', 'thrash', 'Thrash')
    ])

    expect(canon([gv('metal', 'Metal')])).toEqual([gv('thrash', 'Thrash')])
  })

  it('does not hang on a cyclic rule set', () => {
    // Mutual aliases are operator error; the guard's only contract is that the
    // fold terminates and stays deterministic rather than looping.
    const canon = makeCanonicalizer([alias('a', 'b', 'B'), alias('b', 'a', 'A')])

    const out = canon([gv('a', 'A'), gv('b', 'B')])
    expect(out).toHaveLength(2)
    expect(out.map((v) => v.key).sort()).toEqual(['a', 'b'])
  })
})

/** A fully-populated file's tags with an overridable genre. */
function fileTags(genre: string | null): TrackTags {
  return {
    title: 'A Title',
    artist: 'An Artist',
    album: 'An Album',
    albumArtist: 'An Artist',
    trackNo: 1,
    discNo: null,
    year: 2001,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre,
    replayGain: null
  }
}

describe('canonicalization flows into the W16-1 pending write', () => {
  it('collapses an aliased file genre into a pending genre write', () => {
    const canonicalize = makeCanonicalizer([alias('rap', 'hip-hop', 'Hip-Hop')])

    // The file's `Hip-Hop/Rap` is split into `hip-hop` + `rap` by the diff before
    // the fold, then the `rap` rule collapses the pair onto the single canonical.
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags('Hip-Hop/Rap'),
      override: NO_OVERRIDE,
      userTags: [],
      canonicalize
    })

    expect(pw.genres.current).toEqual([gv('hip-hop', 'Hip-Hop'), gv('rap', 'Rap')])
    expect(pw.genres.proposed).toEqual([gv('hip-hop', 'Hip-Hop')])
    expect(pw.genres.changed).toBe(true)
    expect(pw.hasChanges).toBe(true)
  })

  it('reports no genre change when the file already reads canonical', () => {
    const canonicalize = makeCanonicalizer([alias('rap', 'hip-hop', 'Hip-Hop')])

    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags('Hip-Hop'),
      override: NO_OVERRIDE,
      userTags: [],
      canonicalize
    })

    expect(pw.genres.proposed).toEqual([gv('hip-hop', 'Hip-Hop')])
    expect(pw.genres.changed).toBe(false)
  })
})
