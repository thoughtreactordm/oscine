---
taskId: 01M28SFR7JGKQWGXMSQE0MJAX0
title: 'Presence: public cover-URL resolution behind the D14 consent gate'
status: in-progress
priority: medium
labels:
  - discord
  - net
  - cache
workstream: W20
workstreamId: W20-5
dependsOn:
  - 01M28SEX6184ZE1T1SGX28N1VF
  - 01M28SE04CRPRVTV15AWEZQ4Q2
order: 0
created: '2026-09-11T17:50:44.977Z'
updated: '2026-09-11T20:46:03.006Z'
---
## Intent

The album-art tier: resolve a **public** cover URL that Discord's media proxy can fetch, and slot it
into the `largeImageKey` seam W20-3 left. This is the one part of the stream that reaches the
network, so it is the one part inside D14's gate. A *client* over W7's existing net/cache layer, not
a second HTTP stack — the same reuse W11's scrobble client and W17's LRCLIB client made. See
`[[oscine-discord-presence]]`.

## Why this is the only way to show real cover art

Discord's `largeImageKey` renders **either** a static asset uploaded to the Discord application
**or** a public URL its media proxy can fetch. It **cannot** render a local file or an `oscine://`
URL — the identical wall the MPRIS work hit (`MediaImage refuses oscine://`, at `browserMediaSession.ts`).
So the operator's embedded/local artwork is unusable here without hosting it publicly, which is out
of scope and a privacy problem. The only cover this card can ever show is the **canonical release**
art, resolved to a public URL. Do not attempt to publish local art.

## Resolution

Resolve the release/recording to a **Cover Art Archive** URL (`https://coverartarchive.org/release/
<mbid>/front`, or the release-group front), via MusicBrainz to get the MBID when not already known.
Reuse `src/main/musicbrainz/` and W7's `NetClient` — the identifying User-Agent
(`src/main/net/userAgent.ts`) and the rate limiter come free. If the track already carries a resolved
MBID from the Tunedeck's identity work, prefer it over a fresh search.

- `src/shared/net.ts` — add `'discord'` to `NET_SCOPES` (the union is closed so an uncancelled scope
  is a compile error; add the cancel host too).
- Consent is checked at the socket by `src/main/net/consent.ts`, re-read live per request. **Do not
  add a second consent check in the discord module** — that is the duplication the gate's placement
  prevents. But the *decision to attempt a lookup at all* is gated on `discord.showAlbumArt` (W20-4);
  when it is off, issue no request.
- Cache: add an entity to `CACHE_ENTITIES` (`src/main/cache/policy.ts`) + a TTL, and wrap in
  `cache.through(entity, key, fetch)`. Covers are stable → long fresh TTL; negative caching so a
  release with no CAA art is not re-requested every track change. Key on the release/release-group
  identity (not the free-text tag), or a mistagged track poisons a neighbour's entry.

## Feeding presence

The resolved URL replaces the static logo in `largeImageKey` (W20-3's seam). **Fallback to the
static Oscine logo** whenever: `showAlbumArt` is off, consent is off, no MBID resolves, CAA has no
art, or the lookup is still in flight — presence must never block or blank waiting on a cover. So the
service shows the logo immediately and upgrades to the cover when it arrives, rather than delaying the
activity. Cancel an in-flight lookup on track change via the scope.

## Files

- `src/shared/net.ts` — `'discord'` scope.
- `src/main/discord/artwork.ts` — MBID→CAA resolution + cache wrap.
- `src/main/cache/policy.ts` — entity + TTL.
- `src/main/discord/service.ts` — call the resolver, fall back to the logo, upgrade on arrival, cancel
  on track change.

## Tests (`tests/main/`, net mocked)

`showAlbumArt` off → no request, logo used; consent off → no request (assert at the client), logo
used; a match → the CAA URL lands in `largeImageKey`; no MBID / CAA 404 → negative-cached, logo used,
no re-request on the next play; cache key varies with release identity not tag text; scope cancel
abandons an in-flight lookup on rapid skipping; the activity is emitted immediately with the logo and
upgraded when the cover resolves (never blocked).

## Out of scope

No hosting or publishing of the operator's local/embedded artwork. No cover source other than Cover
Art Archive. No change to the mapping's non-art fields (W20-3). No new consent mechanism — reuse
D14's.
