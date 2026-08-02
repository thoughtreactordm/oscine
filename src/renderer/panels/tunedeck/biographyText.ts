/**
 * How much of a biography to show before the operator asks for the rest.
 *
 * A pure module rather than logic in the pane, for `tunedeckPanes.ts`' reason:
 * the interesting cases here are all strings, and a test that has to mount a
 * component to find out where a paragraph was cut is a test about Vue.
 *
 * ## Why a character budget and not a line clamp
 *
 * `line-clamp-4` would be one CSS class and no code at all, and it was the first
 * thing tried. Two things ruled it out. A clamped element has no way to say
 * whether it clamped anything, so the expand control either appears on a
 * two-line biography where it does nothing, or does not appear on the one that
 * needed it. And the deck is resizable between 280 and 640 pixels, so the amount
 * of text behind "Show more" would change as the operator dragged the handle —
 * which is fine for a paragraph of body copy and odd for a control whose whole
 * job is to say there is more.
 *
 * Cutting on a measured budget means the pane knows, before it renders, whether
 * there is a second half.
 */

/**
 * Roughly the first two paragraphs of a lead section.
 *
 * Measured against the deck at its default 380px: 420 characters is five or six
 * lines, which is enough to establish who an artist is — the country, the years,
 * the genre, the one album everyone knows — and short enough that the catalog
 * group below it is still on screen. The rest of a Wikipedia lead is usually
 * chart positions and lineup changes, which is reading rather than orientation.
 */
export const BIOGRAPHY_PREVIEW_CHARS = 420

/**
 * Past the budget, how far to look for a sentence to end on.
 *
 * Cutting at exactly 420 characters lands mid-word about nineteen times in
 * twenty. Overshooting to the next sentence boundary gives a preview that reads
 * as a paragraph someone wrote rather than as a string someone sliced, and 120
 * characters is about one long sentence — far enough to find a full stop,
 * near enough that a run-on sentence does not drag half the article into the
 * preview.
 */
export const BIOGRAPHY_PREVIEW_OVERSHOOT = 120

/**
 * A sentence-ending mark followed by whitespace. `.` alone would cut "St. Louis"
 * and "R.E.M.". Built per call rather than shared, because a `g` regex carries
 * `lastIndex` and a module-level one would make two previews in the same tick
 * depend on each other.
 */
function sentenceEnds(): RegExp {
  return /[.!?]["'”’)]?\s/g
}

export interface BiographyPreview {
  /** What to show when collapsed. The whole text when it is short enough. */
  text: string
  /** Whether anything was left out — the expand control's only reason to exist. */
  truncated: boolean
}

/**
 * The collapsed form of a biography.
 *
 * Boundaries are tried in descending order of how well they read: a sentence
 * end, then a paragraph break, then a word break, then the budget itself. The
 * last is unreachable for prose and reachable for a language that does not
 * space its words, which is the case the fallback exists for — a Japanese
 * article should still be cut somewhere rather than shown whole.
 *
 * No ellipsis is appended. The pane draws the expand control immediately after
 * the text, and a "…" in front of a "Show more" is the same sentence twice.
 */
export function previewBiography(
  extract: string,
  limit = BIOGRAPHY_PREVIEW_CHARS,
  overshoot = BIOGRAPHY_PREVIEW_OVERSHOOT
): BiographyPreview {
  const text = extract.trim()
  if (text.length <= limit) return { text, truncated: false }

  const head = text.slice(0, limit + overshoot)

  // The last sentence that ends inside the window, so long as it is not so
  // early that the preview becomes a single clause. Half the budget is the
  // floor: a lead beginning "Nirvana was an American rock band." would
  // otherwise preview as that one line with five paragraphs behind a button.
  const boundary = sentenceEnds()
  let sentence = -1
  for (let match = boundary.exec(head); match !== null; match = boundary.exec(head)) {
    sentence = match.index + match[0].length
  }
  if (sentence >= limit / 2) return { text: text.slice(0, sentence).trim(), truncated: true }

  const paragraph = head.lastIndexOf('\n')
  if (paragraph >= limit / 2) return { text: text.slice(0, paragraph).trim(), truncated: true }

  const word = text.slice(0, limit).lastIndexOf(' ')
  if (word >= limit / 2) return { text: text.slice(0, word).trim(), truncated: true }

  return { text: text.slice(0, limit).trim(), truncated: true }
}

/**
 * The extract split into paragraphs, for rendering.
 *
 * Any run of newlines, not a blank line. `TextExtracts` separates paragraphs
 * with a *single* `\n` under `explaintext` and reserves the longer runs for
 * section breaks — verified against `en.wikipedia.org` rather than assumed,
 * because the assumption that a paragraph break is `\n\n` renders the whole of
 * a four-paragraph lead as one unbroken block. HTML collapses the newlines, so
 * the failure is silent and looks like a styling problem.
 *
 * The pane draws one `<p>` per entry rather than relying on
 * `whitespace-pre-line`, so paragraph spacing comes from the type scale like
 * every other block of text in the app instead of from a line-height.
 */
export function biographyParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
}
