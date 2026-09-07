---
taskId: 01M1FHXZ4E3N5GWB3B3Y8AN5S0
title: 'Rip: disc ID, CD-TEXT and the MusicBrainz disc lookup behind D14'
status: backlog
priority: medium
labels:
  - cdrip
  - musicbrainz
  - network
  - D14
workstream: W18
workstreamId: W18-2
dependsOn:
  - 01M1FHX2E9B7GSQRZHJ4MPFHX1
order: 16
created: '2026-09-01T22:37:41.390Z'
updated: '2026-09-01T22:37:41.390Z'
---
## Intent

Turn a `CdToc` into a metadata proposal. Three tiers, in priority order, and the tier order is the
design: MusicBrainz disc lookup, CD-TEXT from the drive, manual entry. The first tier is the only
one that opens a socket, which is what makes the whole feature usable with
`network.externalLookups` off.

**A rip must complete offline.** If this card's network tier is unreachable or disabled, W18-5 must
still be able to rip a disc with operator-typed metadata. That is a hard requirement, not a
degradation story — build the manual path first and hang the lookup off it.

## The disc ID is a pure function, and that is the good news

MusicBrainz Disc ID needs no native library and no `libdiscid`. It is SHA-1 over a formatted string
built from the TOC — first track, last track, lead-out offset and the 99 track offsets, each as
uppercase hex — then base64 with `+/=` substituted by `._-`. Roughly thirty lines of TypeScript
over data W18-1 already returns.

Two details that are the usual source of a wrong ID, and each gets its own test:

- Offsets are **LBA + 150** (the 2-second pregap), not raw LBA.
- The offset array is **always 99 entries**, zero-padded past the last real track. Truncating it
  produces a plausible-looking ID that matches nothing.

Compute the ID over the **full TOC including data tracks** — the disc ID is a property of the
physical disc, so filtering to audio here breaks the lookup on every enhanced CD. Audio-only
filtering happens downstream.

## Network tier

`GET /ws/2/discid/<id>?inc=recordings+artist-credits+release-groups&fmt=json` through W7's existing
`NetClient.getJson({ url, scope, accept })`. Add `'cdrip'` to `NET_SCOPES` in `src/shared/net.ts`
with a doc comment in the style of the existing entries — a rip is the unit of interest, and
closing the pane or cancelling the rip should abandon in-flight lookups.

Because the call goes through `NetClient`, D14's consent gate is checked at the socket by
construction and no pane has to remember. Do not add a second consent check in the pane.

A disc ID legitimately matches **several releases** (pressings, regions, reissues). Return all of
them, ranked, and let W18-6 make the operator choose — never auto-pick. A `404` is a normal,
expected outcome, not an error state: an unmatched disc drops to CD-TEXT and then to manual.

Results are derived data, so they cache in `cache.db` behind `CacheService.through` keyed on the
disc ID with its own TTL. The operator's *choice* of release is a decision and belongs to the rip
session in W18-8, mirroring the `artists.mbid` / `mbid_source = 'manual'` split.

## CD-TEXT tier

`READ TOC/PMA/ATIP` with format 5 returns CD-TEXT when the disc carries it, which most discs do
not. Free, offline, and worth the ~80 lines: parse the pack stream for title (0x80) and performer
(0x81) at disc and track level, honouring the double-byte and character-set packs enough to reject
what we cannot decode rather than emit mojibake. Requires a small addition to W18-1's `readToc` —
coordinate the signature rather than adding a second entry point.

## Contract

`src/shared/cdrip.ts` grows:

- `computeDiscId(toc: CdToc): string` — pure, exported from shared so the test suite owns it
- `DiscMetadataProposal { source: 'musicbrainz' | 'cdtext' | 'manual'; releaseMbid?: string;
  albumArtist: string; album: string; year: number | null; tracks: ProposedTrack[] }`
- `ProposedTrack { number: number; title: string; artist: string; recordingMbid?: string }`
- `DiscLookupResult { discId: string; candidates: DiscMetadataProposal[] }`

`src/main/cdrip/discLookup.ts` — the tiering, with the `NetClient` and the cache injected.

## Tests

- Disc IDs computed from checked-in TOC fixtures against **known-correct published IDs** — this is
  the one place where an external ground truth exists, so use it. Include a single-track disc, a
  99-track disc, and an enhanced CD with a trailing data track.
- The +150 offset and the 99-entry padding, each isolated.
- Response mapping from a recorded MusicBrainz payload, multi-candidate ordering, and a 404 falling
  through to the next tier.
- **Consent off ⇒ no socket opened, and the tier still returns a usable empty result.**
- CD-TEXT parsing, including a disc with none and a disc with an undecodable character set.

## Out of scope

No artwork fetching (that is the ordinary library artwork path once the files exist). No AccurateRip
or CUETools-DB verification. No writing anything to disk — this card produces a proposal object and
nothing else.
