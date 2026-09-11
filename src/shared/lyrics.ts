/**
 * The lyrics contract: the cross-process shapes every W17 card imports, and a
 * pure, dependency-free LRC parser.
 *
 * This lives in `src/shared` because both sides need it (the `src/shared`
 * convention): main parses `.lrc` sidecars and network payloads, the renderer
 * needs the line shape to render and highlight. It is deliberately pure — a
 * function over string input — because LRC has as many real-world dialects as
 * any format on disk, and the failure mode a shared, tested parser prevents is
 * the expensive one: a parser that quietly mistimes a dialect scrolls lyrics
 * *almost* right, which reads as "the feature is broken" rather than "this file
 * is unusual". Get the dialects right once, here, and the three delivery paths
 * (sidecar, embedded, lrclib) cannot drift.
 *
 * No file I/O, no network, no Vue, no playback logic. W17-3 owns which line is
 * current; this module only turns text into a sorted document.
 */

/**
 * One timed word inside a line — enhanced-LRC only, absent in the common case.
 *
 * `timeMs` is absolute (from the start of the track), the same clock as
 * {@link LyricsLine.timeMs}, so a karaoke highlighter never has to add the line
 * time back in.
 */
export interface LyricsWord {
  readonly timeMs: number
  readonly text: string
}

/**
 * One line of lyrics.
 *
 * `timeMs === null` is an *untimed* line, which is how a plain-lyrics document
 * is represented without a second type: a file with no timestamps parses to a
 * list of untimed lines and a {@link LyricsDocument.synced} of `false`. A timed
 * line carries milliseconds from the start of the track.
 *
 * `words` is present only for enhanced LRC (`<mm:ss.xx>` inline tags). The
 * angle-bracket tags are always stripped from `text` whether or not `words` is
 * populated, so a file carrying them never renders raw brackets.
 */
export interface LyricsLine {
  readonly timeMs: number | null
  readonly text: string
  readonly words?: LyricsWord[]
}

/**
 * Where a document came from. Provenance travels with the document so W17-3 can
 * attribute it and W17-5 can decide what a manual override replaces.
 */
export type LyricsSource = 'sidecar' | 'embedded' | 'lrclib'

/**
 * A parsed lyrics document.
 *
 * `synced` is *derived* — it is `true` when any line carries a timestamp — not
 * asserted by the caller, so it cannot disagree with `lines`.
 *
 * `offsetMs` is the header `[offset:]` value, verbatim with its sign. See
 * {@link parseLrc} for the sign convention; the important thing is that this
 * module captures it and does not apply it — the timing layer (W17-3) does.
 *
 * `title`/`artist`/`album` come from the `[ti:]`/`[ar:]`/`[al:]` ID tags when
 * present. `length` is the raw `[length:]` string (e.g. `"3:43"`), kept as
 * authored rather than parsed to ms, because nothing in the stream needs it as
 * a number and re-serialising it would lose the original form.
 */
export interface LyricsDocument {
  readonly lines: LyricsLine[]
  readonly synced: boolean
  readonly offsetMs: number
  readonly source: LyricsSource
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly length?: string
}

/**
 * A leading line timestamp: `[mm:ss]`, `[mm:ss.xx]` (centiseconds) or
 * `[mm:ss.xxx]` (milliseconds). Anchored to the start of what remains so we can
 * pull repeated tags off one at a time (`[00:12.00][01:45.30] chorus`).
 */
const LINE_TIME_RE = /^\s*\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/

/** An inline enhanced-LRC word timestamp, `<mm:ss.xx>`. Global: scanned across a line. */
const WORD_TIME_RE = /<(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?>/g

/**
 * A whole-line ID tag: `[ti:...]`, `[ar:...]`, `[offset:...]`, etc. The key must
 * start with a letter, which is exactly what separates it from a `[mm:ss]`
 * timestamp (numeric key) without a second pass. Anchored end-to-end so a line
 * that merely *begins* with a bracket tag is not mistaken for one.
 */
const ID_TAG_RE = /^\s*\[([a-zA-Z][a-zA-Z0-9]*):([^\]]*)\]\s*$/

/**
 * Resolve a timestamp's fractional part **by digit count, not by guessing**.
 * Centisecond vs millisecond is ambiguous by value but unambiguous by length:
 * two digits are centiseconds, three are milliseconds, one is tenths. This is
 * the detail that, gotten wrong, mistimes a whole dialect by up to a second.
 */
function timestampToMs(min: string, sec: string, frac: string | undefined): number {
  let ms = (Number(min) * 60 + Number(sec)) * 1000
  if (frac !== undefined && frac.length > 0) {
    const value = Number(frac)
    if (frac.length === 1) ms += value * 100
    else if (frac.length === 2) ms += value * 10
    else ms += value
  }
  return ms
}

/**
 * Split a line's text on enhanced-LRC word tags. Returns the plain `text` with
 * every `<mm:ss.xx>` removed, plus a `words` list pairing each tag with the run
 * of text that follows it. Any text *before* the first word tag is a lead-in: it
 * joins `text` but is not a word, because it has no time of its own.
 */
