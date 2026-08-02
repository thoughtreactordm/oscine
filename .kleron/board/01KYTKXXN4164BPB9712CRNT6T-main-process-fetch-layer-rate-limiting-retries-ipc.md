---
taskId: 01KYTKXXN4164BPB9712CRNT6T
title: 'Main-process fetch layer — rate limiting, retries, IPC contract'
status: in-review
priority: high
labels:
  - M7
  - phase-2
  - main
workstream: W7
workstreamId: W7-7
dependsOn:
  - 01KYTKXNGSRRBNQEF2W1SY93P3
order: 12
created: '2026-07-30T22:57:10.307Z'
updated: '2026-08-02T20:12:49.030Z'
---
## Scope

- The only place in the application that opens a socket. Main process only, mirroring the invariant that the renderer never touches the filesystem.
- Rate limiter honouring MusicBrainz's ~1 request/second ceiling, with an identifying User-Agent per their policy.
- Timeouts, bounded retry with backoff, and cancellation of in-flight work when the drawer closes.
- Typed IPC surface, starting in `src/shared/ipc.ts` rather than in a handler.

## Acceptance

- No `fetch`/XHR to any external host exists anywhere under `src/renderer` — reviewed, and worth a lint rule if it is cheap.
- Rate limiter proven by a test that fires 20 concurrent requests and asserts the observed spacing.
- Closing the deck cancels in-flight requests; a fast open/close/open cycle does not leak work or double-fetch.
- Every failure mode — offline, timeout, 503, rate-limited — surfaces as a state the UI can render, never as an exception thrown into a component.

## Notes

**D14**, and the primary mitigation for **R5**'s secondary rate-limit concern. Shuffle-heavy listening must not be able to saturate MusicBrainz; drawer-scoped fetching plus this limiter are the two things standing between us and a ban.

---

## Built — `eb9055b`

`src/main/net/` is now the only place in the application that opens a socket on
Fermata's own initiative. Four things wrap every request, and the order is the
design: consent, then the per-host rate limit, then a per-attempt deadline, then
bounded retry.

### The limiter is a queue, not a mark

The obvious implementation keeps `nextAllowedAt` per host and has each caller
claim `max(now, nextAllowedAt)` on arrival. Four lines, spaces requests
correctly, and it fails the exact behaviour this card's acceptance names.

Open the deck, close it immediately, open it again. Twenty callers claim twenty
slots; the close cancels all twenty; the mark now sits twenty seconds in the
future. The second open waits twenty seconds to make its first request, having
made none. A FIFO queue whose clock only advances when a caller *actually
starts* has no such hole — a cancelled waiter leaves and takes nothing with it,
so a cancelled burst costs exactly the requests it did not make.

Both properties are tested, the second one specifically so the cheaper
implementation cannot come back unnoticed.

Spacing is measured between *starts*, not between a reply arriving and the next
request leaving. Two seconds of latency on request three must not push request
four two seconds late as well, or a run of slow replies compounds into a stall.

### Nothing throws

Every path answers with `NetResult`. The card asks that every failure mode be a
state the UI can render rather than an exception thrown into a component, and
the way to guarantee that is for the exception not to exist — not for each
caller to remember a `try`.

`NetFailure` is deliberately about what to tell the operator rather than about
HTTP. Three status codes that all mean "the service is having a bad day and it
is not your fault" collapse to `unavailable`, because a pane rendering 502
differently from 503 is a pane leaking its transport. `404` is `not-found`
rather than an error, because for **R5**'s unmatchable artists it is the common
case and an answer: worth caching negatively (W7-8), and worth reading as "no
information" rather than as a fault.

### Cancellation reaches queued work

Closing a scope aborts requests in flight *and* drops the ones still waiting
behind the limiter, before they reach the socket. A layer that only aborted
in-flight work would still send the other nineteen of a twenty-artist burst,
one per second, to a deck nobody has open — which is the R5 concern the card
names, arriving by the back door.

