import { describe, expect, it } from 'vitest'
import {
  BIOGRAPHY_PREVIEW_CHARS,
  BIOGRAPHY_PREVIEW_OVERSHOOT,
  biographyParagraphs,
  previewBiography
} from '../../../src/renderer/panels/tunedeck/biographyText'

/**
 * Where a biography gets cut, and whether the pane can tell that it was.
 *
 * The second half of that sentence is the one worth testing. `truncated` is the
 * only reason the expand control exists, and a `line-clamp` — the thing this
 * module replaced — cannot report it at all: the control would either appear on
 * a two-line biography where it does nothing, or be missing from the one that
 * needed it.
 */

/** Sentences of a known length, so the boundary cases are arithmetic. */
function sentences(count: number, word = 'word'): string {
  return Array.from({ length: count }, (_, index) => `${word} ${index} is here.`).join(' ')
}

describe('biography preview', () => {
  it('leaves a short biography whole and offers no expand', () => {
    const short = 'An American rock band formed in Aberdeen, Washington, in 1987.'
    expect(previewBiography(short)).toEqual({ text: short, truncated: false })
  })

  it('cuts on a sentence boundary and says that it did', () => {
    const long = sentences(60)
    const preview = previewBiography(long)

    expect(preview.truncated).toBe(true)
    expect(preview.text.endsWith('.')).toBe(true)
    expect(long.startsWith(preview.text)).toBe(true)
    expect(preview.text.length).toBeLessThanOrEqual(
      BIOGRAPHY_PREVIEW_CHARS + BIOGRAPHY_PREVIEW_OVERSHOOT
    )
  })

  it('does not treat a full stop inside a number as a sentence end', () => {
    // Why the boundary is a mark *plus whitespace* rather than a full stop:
    // "10.5 million" and "R.E.M." would otherwise both be cut through the
    // middle. No boundary exists in this window at all, so it also exercises
    // the word-break fallback.
    expect(previewBiography('Sold 10.5 million copies and toured. More.', 20, 10).text).toBe(
      'Sold 10.5 million'
    )
  })

  it('does not preview a lead as its own first clause', () => {
    // A biography opening "Nirvana was an American rock band." would otherwise
    // show that one line with five paragraphs behind a button.
    const preview = previewBiography(`Nirvana was a band. ${sentences(60)}`)
    expect(preview.text.length).toBeGreaterThan(BIOGRAPHY_PREVIEW_CHARS / 2)
  })

  it('falls back to a paragraph break, then a word break', () => {
    const paragraph = `${'a'.repeat(300)}\n${'b'.repeat(400)}`
    expect(previewBiography(paragraph).text).toBe('a'.repeat(300))

    const words = `${'c'.repeat(300)} ${'d'.repeat(400)}`
    expect(previewBiography(words).text).toBe('c'.repeat(300))
  })

  it('still cuts a language that does not space its words', () => {
    // The last fallback. Showing the whole article because no boundary was
    // found would make the expand control meaningless for Japanese.
    const unspaced = 'あ'.repeat(1000)
    const preview = previewBiography(unspaced)
    expect(preview.truncated).toBe(true)
    expect(preview.text).toHaveLength(BIOGRAPHY_PREVIEW_CHARS)
  })

  it('never reports truncation it did not do', () => {
    const exact = 'x'.repeat(BIOGRAPHY_PREVIEW_CHARS)
    expect(previewBiography(exact)).toEqual({ text: exact, truncated: false })
  })
})

describe('biography paragraphs', () => {
  it('splits on a single newline, which is what the endpoint sends', () => {
    // Checked against a live `explaintext` reply. Splitting on `\n\n` instead
    // renders a four-paragraph lead as one block, and because HTML collapses
    // the newlines it fails silently and reads as a styling bug.
    expect(biographyParagraphs('One.\nTwo.\n\nThree.')).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('is empty for nothing', () => {
    expect(biographyParagraphs('   ')).toEqual([])
  })
})
