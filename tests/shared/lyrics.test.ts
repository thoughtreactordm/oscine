import { describe, expect, it } from 'vitest'
import { isSyncedLyricsText, parseLrc, type LyricsDocument } from '@shared/lyrics'

/** Times of the synced lines, in document order after the parser's sort. */
function times(doc: LyricsDocument): (number | null)[] {
  return doc.lines.map((line) => line.timeMs)
}

describe('parseLrc — timestamp precision', () => {
  it('reads [mm:ss] with no fraction as whole seconds', () => {
    const doc = parseLrc('[01:02] plain seconds')
    expect(doc.lines[0]!.timeMs).toBe(62_000)
  })

  it('resolves centiseconds vs milliseconds by digit count, not value', () => {
    // "50" is centiseconds → 500ms; "50" as ms would be 50ms. The only signal
    // is the digit count, and the parser must not guess.
    const centi = parseLrc('[00:01.50] centi')
    const milli = parseLrc('[00:01.500] milli')
    expect(centi.lines[0]!.timeMs).toBe(1_500)
    expect(milli.lines[0]!.timeMs).toBe(1_500)

    // Distinct values that would collide if the wrong scale were applied.
    expect(parseLrc('[00:00.05] a').lines[0]!.timeMs).toBe(50)
    expect(parseLrc('[00:00.005] b').lines[0]!.timeMs).toBe(5)
  })

  it('reads a single fractional digit as tenths', () => {
    expect(parseLrc('[00:00.5] tenths').lines[0]!.timeMs).toBe(500)
  })
})

describe('parseLrc — multiple timestamps on one line', () => {
  it('expands a repeated chorus to one line per timestamp', () => {
    const doc = parseLrc('[00:12.00][01:45.30] chorus text')
    expect(doc.lines).toHaveLength(2)
    expect(doc.lines.every((line) => line.text === 'chorus text')).toBe(true)
    expect(times(doc)).toEqual([12_000, 105_300])
  })

  it('sorts the expanded copies into the rest of the document by time', () => {
    const doc = parseLrc(['[00:30.00] verse two', '[00:10.00][00:50.00] chorus'].join('\n'))
    expect(times(doc)).toEqual([10_000, 30_000, 50_000])
    expect(doc.lines[0]!.text).toBe('chorus')
    expect(doc.lines[1]!.text).toBe('verse two')
    expect(doc.lines[2]!.text).toBe('chorus')
  })
})

describe('parseLrc — offset sign convention', () => {
  it('captures a positive offset verbatim (shifts lyrics earlier)', () => {
    // Convention: [offset:+N] shifts lyrics earlier; effective time is
    // timeMs - offsetMs. The parser stores the value, sign intact, and does not
    // apply it — so the stored line time is untouched and offsetMs is +500.
    const doc = parseLrc('[offset:+500]\n[00:10.00] line')
    expect(doc.offsetMs).toBe(500)
    expect(doc.lines[0]!.timeMs).toBe(10_000)
  })

  it('captures a negative offset with its sign', () => {
    const doc = parseLrc('[offset:-750]\n[00:10.00] line')
    expect(doc.offsetMs).toBe(-750)
  })

  it('defaults offsetMs to 0 when no offset tag is present', () => {
    expect(parseLrc('[00:00.00] line').offsetMs).toBe(0)
  })
})

describe('parseLrc — ID tags', () => {
  it('captures ti/ar/al/length and never renders them as lyrics', () => {
    const doc = parseLrc(
      [
        '[ti:The Song]',
        '[ar:The Artist]',
        '[al:The Album]',
        '[by:some transcriber]',
        '[length:3:43]',
        '[00:00.00] first line'
      ].join('\n')
    )
    expect(doc.title).toBe('The Song')
    expect(doc.artist).toBe('The Artist')
    expect(doc.album).toBe('The Album')
    expect(doc.length).toBe('3:43')
    expect(doc.lines).toHaveLength(1)
    expect(doc.lines[0]!.text).toBe('first line')
  })

  it('omits metadata fields that were not present', () => {
    const doc = parseLrc('[00:00.00] line')
    expect(doc.title).toBeUndefined()
    expect(doc.artist).toBeUndefined()
    expect(doc.album).toBeUndefined()
    expect(doc.length).toBeUndefined()
  })
})

