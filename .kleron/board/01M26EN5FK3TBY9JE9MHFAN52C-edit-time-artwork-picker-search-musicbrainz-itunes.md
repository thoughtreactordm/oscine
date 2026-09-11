---
taskId: 01M26EN5FK3TBY9JE9MHFAN52C
title: >-
  Edit-time artwork picker: search MusicBrainz + iTunes for a cover and stage it
  as an override
status: done
priority: medium
labels:
  - artwork
  - musicbrainz
  - coverartarchive
  - itunes
  - network
  - D14
workstream: W7
workstreamId: W7-17
workstreamDependsOn:
  - W16
dependsOn:
  - 01M26EKC87G2EH95B3FGHKGSR6
order: 11
created: '2026-09-10T20:02:59.187Z'
updated: '2026-09-11T22:38:18.791Z'
---
## Intent

The other surface: let the operator pull a cover from the network for tracks *already in the library*,
from the cover-art edit affordance, instead of hunting a file on disk. Search by artist + album,
present candidates with thumbnails, and on pick call `setCover(trackIds, bytes)` — the picked cover
lands as a durable override, exactly as a file pick does today.

Depends on W7-15 for the CAA client and `cover-art` scope. Leans on W16's artwork override layer and
its edit surface (hence the W16 stream dependency), but adds no new storage — the override path is
already built.

## The wrinkle: indexed tracks carry no release MBID

The rip path (W7-16) has it easy because the session already stored a `releaseMbid`. The library
schema does **not** carry a release or release-group MBID on `tracks` or albums. So this surface
cannot go straight to Cover Art Archive — it has to find the release first. That is the one piece of
real work here, and it is the standard MusicBrainz-Picard shape:

1. **MusicBrainz release-group search** by artist + album, through the client W7 already has
   (`src/main/musicbrainz/search.ts` / `releaseGroups.ts` already exist and are unused by this path
   today). Return ranked candidates — never auto-pick; R5's visible-and-correctable stance applies to
   artwork identity as much as artist identity.
2. For each candidate, resolve a cover via `fetchReleaseGroupFront` (W7-15). Show the thumbnails.
3. On pick, `fetchImageBytes` → `setCover(trackIds, bytes)`.

**iTunes as the fallback source.** Releases MusicBrainz does not have still need covers. Reuse the
existing keyless iTunes client (`src/main/podcasts/itunes.ts`, which already pulls `artworkUrl600` /
upscales `artworkUrl100`) with `entity=album`, presented as a second tab or a "no MusicBrainz match?"
affordance. Naming iTunes at the D14 gate is W7-15's consent-copy obligation; this card is its first
album-art consumer.

## Renderer opens no socket

D14's second rule and the `no-renderer-network` ESLint rule are absolute here: **no
`<img src="https://coverartarchive.org/...">`**, and no remote origin in `img-src`. Fetch candidate
thumbnails to bytes in main and hand the renderer a `blob:` or `oscine:` URL for preview — the same
proxy Podcast Discover already uses for its Apple thumbnails. Candidate previews are transient and
never persisted; only the picked cover becomes an override.

## Where it lives

The cover-art edit surface — the W16-6 Tools-tab review area / the CoverArt override affordance — is
the host. Add a "Get artwork from the internet" action beside the existing file picker and clear/
revert controls, so the operator's three ways to set a cover (file, network, clear) sit together. The
batch shape matches `setCover(trackIds, ...)`: applying a found cover to a whole album is the default,
one track the narrow case.

## Contract

- `src/shared/ipc.ts` — a new channel, e.g. `artwork.searchCovers({ artist, album })` →
  `CoverArtCandidate[]` (from both sources, tagged by `source`), and reuse of the existing
  `setCover` channel for the apply. No new setCover variant — the bytes are the bytes.
- Main handler wiring the MB release-group search + CAA + iTunes behind that channel, on the
  `'cover-art'` scope.
- Renderer: the picker panel and its `blob:`/`oscine:` preview.

## Tests

- MB release-group search → CAA resolution → `setCover` writes the override for the selected tracks.
- iTunes fallback path when MB returns no match, including `artworkUrl100` upscale.
- Consent off ⇒ the network action is unavailable/empty and the file picker still works — the local
  edit path never depends on the socket.
- A picked cover produces exactly the same override state as the same bytes chosen via file (identity
  through `artworkHash`).
- Renderer preview uses `blob:`/`oscine:` only; a lint/tooling assertion that no remote `img-src` or
  renderer fetch is introduced.

## Out of scope

No rip path (W7-16). No writing tags to disk — a chosen cover is an override in the originals store
(D7/D28 untouched; a later "flush this artwork into my files" is W16's staged-review machinery, not
this card). No fanart.tv / Discogs / Last.fm keyed sources. No storing the resolved release MBID back
onto `tracks` — tempting, but that is a schema decision of its own; if a card later adds an
album/release MBID column, this picker becomes a straight-to-CAA lookup and the search step drops out.