function parseWords(input: string): { text: string; words: LyricsWord[] } {
  const words: LyricsWord[] = []
  let text = ''
  let cursor = 0
  let pendingTime: number | null = null
  WORD_TIME_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WORD_TIME_RE.exec(input)) !== null) {
    const between = input.slice(cursor, match.index)
    text += between
    if (pendingTime !== null) words.push({ timeMs: pendingTime, text: between })
    pendingTime = timestampToMs(match[1]!, match[2]!, match[3])
    cursor = WORD_TIME_RE.lastIndex
  }
  const tail = input.slice(cursor)
  text += tail
  if (pendingTime !== null) words.push({ timeMs: pendingTime, text: tail })
  return { text: text.trim(), words }
}

/**
 * Cheap sniff: does this text contain at least one `[mm:ss]` timestamp? W17-2
 * uses it to decide whether an embedded lyrics frame is LRC or plain text
 * without paying for a full parse. Deliberately narrow — a `[length:3:43]` ID
 * tag is not a timestamp because its bracket is not followed by digits.
 */
export function isSyncedLyricsText(raw: string): boolean {
  if (typeof raw !== 'string') return false
  return /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/.test(raw)
}

/**
 * Parse LRC (and plain lyrics) into a {@link LyricsDocument}.
 *
 * ## Never throws
 *
 * The worst case is a `synced: false` document. An unparseable file — junk, a
 * binary blob handed in by mistake, an empty string — must degrade to plain
 * text, never take out the pane. Malformed lines become untimed text lines
 * rather than errors.
 *
 * ## Dialects handled
 *
 * - `[mm:ss]`, `[mm:ss.xx]` (centiseconds) and `[mm:ss.xxx]` (milliseconds),
 *   disambiguated by digit count (see {@link timestampToMs}).
 * - **Multiple timestamps on one line** (`[00:12.00][01:45.30] chorus`), a
 *   repeated chorus, expanded to N lines that share the text.
 * - Enhanced-LRC inline word tags `<mm:ss.xx>`, parsed into `words` and always
 *   stripped from `text`.
 * - ID tags `[ti:]`/`[ar:]`/`[al:]`/`[length:]`/`[by:]`/… — captured where the
 *   document has a field for them, never rendered as a lyric line.
 * - BOM, CRLF/CR, blank lines, and a file with no timestamps at all.
 *
 * ## Offset sign convention
 *
 * `[offset:+N]` shifts the lyrics **earlier** by N milliseconds (they appear
 * sooner); `[offset:-N]` shifts them later. This is the single most-often-
 * inverted detail in LRC implementations, so it is stated here and tested. We
 * store the value verbatim in `offsetMs` **with its sign** and do not apply it:
 * a consumer computes a line's effective display time as `line.timeMs -
 * offsetMs`, so a positive offset subtracts and the line lands earlier.
 *
 * ## Ordering
 *
 * Lines are sorted by `timeMs` ascending and the sort is stable, so lines that
 * share a timestamp — and the copies a multi-timestamp line expands to — keep
 * their document order. Untimed lines (a plain file) sort after timed ones and,
 * being all equal, keep their original order.
 *
 * @param raw the file (or frame) contents
 * @param source provenance recorded on the document; the parser cannot know it
 *   from the text, so the caller states it. Defaults to `'sidecar'`.
 */
export function parseLrc(raw: string, source: LyricsSource = 'sidecar'): LyricsDocument {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { lines: [], synced: false, offsetMs: 0, source }
  }

  // Strip a leading BOM before splitting so it cannot cling to the first tag.
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  const lines: LyricsLine[] = []
  let offsetMs = 0
  let title: string | undefined
  let artist: string | undefined
  let album: string | undefined
  let length: string | undefined

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    if (rawLine.trim() === '') continue

    const idTag = ID_TAG_RE.exec(rawLine)
    if (idTag) {
      const key = idTag[1]!.toLowerCase()
      const value = idTag[2]!.trim()
      if (key === 'offset') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) offsetMs = parsed
      } else if (key === 'ti') title = value
      else if (key === 'ar') artist = value
      else if (key === 'al') album = value
      else if (key === 'length') length = value
      // Any other alpha-keyed tag ([by:], [re:], [ve:], …) is metadata we don't
      // carry, but it is still swallowed here so it never renders as a lyric.
      continue
    }

    // Pull every leading timestamp off the front; the remainder is the text
    // (which may still hold enhanced-LRC word tags).
    const times: number[] = []
    let rest = rawLine
    let timeTag: RegExpExecArray | null
    while ((timeTag = LINE_TIME_RE.exec(rest)) !== null) {
      times.push(timestampToMs(timeTag[1]!, timeTag[2]!, timeTag[3]))
      rest = rest.slice(timeTag[0].length)
    }

    const { text, words } = parseWords(rest)

    if (times.length === 0) {
      // No line timestamp. An enhanced line without one still has a time (its
      // first word); anything else is an untimed / plain-text line.
      if (words.length > 0) lines.push({ timeMs: words[0]!.timeMs, text, words })
      else lines.push({ timeMs: null, text })
      continue
    }

    for (const timeMs of times) {
      // Word timings belong to a single occurrence, so they ride along only when
      // the line is not a repeated chorus — duplicating them across timestamps
      // would assert word times the file never made.
      if (times.length === 1 && words.length > 0) lines.push({ timeMs, text, words })
      else lines.push({ timeMs, text })
    }
  }

  lines.sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity))

  const synced = lines.some((line) => line.timeMs !== null)

  return {
    lines,
    synced,
    offsetMs,
    source,
    ...(title !== undefined ? { title } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(length !== undefined ? { length } : {})
  }
}