describe('parseLrc — enhanced LRC word tags', () => {
  it('parses inline word timings and strips the tags from text', () => {
    const doc = parseLrc('[00:12.00] <00:12.00>Hello <00:12.50>world')
    const line = doc.lines[0]!
    expect(line.text).toBe('Hello world')
    expect(line.words).toEqual([
      { timeMs: 12_000, text: 'Hello ' },
      { timeMs: 12_500, text: 'world' }
    ])
  })

  it('uses the first word time when there is no line timestamp', () => {
    const doc = parseLrc('<00:05.00>lead <00:05.30>in')
    expect(doc.lines[0]!.timeMs).toBe(5_000)
    expect(doc.lines[0]!.text).toBe('lead in')
  })

  it('strips word tags even from a repeated chorus, without asserting per-copy word times', () => {
    const doc = parseLrc('[00:10.00][00:20.00] <00:10.00>hey <00:10.50>now')
    expect(doc.lines).toHaveLength(2)
    expect(doc.lines.every((line) => line.text === 'hey now')).toBe(true)
    // Word times can only be right for one occurrence, so neither copy carries them.
    expect(doc.lines.every((line) => line.words === undefined)).toBe(true)
  })
})

describe('parseLrc — degrades instead of throwing', () => {
  it('returns a synced:false document for a plain-text file', () => {
    const doc = parseLrc('just some\nplain lyrics\nno timing here')
    expect(doc.synced).toBe(false)
    expect(times(doc)).toEqual([null, null, null])
    expect(doc.lines.map((l) => l.text)).toEqual(['just some', 'plain lyrics', 'no timing here'])
  })

  it('returns an empty synced:false document for an empty string', () => {
    const doc = parseLrc('')
    expect(doc).toEqual({ lines: [], synced: false, offsetMs: 0, source: 'sidecar' })
  })

  it('does not throw on a binary blob', () => {
    const blob = String.fromCharCode(0, 1, 2, 255, 254, 128, 10, 66, 66, 10, 0, 3)
    expect(() => parseLrc(blob)).not.toThrow()
    expect(parseLrc(blob).synced).toBe(false)
  })

  it('does not throw on non-string input', () => {
    // The signature is `string`, but a mis-typed caller must not take out the pane.
    expect(() => parseLrc(undefined as unknown as string)).not.toThrow()
    expect(parseLrc(null as unknown as string).lines).toEqual([])
  })

  it('keeps malformed lines as untimed text rather than dropping the file', () => {
    const doc = parseLrc('[00:01.00] good line\n[garbage without close\n[01:00] later')
    expect(doc.synced).toBe(true)
    const junk = doc.lines.find((l) => l.text.includes('garbage'))
    expect(junk).toBeDefined()
    expect(junk!.timeMs).toBeNull()
  })
})

describe('parseLrc — whitespace, BOM and line endings', () => {
  it('strips a leading BOM so it does not cling to the first tag', () => {
    const doc = parseLrc('﻿[00:00.00] first')
    expect(doc.lines).toHaveLength(1)
    expect(doc.lines[0]!.timeMs).toBe(0)
    expect(doc.lines[0]!.text).toBe('first')
  })

  it('handles CRLF and lone CR line endings', () => {
    const doc = parseLrc('[00:00.00] a\r\n[00:01.00] b\r[00:02.00] c')
    expect(times(doc)).toEqual([0, 1_000, 2_000])
  })

  it('skips blank lines', () => {
    const doc = parseLrc('[00:00.00] a\n\n   \n[00:01.00] b')
    expect(doc.lines).toHaveLength(2)
  })

  it('trims surrounding whitespace from the lyric text', () => {
    expect(parseLrc('[00:00.00]    spaced out   ').lines[0]!.text).toBe('spaced out')
  })
})

describe('parseLrc — document shape', () => {
  it('derives synced from the lines rather than trusting the caller', () => {
    expect(parseLrc('[00:00.00] a').synced).toBe(true)
    expect(parseLrc('a\nb').synced).toBe(false)
  })

  it('records the provenance the caller states', () => {
    expect(parseLrc('[00:00.00] a').source).toBe('sidecar')
    expect(parseLrc('[00:00.00] a', 'embedded').source).toBe('embedded')
    expect(parseLrc('[00:00.00] a', 'lrclib').source).toBe('lrclib')
  })
})

describe('isSyncedLyricsText', () => {
  it('is true when a timestamp is present', () => {
    expect(isSyncedLyricsText('[00:12.00] a line')).toBe(true)
    expect(isSyncedLyricsText('some text\n[01:02] mid-file')).toBe(true)
  })

  it('is false for plain text and for a length ID tag alone', () => {
    expect(isSyncedLyricsText('just plain lyrics')).toBe(false)
    expect(isSyncedLyricsText('[length:3:43]\nplain lyrics')).toBe(false)
    expect(isSyncedLyricsText('')).toBe(false)
    expect(isSyncedLyricsText(undefined as unknown as string)).toBe(false)
  })
})
