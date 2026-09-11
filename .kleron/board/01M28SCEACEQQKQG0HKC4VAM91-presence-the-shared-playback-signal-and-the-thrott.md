---
taskId: 01M28SCEACEQQKQG0HKC4VAM91
title: 'Presence: the shared playback signal and the throttled presence.update channel'
status: in-review
priority: medium
labels:
  - discord
  - shared
  - ipc
workstream: W20
workstreamId: W20-1
order: 10
created: '2026-09-11T17:48:56.523Z'
updated: '2026-09-11T19:30:21.427Z'
---
## Intent

The foundation card: the richer now-playing signal presence needs, and the throttled channel that
carries it renderer→main. No Discord client, no settings, no mapping — those are W20-2/3/4. This is
the cross-process contract every other card imports, so it goes in `src/shared` (the only
cross-process surface, per the convention).

## Why a new signal at all

`NowPlayingPayload` (`src/shared/scrobble.ts`) is deliberately thin — artist/title/album/albumArtist/
duration — because scrobbling needs nothing more. Rich Presence needs two things it does not carry:
**playback position** (to render the progress bar from `startTimestamp`/`endTimestamp`) and **paused
state** (so presence visibly pauses or clears). Do not widen `NowPlayingPayload` to bolt these on —
scrobbling must not start carrying position, and the two consumers want different cadences. A
separate signal is the correct seam. See `[[oscine-discord-presence]]` D31.

## The signal

`src/shared/presence.ts` (new) — the transport type, e.g.:

```
PresenceSignal {
  track: { title; artist; album?; albumArtist?; durationMs } | null  // null = nothing playing
  positionMs: number
  paused: boolean
  playing: boolean            // false when stopped/idle → main clears presence
}
```

Keep it a plain data shape with no Discord vocabulary in it — the mapping to a Discord activity is
W20-3's job and stays main-side. `track: null` / `playing: false` is the explicit "clear presence"
state, not an omission.

## The channel

`src/shared/ipc.ts` — add `presence.update` (renderer→main, fire-and-forget; no response). Note the
registry completeness check (`src/main/ipc/registry.ts`): a channel declared in shared and never
registered fails at startup, so land both halves together. The main handler in this card can be a
thin sink that just forwards to a stub the service (W20-3) replaces — the point of this card is the
contract and the emitter, not the consumer.

## The emitter — throttle is the whole point

A small renderer-side emitter (a composable or a slice off `src/renderer/stores/playback.ts`, whose
`currentTime`/`duration`/`paused` are already reactive — the same fields `SeekBar.vue` binds).
**Never emit per-frame or per-`timeupdate`.** `TIME_UPDATE_MS` is 250 ms
(`src/renderer/audio/DecodedAudioEngine.ts`); forwarding that to IPC is exactly the flood that starves
the renderer (`[[abortsignal-any-electron]]`), and Discord rate-limits presence to ~1/15s regardless.

So emit on **state transitions** — play, pause, track change, and a seek (position jump beyond a
small tolerance, since a steadily-advancing clock is *not* a transition and needs no update) — plus a
low-frequency **heartbeat** (~15s) so a long unpaused track keeps a live progress bar. Nothing else.
The heartbeat must stop when idle/stopped. Gate the emitter on `discord.enabled` so a disabled
feature emits nothing at all (read the setting; W20-4 defines it — until then, behind a constant is
fine, but leave the seam).

## Files

- `src/shared/presence.ts` — the signal type.
- `src/shared/ipc.ts` — `presence.update` + registry entry.
- `src/main/ipc/` — a thin registered handler (stub sink for now).
- `src/renderer/**` — the emitter off the playback store.

## Tests

- `tests/renderer/`: per-frame/`timeupdate` ticks do **not** each emit (debounce collapses them); a
  play/pause/track-change emits immediately; a backward seek emits; steady advance without a jump
  does not emit between heartbeats; the heartbeat fires on a long unpaused track and stops when
  stopped; `enabled=false` emits nothing.
- `tests/main/`: the channel is registered (registry completeness holds); the handler tolerates a
  `track: null` signal.

## Out of scope

No Discord socket or client (W20-2). No activity mapping or service lifecycle (W20-3). No settings
descriptors (W20-4). No cover art (W20-5).
