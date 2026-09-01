---
taskId: 01M1FJ3M91JVMRF5Q777NHXW1M
title: 'Rip: hardware verification on real discs and drives (R9)'
status: triage
priority: high
labels:
  - cdrip
  - R9
  - hardware
  - human-verify
triageKind: human-verify
workstream: W18
workstreamId: W18-9
dependsOn:
  - 01M1FHX2E9B7GSQRZHJ4MPFHX1
order: 1
created: '2026-09-01T22:40:46.880Z'
updated: '2026-09-01T22:40:46.880Z'
---
## Why this exists as a human card

R9 says drives disagree with each other and with their own specifications. There is no disc in a
GitHub runner, so the CI matrix can verify the pure parts of W18-1 and nothing else. Everything
that actually distinguishes a working ripper from a plausible one — whether *this* drive honours
C2, whether *that* one reports a TOC the standard permits — is verified by a person with physical
media, or it is not verified.

**A single drive proves nothing.** Two drives per platform is the minimum that has any chance of
catching a firmware quirk, and the point of the exercise is disagreement.

## Matrix

Both Windows and Linux, at least two drives each (ideally one internal, one USB — they differ):

| Disc | What it is checking |
|---|---|
| Ordinary pressed album | The base case works at all |
| CD-R burned from FLAC | Burned media reads differently; also gives a known-good reference to hash against |
| Enhanced / mixed-mode CD | Data track appears in the TOC, is excluded from the rip, and does **not** corrupt the disc ID |
| Multi-disc set, disc 2 | `{disc}` renders, and disc number is not assumed to be 1 |
| Single-track disc | Off-by-one in the TOC walk |
| Visibly scratched disc | R10's honesty — does it report a read failure or silently produce garbage? |
| Disc with CD-TEXT | The tier-2 path runs at all (most discs lack it, so this needs seeking out) |
| Copy-protected disc | Whatever happens, it must fail cleanly rather than hang |

## Per-disc checks

- Drive enumerated with a sensible label; disc detected within one poll interval.
- Disc ID computed matches what MusicBrainz's own lookup returns for that disc (musicbrainz.org
  will tell you — this is a real external ground truth, use it).
- Track count and durations match the physical disc.
- Ripped FLACs decode, and durations match the TOC to within a sector.
- **The CD-R case is hashed against its source FLACs** — this is the only test in the whole stream
  that proves the audio data is actually correct rather than merely well-formed. Read offset shows
  up here or nowhere.
- Files land in the expected path, index automatically, and play.
- Cancel mid-rip stops within a second or two and leaves no `.part` files.
- Eject and yank the disc mid-rip: fails cleanly, no hang, no crash.

## Reporting

Record drive make/model/firmware alongside each result — a bug against "a CD drive" is
untriageable. Anything that fails becomes its own triage card; do not fold fixes into this card,
and do not close it on a partial matrix.

## Blocked on

W18-1 landing. This is the gate that says the spike succeeded — if this card cannot pass on two
drives per platform, the native approach is in question and the stream re-plans rather than
proceeding to W18-2.
