---
taskId: 01M28SDCQGK4GVHW932D193TTY
title: 'Presence: the Discord RPC client and connection lifecycle behind an interface'
status: done
priority: medium
labels:
  - discord
  - main
  - ipc-socket
workstream: W20
workstreamId: W20-2
order: 19
created: '2026-09-11T17:49:27.663Z'
updated: '2026-09-11T22:38:18.925Z'
---
## Intent

The socket half: a main-process client that speaks Discord's local IPC protocol, behind a
`DiscordClient` interface so `tests/main/` mocks it and no live Discord is ever needed. Owns the
connection lifecycle — connect, set-activity, clear-activity, and a reconnect state machine — plus
the project-level Discord **Application ID** and its static logo asset. No signal mapping and no
settings here (W20-3/W20-4); this card is the client, tested against a fake socket.

## Why main-process, behind an interface

Discord Rich Presence is a **local IPC socket**, not the internet: a named pipe
(`\\?\pipe\discord-ipc-N`) on Windows, a unix socket (`$XDG_RUNTIME_DIR/discord-ipc-N`) on Linux,
with **flatpak** (`.../.flatpak/com.discordapp.Discord/xdg-run/discord-ipc-N`) and **snap**
(`$XDG_RUNTIME_DIR/snap.discord/discord-ipc-N`) variants — probe indices `0..9` and take the first
that answers. The renderer opens no sockets (the invariant), so this lives in `src/main/discord/`,
mirroring `src/main/scrobble/`, behind a `DiscordClient` interface the way `AudioEngine` hides Web
Audio and `CdDrive` hides the ioctl backends — so platform and library difference lives below the
interface and the service (W20-3) is written against the interface, never the socket. See
`[[oscine-discord-presence]]` D31.

## The dependency decision — settle it here

Leading candidate: **`@xhayper/discord-rpc`**, the maintained TS fork (the official `discord-rpc` is
archived), deliberately **pure JS** so it adds no native-ABI addon and does not grow the
`dist:win`/`dist:linux` cross-build problem CLAUDE.md calls out for sharp and node-web-audio-api.
Alternative: hand-roll the handshake — it is ~200 lines of length-prefixed JSON frames
(op 0 handshake with `{ v: 1, client_id }`, op 1 frame for `SET_ACTIVITY`, op 2 close, op 3/4
ping/pong) over the socket, which removes the dependency entirely and keeps the failure domain fully
in-tree. **Pick one in this card and record the reasoning on the card**; do not leave a provider
abstraction with a single implementation as speculative structure — the `DiscordClient` interface
already exists for testability, that is enough.

## Application ID and assets

Register a Discord **Application** once (project-level, not per-user) — its client ID is the
"Playing Oscine" identity and its Art Assets hold the static logo referenced by `largeImageKey` when
album art is off/unavailable (W20-5's fallback). Store the client ID as a constant in
`src/main/discord/` and document the registration + asset-upload step in the card / a comment so it
is reproducible. No secret is involved — presence uses only the public client ID, so nothing goes in
`safeStorage` and nothing ships that needs protecting.

## The lifecycle — availability is first-class (R12)

- **Connect**: probe the socket paths above; on success, handshake. **Discord not installed or not
  running is a normal state, not an error** — return a quiet "unavailable", never throw, never block
  playback (the way R5 treats an unresolved artist).
- **setActivity(activity | null)**: send `SET_ACTIVITY`; `null`/clear sends the clear frame.
- **Reconnect**: tolerate the socket dropping (Discord quit or restarted mid-session) with backoff,
  and reconnect when Discord comes back. Do not spam reconnects — bounded backoff.
- **Rate-limit aware**: Discord throttles presence to ~1 update / 15s; the client must not exceed it
  (the service W20-3 also throttles, but the client is the last line and must tolerate a rejection
  without desyncing its notion of current state).
- **Clear on quit**: presence is cleared on app quit and on stop, so a closed Oscine does not leave
  a stale "Playing" card. Hook `app` quit.

## Files

- `src/main/discord/client.ts` — the `DiscordClient` interface + the real implementation.
- `src/main/discord/socketPaths.ts` — the platform path probe (the one place platform difference
  lives; no path literals leak above the interface — honour `oscine/no-windows-path-literals`).
- Application-ID constant + a fake `DiscordClient` for tests.

## Tests (`tests/main/`, socket mocked)

Connect success handshakes; **Discord absent → quiet unavailable, no throw**; a mid-session socket
drop triggers bounded-backoff reconnect, not a spin; `setActivity(null)` sends a clear; clear-on-quit
fires; a rate-limit rejection does not corrupt the client's current-state view; the path probe picks
the first responding index and covers the flatpak/snap variants.

## Out of scope

No signal→activity mapping and no throttle policy (W20-3). No settings (W20-4). No cover-URL
resolution (W20-5). No presence buttons, join/spectate, or bot features.
