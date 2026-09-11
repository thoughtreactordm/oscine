---
taskId: 01M28SEX6184ZE1T1SGX28N1VF
title: 'Presence: the activity mapping and the presence service'
status: in-review
priority: medium
labels:
  - discord
  - main
workstream: W20
workstreamId: W20-4
dependsOn:
  - 01M28SCEACEQQKQG0HKC4VAM91
  - 01M28SDCQGK4GVHW932D193TTY
order: 12
created: '2026-09-11T17:50:17.280Z'
updated: '2026-09-11T20:15:21.372Z'
---
## Intent

The brain that joins the two halves: a **pure** `buildActivity(settings, signal) → DiscordActivity |
null` mapping, and the **service** that owns the throttle/heartbeat/clear lifecycle — consuming
W20-1's `PresenceSignal` off the `presence.update` channel and driving W20-2's `DiscordClient`. Wired
into `src/main/index.ts` beside the scrobble now-playing announcer, since presence hangs off the same
moment. See `[[oscine-discord-presence]]`.

## The pure mapping — testable without a socket

`src/main/discord/activity.ts` — a pure function, the same property `equalPower.ts`,
`gaplessTiming.ts` and `normalization.ts` have, so it is unit-tested with no Web Audio and no Discord.
It maps `(DiscordSettings, PresenceSignal)` to a Discord activity object (or `null` = clear presence):

- `discord.display`:
  - `title-artist` → `details` = title, `state` = artist.
  - `title-only` → `details` = title, no `state`.
  - `generic` → a fixed "Listening to music", no track detail. This is the privacy floor and must
    not leak title/artist anywhere in the payload.
- `discord.showTimestamp`: when on and `playing && !paused`, compute `startTimestamp` /
  `endTimestamp` from `positionMs` and `durationMs` (`start = now - positionMs`, `end = start +
  durationMs`), so Discord renders the progress bar. When off, or paused, omit both — a running
  timestamp on a paused track is a lie.
- `discord.whenPaused`: `paused` → either `null` (hide) or an activity with a "Paused" indicator and
  no timestamps, per the setting.
- `playing === false` / `track === null` → `null` (clear).
- `largeImageKey`: in this card, always the static logo asset key (W20-2). The cover-URL path is
  W20-5, which slots a resolved URL in here behind the same field — leave the seam, do not build the
  lookup.
- `enabled === false` → `null`.

Keep it total and side-effect-free: same inputs, same output; no clock read *inside* the pure
function beyond a `now` passed in (so timestamp math is deterministic in tests).

## The service — throttle, dedupe, clear

`src/main/discord/service.ts` — subscribes to the `presence.update` sink W20-1 stubbed, calls
`buildActivity`, and pushes to the client. It owns:

- **Re-throttle to Discord's cap** (~1/15s). W20-1's emitter already debounces renderer-side; the
  service is the second line, coalescing anything that still arrives too fast so the client (W20-2)
  is never asked to exceed the rate limit.
- **Dedupe identical activities** — if the newly-built activity equals the last one sent, do not
  resend. A steady heartbeat on an unchanged track should refresh at most what the progress bar
  needs, not spam `SET_ACTIVITY`.
- **Clear** on stop, on `enabled` flipping off, on app quit (coordinate with W20-2's quit hook), and
  — per `whenPaused` — on pause.
- **React to settings changes live**: settings broadcast over IPC (W8), so flipping `display` or
  `enabled` re-derives and pushes immediately, without waiting for the next track.

Construct it in `src/main/index.ts` with the `DiscordClient` and the settings accessor injected (the
`TagWritebackService` injectable-deps shape is the model), so tests drive it with a fake client and
fake settings.

## Files

- `src/main/discord/activity.ts` — the pure mapping.
- `src/main/discord/service.ts` — the lifecycle, injectable deps.
- `src/main/index.ts` — construction + wiring to the `presence.update` sink and the client.

## Tests (`tests/main/`)

Mapping: each `display` mode (and that `generic` leaks no title/artist); timestamp math for playing;
timestamps omitted when paused or when `showTimestamp` off; `whenPaused` hide vs paused-indicator;
`playing:false`/`enabled:false`/`track:null` → clear. Service: identical activity is not resent
(dedupe); a burst is coalesced under the rate cap; a live `enabled`→off clears immediately; pause
clears or shows "Paused" per setting; quit clears. All with a fake `DiscordClient`.

## Out of scope

No socket implementation (W20-2). No settings descriptors (W20-4). No cover-URL resolution (W20-5) —
`largeImageKey` is the static logo here, with the seam left for the URL.
