---
taskId: 01M1FGCGD47Z8HCK8FBNTQ0821
title: 'Lyrics: LRCLIB client behind the D14 consent gate'
status: backlog
priority: medium
labels:
  - lyrics
  - net
  - cache
workstream: W17
workstreamId: W17-4
dependsOn:
  - 01M1FGA0QA7ESY1H2H6BR18ASW
  - 01M1FGAS6272V4J1Z8GDYXNGKZ
order: 13
created: '2026-09-01T22:10:40.676Z'
updated: '2026-09-01T22:10:40.676Z'
---
## Intent

Tier 3: fill the seam W17-2 left, fetching from LRCLIB when neither a sidecar nor an embedded tag
has lyrics. This is a *client*, not a second HTTP stack — W7 already built the fetch layer, the
limiter, the User-Agent, the consent gate and the cache, exactly as W11's scrobble client reused
them.

## Why LRCLIB and no fallback chain

Keyless, registration-free, and its `/api/get` matches on **duration** — the property that stops
the radio edit's timings being drawn over the album cut, which is the failure mode that makes a
lyrics feature untrustworthy. The alternatives were considered and rejected in the stream
description (Musixmatch: 30% excerpt + display prohibited on the free tier; Genius: no lyrics text
in the API, never timestamps; NetEase/QQ: unofficial and region-flaky; lyrics.ovh: unsynced and
unmaintained). **Do not add a second provider as a fallback in this card** — one source with a
duration match beats two sources without one, and a provider abstraction with a single
implementation is speculative structure.

## API shape (verified live)

```
GET https://lrclib.net/api/get?artist_name=&track_name=&album_name=&duration=
→ 200 { id, trackName, artistName, albumName, duration, instrumental,
        plainLyrics, syncedLyrics, lyricsfile }
→ 404 { name: "TrackNotFound", statusCode: 404 }
```

`syncedLyrics` is literal LRC (`[00:19.16] When you were here before`) and goes straight through
W17-1's `parseLrc`. `instrumental: true` is a real answer, not a miss — W17-3 renders it as its own
state. `duration` is seconds; `tracks.duration_ms` is milliseconds. `/api/search`
(`?track_name=&artist_name=`) is the fuzzy fallback when the exact get misses, but **its results
are not duration-matched** — treat a search hit as a *suggestion* for W17-5's manual picker rather
than something to auto-apply, or auto-apply only within a tight duration tolerance. Record which.

## Wiring into W7's layer

- `src/shared/net.ts:95` — add `'lyrics'` to `NET_SCOPES`. The union is deliberately closed so a
  scope no host cancels is a compile error; add the cancel host too.
- Request via `client.getJson({ url, scope: 'lyrics', accept: 'application/json' })`
  (`src/main/musicbrainz/search.ts:180` is the pattern). The identifying User-Agent
  (`src/main/net/userAgent.ts`) and the rate limiter come free. LRCLIB asks only for a User-Agent
  identifying the app and version — confirm the existing one satisfies that.
- Consent is checked at the socket by `src/main/net/consent.ts`, re-read live per request and
  between retries. **Do not add a second check in the lyrics service** — that is precisely the
  duplication the gate's placement exists to prevent.
- Cache: add an entity to `CACHE_ENTITIES` (`src/main/cache/policy.ts:31`) and a TTL to
  `DEFAULT_CACHE_TTLS`, then wrap the fetch in `cache.through(entity, key, fetch)`
  (`src/main/musicbrainz/service.ts:130` is the pattern). Lyrics are stable: long fresh TTL, shorter
  negative TTL so a track that gains lyrics upstream is retried within a reasonable window. The 404
  maps to `writeNegative` cleanly.
- Cache key must include **duration** alongside artist/title/album, or a re-tagged track silently
  reuses the wrong entry.

## Behaviour

Fetch only for the track being played, on track change, never as a background sweep over the
library — that would be both rude to a free community service and a poor fit for a feature only
ever read one track at a time. Missing artist or title → do not fetch. Cancel in-flight on track
change via the scope.

## Files

- `src/shared/net.ts` — `'lyrics'` scope.
- `src/main/lyrics/lrclib.ts` (request + response mapping), `src/main/lyrics/service.ts` (cache
  wrap), wired into W17-2's tier-3 seam.
- `src/main/cache/policy.ts` — entity + TTL.

## Tests (`tests/main/`)

Duration is sent and a mismatch is not accepted; 404 → negative cache, and a second call does not
re-request; `instrumental` surfaces as instrumental not as a miss; consent off → no request issued
at all (assert at the client, not the pane); cache key varies with duration; scope cancel abandons
an in-flight request; malformed `syncedLyrics` degrades to `plainLyrics` rather than throwing.

## Out of scope

No second provider. No bulk/background fetching. No writing lyrics to disk (D7/D28). No manual
match UI — that is W17-5.
