---
taskId: 01M26EKC87G2EH95B3FGHKGSR6
title: >-
  Network album art: the Cover Art Archive client, the cover-art scope, and
  naming it at the D14 gate
status: in-review
priority: medium
labels:
  - artwork
  - musicbrainz
  - coverartarchive
  - network
  - D14
workstream: W7
workstreamId: W7-15
order: 1
created: '2026-09-10T20:02:00.582Z'
updated: '2026-09-10T20:20:52.756Z'
---
## Intent

The foundation card for network-derived album art. It builds the one genuinely new piece both
surfaces need — a keyless Cover Art Archive fetch that turns a release MBID into validated image
bytes — and nothing else. W7-16 (rip prep) and W7-17 (edit-time picker) are the two callers; this
card ships no UI of its own beyond the consent-prompt copy.

This does **not** reopen D1 — no audio arrives over the network — and it does not reopen D14 so much
as cash it in. D14 already fetches *images* over the network (Wikidata → Wikipedia, for the artist
nexus). This extends the source list to Cover Art Archive and the target to album covers. The
principle is unchanged: keyless, main-process only, opt-in, drawer-scoped.

## Why this is small: bytes go through the door that already exists

`ArtworkCacheService.setCover(trackIds, bytes)` already sniffs the MIME, validates through sharp,
stores content-addressed in the originals store, and writes the tri-state `artwork_overrides` row
(migration 021). It takes **bytes, not a file path**. Network-fetched bytes are indistinguishable
from a file the operator picked, so this card produces bytes and hands them off — it adds no storage,
validation or thumbnail path. That is the whole reason the two surface cards are thin.

## The client

`src/main/artwork/coverArtArchive.ts` (new), a thin client over W7's existing `NetClient`:

- `fetchReleaseFront(client, mbid): Promise<NetResult<CoverArtCandidate[]>>` —
  `GET https://coverartarchive.org/release/{mbid}` returns a JSON manifest: `images[]`, each with a
  `front` boolean, an `image` URL, and a `thumbnails` map (`250`/`500`/`1200`/`small`/`large`).
- `fetchReleaseGroupFront(client, mbid)` — `.../release-group/{mbid}`, the representative release's
  front, for the edit-time path where only a release-group MBID is in hand.
- `fetchImageBytes(client, url, { maxBytes }): Promise<NetResult<Uint8Array>>` — the second hop,
  `NetClient.getBytes`, capped at `MAX_ARTWORK_INGEST_BYTES` (the same 32 MB ceiling the file picker
  enforces) so a hostile manifest cannot make us buffer an arbitrarily large body.

Two details that are the usual source of a broken CAA integration, each with a test:

- **The image blob lives on a different host.** `coverartarchive.org` 307-redirects the actual bytes
  to `archive.org` (`ia*.us.archive.org`). The client must follow the redirect, and because the
  per-host rate limiter keys on hostname, the `archive.org` fetch is *not* throttled against the
  `coverartarchive.org` manifest call — confirm `NetClient` follows cross-host redirects and that we
  do not accidentally serialise the two behind one host's clock.
- **A 404 is a normal outcome, not an error.** Plenty of releases carry no front cover. Return an
  empty candidate list, never a failure the UI has to explain.

## Scope and consent

Add `'cover-art'` to `NET_SCOPES` in `src/shared/net.ts`, with a doc comment in the house style — an
artwork lookup belongs to whatever surface the operator opened (the rip pane, the cover-edit panel),
and closing it abandons in-flight fetches. Do **not** reuse `'cdrip'`; the edit-time picker is a
distinct surface with no disc.

Because the call goes through `NetClient`, D14's consent gate (`network.externalLookups`) is checked
at the socket by construction. Add **no** second consent check in a caller.

**Name Cover Art Archive at the gate (this is the W7-6 obligation).** D14's first rule is a one-time
prompt naming the services before anything outbound happens. Adding CAA means the prompt copy must
name it (and iTunes, once W7-17 adds the fallback). Do this here rather than shipping ahead of the
prompt the way Podcast Discover did — that debt is recorded against W7-6 precisely so new sources do
not repeat it.

## Caching

CAA manifest responses are derived data: cache them in `cache.db` behind `CacheService.through`, keyed
on the MBID, with their own TTL and negative entries (so a 404 is remembered, not re-fetched every
open). The *bytes the operator actually picks* are a different thing — they become a durable override
in the originals store via `setCover`, authoritative and surviving a cache wipe, mirroring the
`artists.mbid` / `mbid_source = 'manual'` decision-vs-cache split. Do not persist un-picked candidate
blobs durably.

## Contract

- `src/shared/artwork.ts` grows `CoverArtCandidate { source: 'coverartarchive'; front: boolean;
  thumbUrl: string; fullUrl: string; width?: number; height?: number }`.
- `src/main/artwork/coverArtArchive.ts` — the client above, `NetClient` and cache injected.
- `NET_SCOPES` grows `'cover-art'`.

## Tests

- Manifest parse from a recorded CAA payload: front-vs-back ordering, the `thumbnails` map, a release
  with multiple images.
- 404 → empty list falling through cleanly; negative cache entry written.
- `maxBytes` refusal on an oversized body.
- Cross-host redirect (`coverartarchive.org` → `archive.org`) is followed and not rate-limited
  against the manifest host.
- **Consent off ⇒ no socket opened, empty usable result** — the same assertion W18-2 makes for the
  disc lookup.

## Out of scope

No UI (W7-16, W7-17 own their surfaces). No writing to disk beyond what `setCover` already does. No
iTunes fallback — that is W7-17, where the edit-time path needs a second source; the rip path has an
MBID and does not. No fanart.tv / Discogs / Last.fm: all need keys or return degraded data, which
reopens D14's keyless half — a later card with its own decision if ever.
