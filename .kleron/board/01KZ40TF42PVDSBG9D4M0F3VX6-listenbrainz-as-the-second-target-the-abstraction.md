---
taskId: 01KZ40TF42PVDSBG9D4M0F3VX6
title: ListenBrainz as the second target — the abstraction's test
status: todo
priority: low
labels:
  - main
  - network
  - D19
workstream: W11
workstreamId: W11-8
dependsOn:
  - 01KZ40T0PCH1E2GH031Q4BFKTT
  - 01KZ40RQ6VF1EAZVWCJYTEGJAN
order: 64
created: '2026-08-03T14:35:38.497Z'
updated: '2026-08-03T14:35:38.497Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → D19.

A second `ScrobbleTarget`, and the only real test of whether W11-1's abstraction held or quietly grew a Last.fm shape.

**Why this one.** ListenBrainz needs **no app key at all** — a user token and nothing else — so it sidesteps D14's objection entirely and is by some distance the cheapest second target. It is also different enough to be a genuine test: token auth instead of a browser round trip, JSON bodies instead of signed form parameters, its own batch limit, `single`/`playing_now`/`import` submission types instead of two distinct endpoints. And it is where an operator who is uncomfortable with a bundled API key can go instead.

**The real deliverable is the diff to shared code.** If implementing this target requires changing `ScrobbleTarget`, the outbox, or the drain worker, that change *is* the finding — record it in D19's revisit note rather than absorbing it silently. If a hardcoded 50, a signature assumption, or a Last.fm error code turns up outside the Last.fm client, that is exactly what this card exists to surface.

**Notes:**
- Love/unlove: ListenBrainz has no direct equivalent. `capabilities.love` is false and the outbox must simply never enqueue love rows for it — which is what `capabilities` was written for in W11-1.
- Both targets can be connected at once and drain independently. Test that.
- Self-hosted instances mean the API root should be a setting, not a constant.
- Auth is a pasted user token, so it is a durable setting **only if** it is not a secret — it is one, so it goes to `safeStorage` beside the Last.fm session key, same rule, no exceptions for being easier to type.

**Done when:** a listen lands on both services from one commit, disconnecting one leaves the other draining, and any change this card forced on shared code is written down in D19.
