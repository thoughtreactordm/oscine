---
taskId: 01KZ40RQ6VF1EAZVWCJYTEGJAN
title: >-
  The Last.fm client — signing, `track.scrobble`, `track.updateNowPlaying`,
  error taxonomy
status: done
priority: high
labels:
  - main
  - network
  - D19
workstream: W11
workstreamId: W11-4
dependsOn:
  - 01KZ40R3J8RW3AP3180KPYAFNS
  - 01KZ40QHB4PYF5AG93T4KAK1YW
order: 1
created: '2026-08-03T14:34:41.242Z'
updated: '2026-08-04T15:06:58.822Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Scrobbling → "Last.fm specifics".

The first real `ScrobbleTarget` implementation. Main process only.

**Reuse W7's fetch layer.** By M7 the main-process HTTP path, its timeouts, its user-agent policy and its cancel-by-scope machinery all exist. This is a client, not a second HTTP stack — that reuse is the reason M8 is sequenced after M7 at all.

**Signing.** `POST` to `ws.audioscrobbler.com/2.0/`, `api_sig = md5(<params sorted by key, concatenated as key+value> + shared_secret)`. The `format` parameter is excluded from the signature. Get this exactly right and test it against a known-good vector — a wrong signature fails as a generic auth error and will otherwise cost a day.

**`track.scrobble`** in batches of up to **50**, array-indexed parameters (`artist[0]`, `track[0]`, `timestamp[0]`, …). `timestamp` is UTC **seconds**, not milliseconds. Return per-item accept/reject to the drain worker.

**`track.updateNowPlaying`** is fire-and-forget: never queued, never retried, failures not surfaced. It fires at the **transport-commit** moment, not at departure — it is a "currently playing" notification with a short server-side expiry, and sending it at the end of a track would be announcing the past.

**The error taxonomy**, mapped onto `NetFailureKind`:
- **code 9, invalid session** → terminal auth failure. Disconnect the account, halt the drain, surface a re-authorize prompt. Do not retry, and do not burn `attempts` on every queued row on the way out.
- **code 29, rate limit**, and the 5xx family → retryable, backoff.
- **malformed payload / code 6** → terminal for that row. Drop it with `last_error` recorded. Retrying a payload the server will never accept is an outbox that never drains.

**Tests** (`tests/main/`): the signature against a known-good vector; batch parameter construction for 1, 2 and 50 items; the response parser against captured fixtures for full accept, partial accept, code 9, code 29 and a malformed body; that `updateNowPlaying` failure is swallowed and never enqueues anything.

**Done when:** a real track played past threshold appears on the operator's actual Last.fm profile, and the same played offline appears when the network returns.
