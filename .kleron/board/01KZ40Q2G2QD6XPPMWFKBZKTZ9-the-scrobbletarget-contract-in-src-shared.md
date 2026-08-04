---
taskId: 01KZ40Q2G2QD6XPPMWFKBZKTZ9
title: The `ScrobbleTarget` contract in `src/shared`
status: done
priority: high
labels:
  - contract
  - shared
  - D19
workstream: W11
workstreamId: W11-1
order: 0
created: '2026-08-03T14:33:47.266Z'
updated: '2026-08-04T15:06:58.796Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → D19 and → Scrobbling → "The provider contract".

The interface every target implements, so Last.fm's signature scheme cannot leak into the queue, the threshold logic or the UI. Types only plus a stub — no network in this card.

```
authorize()            — begins whatever flow the target uses; resolves to a stored credential
nowPlaying(payload)    — fire-and-forget
submit(batch)          — up to the target's batch limit; per-item accept/reject
love(payload) / unlove(payload)
capabilities           — batch size, whether love is supported, whether duration is required
```

**Speak `NetResult<T>` and `NetFailureKind` from `src/shared/net.ts`.** They already exist and already model the failures a scrobbler hits. A second failure vocabulary would mean two things to map between, forever.

**`submit` returns per-item results, not one verdict for the batch.** Last.fm accepts a batch containing rejects, and treating a partial success as a whole failure would retry the accepted ones forever — which is an outbox that grows while appearing to work.

**`capabilities` is what keeps the abstraction honest.** ListenBrainz (W11-8) has a different batch limit and different required fields; if the drain worker hardcodes 50 anywhere, the abstraction has already failed. Write it now, while there is only one implementation to be tempted by.

Add `'scrobble'` to `NET_SCOPES` in `src/shared/net.ts`, so an in-flight drain is cancellable by the same machinery that cancels the Tunedeck's fetches.

Per the convention, this starts in `src/shared` and is imported by main — the renderer never sees a credential, so the *renderer-facing* IPC surface is deliberately much narrower than this interface (see W11-7).

**Done when:** the types compile, a stub target implements them, and the drain worker written in W11-2 can be built against the stub with no Last.fm code in existence.