The scope and the per-attempt deadline abort with distinct reason types
(`ScopeCancelledError`, `RequestTimeoutError`), because a cancelled scope is
silence in the UI and a timeout is something to tell the operator. Each attempt
gets its own controller forwarding whichever fired, so a deadline that fires
does not also poison the retry.

`useTunedeckStore` watches the open flag and cancels on the true→false edge —
watched rather than hooked to `close()`, because the transport toggle and a
direct write to the persisted key both go around `close()`, and a cancellation
three of four paths perform is one that leaks.

### The IPC surface is one channel, on purpose

`net.cancelScope`, and nothing that starts a request. The lookups arrive with
W7-9; what this card owes the contract is the cancellation half, because that is
the half which has to exist before the first fetch rather than after. The scope
is a closed union, so an unknown scope is a rejected request rather than a
silent no-op — a cancellation that quietly does nothing leaves an invisible
leak.

### `podcasts/http.ts` moved

To `net/http.ts`, unchanged. Nothing in it was ever podcast-specific — a ceiling
on a response body and a deadline on a quiet host are what every remote read
wants — and having the metadata client import it from `podcasts/` would have
inverted the layering the move exists to establish. Four import sites and one
test path updated; no behaviour change.

The user agent moved with it and now reads its version from `package.json`. The
string it replaced said `Fermata/0.1` while the package said `0.2.1`, which is
what a hand-maintained version in a second file does given time. MusicBrainz
requires an identifying agent, so on this path it is a policy obligation rather
than only a courtesy. There is still deliberately no contact URL — see the note
in `userAgent.ts`.

`METADATA_MIN_INTERVAL_MS` is 1100, not 1000: the ceiling is enforced against
arrival times on their side, and a client aiming exactly at the line lands over
it whenever the network is kind.

## Acceptance

- **No `fetch`/XHR to an external host under `src/renderer`.** Reviewed — the
  two `fetch` call sites are `DecodedAudioEngine` reading a `fermata://` URL
  and `browserMediaSession` re-addressing artwork as a blob, both local, both
  pre-existing. And now enforced: `fermata/no-renderer-network` bans XHR,
  WebSocket, EventSource and `sendBeacon` outright and `fetch` where the target
  is statically a remote URL. It does not fire on `fetch(url)` with an opaque
  argument, which is stated in the rule's own docblock as a deliberate gap —
  the two legitimate call sites are indistinguishable from a remote fetch at
  the syntax level, and a rule that fired on all of them would be switched off
  within a week. The CSP and the custom protocol are what bound that case at
  runtime; this is the cheap check that fails at review time. Wired through the
  real flat config and tested there, like the path-portability rule.
- **20 concurrent requests, observed spacing asserted.** `rateLimiter.test.ts`
  fires twenty at one per second against an injected clock and asserts release
  times of exactly 0…19000 and a minimum gap of the full interval.
- **Closing the deck cancels in-flight work; open/close/open does not leak or
  double-fetch.** Three tests: a request cancelled while queued never reaches
  `fetch`; a cancelled scope leaves nothing enrolled and the next request runs
  immediately; and the limiter does not hold the interval against a burst that
  was entirely cancelled.
- **Every failure mode is a renderable state.** Nine mapped cases — 404, 410,
  400, 403, 500, 503, 429, 408 and a connect failure — each asserted to come
  back as a `NetFailure` with a message, never as a throw. Plus declined,
  cancelled, timeout and malformed.

Confirmed over real IPC in a scratch instance: `net.cancelScope('tunedeck')`
answers `{ cancelled: 0 }`, and an unknown scope comes back as an
`invalid-request` `FermataError` rather than a silent success.

## Notes for what comes next

- W7-8's cache sits between the client and its callers, not inside it. The
  client knows nothing about TTLs or negative entries by design.
- W7-9 is the first real call site. Its endpoints go through `client.getJson`
  and inherit consent, spacing, retry and cancellation without restating any of
  them.
- W9-5 attaches Discover's catalogue to the same consent key. It will need its
  own scope in `NET_SCOPES` if it wants independent cancellation, and it should
  route through this client rather than `podcasts/service.ts`'s direct `fetch`.
