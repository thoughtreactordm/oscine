---
taskId: 01KYTKXNGSRRBNQEF2W1SY93P3
title: Network consent gate and settings
status: in-review
priority: high
labels:
  - M7
  - phase-2
  - privacy
workstream: W7
workstreamId: W7-6
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 11
created: '2026-07-30T22:57:01.976Z'
updated: '2026-08-02T20:12:46.535Z'
---
## Scope

- Implements **D14**'s first rule: nothing leaves the machine until the operator opens the deck and accepts a one-time prompt.
- The prompt names MusicBrainz and Wikipedia, states exactly what is sent (an artist name string), and says what is stored.
- A settings toggle to enable or disable afterwards. Declined is a persistent, respected state — not a nag.

## Acceptance

- With consent never granted, a packet capture over a full listening session shows zero requests to any external host. This is the acceptance criterion that matters; assert it rather than assuming it.
- Declining costs no local pane any function.
- Re-enabling takes effect without a restart.
- The prompt's copy is reviewed for accuracy against what the fetch layer actually sends — a consent dialog that misstates the request is worse than none.

## Notes

**D14**. First card of phase 2, because every other phase-2 card is only allowed to run behind it.

---

## Built — `82c8d35`

One durable key, `network.externalLookups`, default `false`, in the `network`
category that until this card held nothing. The default is the substance of the
card: an operator who never opens Settings › Network never contacts anyone, and
no code path has to remember to ask first.

### The prompt is deferred, on the operator's instruction

The card's scope names a one-time prompt shown when the deck is first opened.
That is **not** built. Asked whether it should be an inline card in the deck or
a modal, the operator answered: put it in Settings for now, and fold the ask
into an onboarding flow later. So what ships is the gate and the toggle; the
one-time prompt is outstanding and belongs to that onboarding card.

This is a real gap against D14's first rule as written — the rule says "opens
the deck and accepts a one-time prompt", and there is currently no prompt.
What is *not* a gap is the property the rule exists to produce. The default is
denied, the gate is in main at the socket, and there is nothing an operator can
do short of finding the toggle that causes a request. The prompt would make the
decision *informed*; its absence makes it *unmade*, which is the safe side.

### Why `portable: false`

Unusual for a durable key — the flag normally marks the ones describing this
machine, and consent describes a person. Set anyway, because W8-13's profile
import would otherwise be a way to turn networking on without anyone agreeing
to it on the machine the requests would leave from. A profile that silently
grants consent is exactly the bypass the first rule closes, and "the operator
exported this profile themselves, probably" is not the standard a privacy gate
is held to. Carrying the decision across machines is worth less than the
guarantee it was made on each of them. Tested.

### Why the gate re-reads the setting on every request

`createNetworkConsent` resolves it live rather than caching. The cost is a
registry walk per request, against a limiter that already spaces requests a
second apart — nothing. What it buys is the card's "re-enabling takes effect
without a restart" with no invalidation path to get wrong. A cached copy would
need a `settings.changed` subscription, and the failure mode of getting that
subscription wrong is a machine that keeps fetching after being told to stop.
The asymmetry is the argument: the expensive answer is the safe one.

It is also re-read *between retries*, not only before the first attempt, so
switching the toggle off abandons a backoff already scheduled rather than
letting it outlive the decision. Tested in `client.test.ts`.

## Acceptance

- **Zero requests without consent.** Not yet proven by packet capture — that is
  the manual half and it is called out below as outstanding. What is proven:
  the client opens no socket and takes no rate-limit slot when consent is
  withheld, asserted against an injected `fetch`; and there is no live fetch
  call site in the application yet, since W7-9 has not landed. The capture
  becomes meaningful once there is something to capture, which is W7-15's job.
- **Declining costs no local pane any function.** Trivially true at this point
  and worth saying plainly: no pane consults the network, so every deck pane is
  unaffected either way. It stops being trivial at W7-9 and is that card's to
  keep.
- **Re-enabling without a restart.** The live read, unit tested, and confirmed
  in a scratch instance: toggled on, off and on again over IPC, each round-trip
  reflected by `settings.getAll`.
- **Copy reviewed against what the fetch layer sends.** The help text names
  MusicBrainz and Wikipedia and says an artist name goes out and the replies are
  cached beside the library. That matches D14 and matches what W7-7's client is
  built to send. It deliberately does **not** name Apple: W9-5 brings Discover's
  catalogue under this same key and will amend the copy when it does, and
  naming a host the gate does not yet cover would be the misstatement the card
  warns about.

Confirmed in a scratch instance (`--user-data-dir`, 9333): Settings shows a
Network section in the rail, the row renders with its label and help, and the
resolved default is `false`.

## Outstanding

- **The one-time prompt**, deferred to an onboarding flow at the operator's
  instruction. Nothing else in phase 2 is blocked by it — the key it would
  write already exists.
- **The packet capture**, which needs a fetch call site to be worth running.
