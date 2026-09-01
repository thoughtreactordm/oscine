---
taskId: 01M1FHZQC8BQQS72DA3PNR8HAP
title: 'Rip: the naming template engine and destination resolution'
status: backlog
priority: medium
labels:
  - cdrip
  - paths
  - settings
  - portability
workstream: W18
workstreamId: W18-4
order: 18
created: '2026-09-01T22:38:38.983Z'
updated: '2026-09-01T22:38:38.983Z'
---
## Intent

The configurable naming convention: a template over resolved disc metadata that produces a
root-relative path per track, plus the validation that decides whether a chosen destination is even
rippable. Pure functions and a settings key — no disc, no encoder, no I/O beyond an existence
check, so it can be built in parallel with W18-1.

## The template

Default:

```
{albumartist}/{album} ({year})/{disc}-{track:02} {title}
```

Tokens: `{albumartist}` `{artist}` `{album}` `{title}` `{track}` `{disc}` `{year}`, with an
optional `:02`-style zero-pad on the numerics. The extension is appended by the encoder, not
written in the template — a template carrying `.flac` would be wrong the moment a second codec
lands.

Two behaviours that stop the common disc from producing a stupid path:

- **`{disc}` collapses to nothing on a single-disc release**, taking any adjacent separator with
  it. `1-01 Title` on every one-disc album is noise.
- An empty or unknown token resolves to a stated placeholder (`Unknown Artist`, `Unknown Album`),
  never to an empty path segment — a template that can emit `//` can emit a path that escapes its
  own directory.

## Sanitization — the two rules that are load-bearing

**Sanitize per component, not over the whole string.** The separators have to survive; running a
filename sanitizer across the joined path eats them and collapses the tree.

**Sanitize for both platforms, always, on both platforms.** A file called `AC/DC: Back in Black`
written on Linux makes the library non-portable, which defeats D11's export bundle and breaks the
operator who later syncs the folder to Windows. So the union of both platforms' rules applies
everywhere: reserved characters `< > : " / \ | ? *`, control characters, trailing dots and spaces,
and the Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`) — the
device-name case is the one everybody forgets and it is a real album title away from biting.

Reuse the reserved-character and control-character handling from `src/main/podcasts/paths.ts`
rather than writing a second one; if it needs generalising, generalise it there and have both
callers use it.

Cap each component at 255 bytes (not characters — a UTF-8 title can blow the limit well before 255
glyphs) and truncate on a grapheme boundary.

## Destination and the path invariant

The destination folder **must resolve under a known library root**, because the rip has to end in
`toRelPath(root.path, absPath)` and the invariant is absolute: never store an absolute path in
`tracks`. So:

- Resolve the chosen folder against every root; if it is inside one, carry the `rootId` forward.
- If it is inside no root, **refuse to rip** and offer to add it as a root. Do not silently rip to a
  folder the library cannot index — that produces files the operator cannot find and no error to
  explain it.
- Reject a destination on a different device/volume from the root if that would break the atomic
  rename W18-7 depends on; a cross-device `rename` fails at the worst possible moment.

Collision handling: if the target file already exists, the operator chooses skip / overwrite /
suffix, decided per rip in W18-6 rather than per file mid-rip.

## Contract

`src/shared/cdrip.ts`:

- `RIP_NAME_TEMPLATE_KEY` and `RIP_DESTINATION_ROOT_KEY` settings keys, defaulting as above,
  defined in `src/shared/settings/library.ts` beside the existing `library.*` entries so they ride
  the settings cascade W8 built.
- `renderRipPath(template: string, fields: RipNameFields): string` — pure, returns a POSIX-
  normalised **root-relative** path with no extension.
- `validateRipDestination(absDir: string, roots: RootRow[]): { ok: true; rootId: number; relDir:
  string } | { ok: false; reason: 'outside-roots' | 'cross-device' | 'not-writable' }`

## Tests

`renderRipPath` is the ideal unit-test target and should be tested like one:

- Every token, the `:02` pad, an unknown token (left literal, not thrown), a malformed
  `{unclosed`.
- Each reserved character; a Windows device name as an album title; a title that is entirely
  reserved characters (must not produce an empty segment); trailing dot and trailing space.
- A single-disc release dropping `{disc}` and its separator; a multi-disc release keeping it.
- A 300-byte UTF-8 title truncating on a grapheme boundary, not mid-codepoint.
- `validateRipDestination` for each failure reason, including a folder that is a *parent* of a root
  rather than a child.

## Out of scope

No template-editing UI with live preview — W18-6 owns the field and the preview line. No per-album
override of the template. No moving or renaming of files already in the library.
