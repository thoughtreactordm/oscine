---
taskId: 01M26EM9YHX1RNW8P7RCVZKR4G
title: 'CD-rip prep: auto-fetch the release cover into the session before ripping'
status: done
priority: medium
labels:
  - artwork
  - cdrip
  - coverartarchive
  - network
  - D14
  - D29
workstream: W7
workstreamId: W7-16
workstreamDependsOn:
  - W18
dependsOn:
  - 01M26EKC87G2EH95B3FGHKGSR6
order: 5
created: '2026-09-10T20:02:30.991Z'
updated: '2026-09-11T22:38:18.714Z'
---
## Intent

The easy surface, because the key is already in hand. Once a rip's release is matched, fetch its
front cover from Cover Art Archive and drop the bytes into the session's existing artwork slot, so
the FLACs come out of the rip already arted. The operator can replace it (the existing file picker)
or clear it. This is the "so the indexed files are set up with cover art automatically" half of the
request.

Depends on W7-15 for the CAA client and the `cover-art` scope. Slots into W18's rip flow (hence the
W18 stream dependency), but owns no new rip machinery.

## Why nearly everything is already here

- The rip flow **already resolves and persists a release MBID**: `discLookup.ts` returns
  `releaseMbid`, stored in `rip_sessions.release_mbid` (migration 023). That MBID is the direct CAA
  key — no search, no matching, no operator disambiguation for artwork beyond the release they
  already chose.
- The session **already has a place to put the image**: migration 024 added `artwork_bytes` and
  `artwork_mime` to `rip_sessions`, and `RipArtworkPicker.pick()` already validates and stores bytes
  (sniff + `MAX_ARTWORK_INGEST_BYTES`). Today that path is file-dialog only. This card adds a network
  source *above* the same validation and the same slot.

So the work is: after the operator confirms a release, call
`fetchReleaseFront(client, session.releaseMbid)` (W7-15), pick the `front` image, `fetchImageBytes`,
and feed the bytes into the identical ingest path `RipArtworkPicker` already runs. One new source, no
new sink.

## Behaviour

- **Auto-fetch on release confirm, show it as a proposal.** Consistent with D29: disc metadata is a
  proposal the operator confirms, never an auto-application. The fetched cover is the proposed cover,
  visible in the Rip pane, and the operator can accept, replace via the file picker, or clear it
  before the rip commits.
- **Offline and no-match are first-class, not error paths.** With `network.externalLookups` off, or
  on a 404, or a manual/CD-TEXT-only disc with no `releaseMbid`, the pane simply shows no proposed
  cover and the file picker is the way in — exactly as it is today. A rip must complete arted or not,
  online or off; W18's "a rip must complete offline" requirement extends to its artwork.
- **The fetch enrols in the rip's scope so cancelling the rip abandons it.** Use `'cover-art'` (or
  the rip's own `'cdrip'` scope if that reads cleaner at the call site — coordinate with W18-5's
  session lifecycle rather than leaking a lookup past a cancelled rip).

## Not a write-back, by construction

These are **new files being created**, tagged at creation through W16's `writer.ts` field mapping
(APIC / METADATA_BLOCK_PICTURE). Nothing here mutates a pre-existing library file, so the D7/D28
write-back review gate is not in the path — same stance W18 already takes for text tags. The
"no implicit tag write" invariant is about existing files; a freshly-ripped FLAC is not one.

## Contract

- `src/main/cdrip/artwork.ts` — `RipArtworkPicker` (or a sibling) grows a network source method,
  `proposeFromRelease(client, releaseMbid): Promise<ArtworkRef | null>`, reusing its existing
  validate-and-store internals. No new table; the bytes land in `rip_sessions.artwork_bytes` as they
  do now.
- Rip-pane wiring to call it on release confirm and render the proposal.

## Tests

- Given a `releaseMbid` with a front cover, the session's `artwork_bytes` is populated from the
  network path through the same validation the file picker uses.
- 404 / no `releaseMbid` / consent off ⇒ no proposed cover, file picker still works, rip still
  completes.
- Cancelling the rip abandons an in-flight artwork fetch.
- A network-proposed cover the operator then replaces with a file ends with the file's bytes, not
  the fetched ones.

## Out of scope

No edit-time picker (W7-17). No iTunes fallback in the rip path — a disc that matched a MusicBrainz
release either has CAA art or the operator supplies it; searching iTunes for an album we already have
an MBID for is the edit-time problem, not this one. No AccurateRip, no cue sheets — unchanged from
W18's exclusions.
