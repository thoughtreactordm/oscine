---
taskId: 01M1FGA0QA7ESY1H2H6BR18ASW
title: 'Lyrics: LRC parser and the shared lyrics contract'
status: backlog
priority: medium
labels:
  - lyrics
  - shared
  - parser
workstream: W17
workstreamId: W17-1
order: 10
created: '2026-09-01T22:09:19.081Z'
updated: '2026-09-01T22:09:19.081Z'
---
## Intent

The foundation card: a pure, dependency-free LRC parser and the cross-process types every other
card in the stream imports. No IPC, no DB, no network, no UI. It goes in `src/shared` because both
sides need it — main parses sidecars and network payloads, the renderer needs the line shape to
render and highlight — and because a pure function over string input is the natural unit-test
target for a format with as many real-world dialects as LRC has.

## Why the parser is shared rather than main-only

Everything else in the stream can be tested through it, and the failure mode this card prevents is
the expensive one: a parser that quietly mistimes a dialect produces lyrics that scroll *almost*
right, which reads as "the feature is broken" rather than "this file is unusual". Getting the
dialects right once, in a tested pure function, is cheaper than debugging drift through three
delivery paths.

## Contract

`src/shared/lyrics.ts` — the only cross-process surface (per the `src/shared` convention):

- `LyricsLine { timeMs: number | null; text: string; words?: LyricsWord[] }` — `timeMs === null` is
  an untimed line, which is how a plain-lyrics document is represented without a second type.
- `LyricsWord { timeMs: number; text: string }` — enhanced-LRC only, absent in the common case.
- `LyricsDocument { lines: LyricsLine[]; synced: boolean; offsetMs: number; source: LyricsSource;
  title?/artist?/album?/length? }` — `synced` is derived (any line carries a timestamp), not
  asserted by the caller.
- `LyricsSource = 'sidecar' | 'embedded' | 'lrclib'` — provenance travels with the document so
  W17-3 can attribute it and W17-5 can decide what a manual override replaces.

`parseLrc(raw: string): LyricsDocument` and `isSyncedLyricsText(raw: string): boolean` (the cheap
sniff W17-2 needs to decide whether embedded text is LRC or plain).

## Dialects that must be handled

These are not hypothetical — they are what community `.lrc` files actually contain:

- `[mm:ss.xx]`, `[mm:ss.xxx]` and `[mm:ss]`. Centisecond vs millisecond is ambiguous by digit count
  and must be resolved by digit count, not guessed.
- **Multiple timestamps on one line** (`[00:12.00][01:45.30] chorus text`) — a repeated chorus,
  which expands to N lines. Common enough that missing it visibly breaks choruses.
- `[offset:+/-NNN]` in the header. Positive shifts lyrics *earlier* by convention; this is the
  single most-often-inverted detail in LRC implementations, so it gets its own test with a stated
  sign convention in a comment.
- ID tags `[ti:]`, `[ar:]`, `[al:]`, `[length:]`, `[by:]` — captured where useful, never rendered
  as a lyric line.
- Enhanced LRC inline word tags `<mm:ss.xx>` — parsed into `words` when present, stripped from
  `text` either way, so a file carrying them never renders raw angle brackets.
- Malformed/junk lines, blank lines, BOM, CRLF, and a file with no timestamps at all (→ a valid
  `synced: false` document rather than a throw).

Output is **sorted by `timeMs`** and stable for equal timestamps. Never throws on bad input: the
worst case is a `synced: false` document, because an unparseable lyrics file must degrade to plain
text rather than take out the pane.

## Files

- `src/shared/lyrics.ts` — types + parser.
- `tests/shared/lyrics.test.ts` (or `tests/main/` if there is no shared test dir — check before
  authoring).

## Tests

One case per dialect above, plus: the offset sign convention; multi-timestamp expansion ordering;
centisecond vs millisecond precision; enhanced-LRC stripping; a plain-text file; an empty file; a
binary blob handed in by mistake (must not throw).

## Out of scope

No file I/O, no network, no Vue, no timing/playback logic — W17-3 owns which line is current.
