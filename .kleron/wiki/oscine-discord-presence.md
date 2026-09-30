---
title: Oscine — Discord Presence
created: '2026-09-11T17:48:33.664Z'
updated: '2026-09-11T17:48:33.664Z'
---
Design authority for **W20 — Discord Presence**. Records decision **D31** and risk **R12**. Read
`[[fermata-design]]` for the invariants this stream honours (renderer-never-touches-the-OS, D14
consent, the relative-path rule) and the D14/D19 consent lineage it reasons from.

## What this is

Broadcasting the currently-playing track to Discord as Rich Presence, opt-in, with the operator in
control of what is disclosed. A **post-1.0 follow-up** like `[[oscine-tag-writeback]]`, lyrics (W17),
CD ripping (W18) and the equalizer (W19): it opens a new outbound activity channel to a third party
and adds a main-process module and a settings group, so it lands after the 1.0 line, not inside it.

Architecturally it is the scrobble now-playing announcer's sibling. Discord Rich Presence talks to
the Discord **desktop client** over a **local IPC socket** — a named pipe (`\\?\pipe\discord-ipc-N`)
on Windows, a unix socket (`$XDG_RUNTIME_DIR/discord-ipc-N`, plus flatpak and snap path variants) on
Linux. The socket lives in the main process behind a `DiscordClient` interface, in a new
`src/main/discord/` module that mirrors `src/main/scrobble/`, and presence hangs off the same
now-playing moment that already feeds scrobbling.

## D31 — Presence is a second consumer of the now-playing signal, opt-in by intent

**The Discord socket is local IPC, not the internet, so presence sits *outside* D14 — but the
stream is still opt-in and defaults off, because presence continuously broadcasts listening activity
to a third party. Only album-art resolution reaches the network, and that part alone is inside D14's
gate.**

Two consent questions must not be conflated. D14 gates *outbound network requests* to remote hosts;
the Discord socket makes none — no byte leaves the machine to publish "Playing Oscine", the Discord
client does that itself over the operator's already-authenticated Discord connection. So requiring
D14 for presence would be miscategorising a local IPC write as a network fetch. But a checkbox that
says "broadcast what I'm listening to on Discord" answers the *real* consent question — continuous
third-party disclosure — more honestly than the socket's locality does, so presence is opt-in on its
own master toggle, default off. This is the same shape as D19 (scrobbling sits outside D14 because
signing into your own account is stronger consent than a checkbox) reasoned in the other direction:
the mechanism's consent model is chosen by what it actually discloses, not by whether a socket
happens to be local.

The **richer signal** is the one genuinely new piece of plumbing. `NowPlayingPayload`
(`src/shared/scrobble.ts`) is thin on purpose — artist/title/album/albumArtist/duration, no position
and no paused state, because scrobbling does not need them. Rich Presence renders a progress bar from
`startTimestamp`/`endTimestamp` and must visibly pause or clear on pause, so the stream adds a
throttled `presence.update` channel (renderer→main) carrying `{ track, positionMs, paused, playing }`,
debounced to state-transitions plus a heartbeat, never per-frame.

The **RPC client is pure JS by choice** (`@xhayper/discord-rpc`, the maintained fork; the official
`discord-rpc` is archived) — no native addon, so the `dist:win`/`dist:linux` cross-build problem
that sharp and node-web-audio-api impose does not grow. Hand-rolling the ~200-line JSON-over-socket
handshake is the alternative, settled in W20-2.

*Rejected*: (a) putting the socket in the renderer — violates the renderer-never-touches-the-OS
invariant, and the renderer has no sockets. (b) Requiring D14 for the whole feature — miscategorises
a local IPC write, and would leave the plain title/artist presence (which reaches no network at all)
needlessly gated. (c) Reusing `NowPlayingPayload` unchanged — it carries no position or paused state,
so the progress bar and pause behaviour would be impossible. (d) A per-frame position stream — floods
IPC and starves the renderer (`[[abortsignal-any-electron]]`), and Discord rate-limits to ~1/15s
anyway. (e) A second native-ABI RPC addon — a third cross-build liability for a JSON-over-socket
protocol that needs none.

*Accepted cost*: a new throttled IPC channel and a new outbound-disclosure surface to document and
default-off; a project-level Discord Application ID to register and hold static assets; and the
honesty tax on album art below.

*Revisit when*: Discord changes the presence transport or deprecates the IPC protocol; or a second
"broadcast what I'm playing" target appears (e.g. a generic MPRIS-style presence) whose shape
`DiscordClient` cannot express without a special case.

## Album art — in scope from the start, and its constraint is load-bearing

Discord's `largeImageKey` renders **either** a static asset uploaded to the Discord application
**or** a public URL its media proxy can fetch. It **cannot** render a local file or an `oscine://`
URL — the identical wall the MPRIS work hit (`MediaImage refuses oscine://`, documented at
`browserMediaSession.ts`). So "include album art" honestly means "resolve a *public* cover URL",
which is a network + privacy feature and is therefore the one part of the stream inside D14's gate.

Three tiers, and only the first two are ever available:

1. **A static Oscine logo** as the large image — off-the-shelf, zero network, zero privacy cost. The
   default, and the fallback whenever consent is off, the album-art toggle is off, or no cover
   resolves.
2. **The canonical release cover**, resolved to a public URL via Cover Art Archive / MusicBrainz
   through W7's `NetClient`, cache and consent gate. Gated on D14, re-checked live per call.
3. **The operator's embedded or local artwork** — **out of scope, permanently in v1.** Publishing it
   would require hosting it somewhere public; that is a privacy problem and a hosting problem this
   stream will not take on. Tier 2 can therefore only ever show the *canonical release* cover, which
   the pane must not misrepresent as the operator's own art.

## The settings surface

`category: 'network'`, `portable: false` descriptors in `src/shared/settings/`, so the UI generates
itself and main resolves them before the window opens:

- `discord.enabled` — master toggle, **default `false`**.
- `discord.display` — select: *Title & artist* / *Title only* / generic *"Listening to music"*. The
  privacy dial over how much identifying detail is broadcast.
- `discord.statusTemplate` — free-text template for the compact status line, **default `{title}`**
  (so the line is unchanged out of the box). See below.
- `discord.showAlbumArt` — toggle, **default `false`**, **D14-gated** (disabled/annotated when
  consent is off, exactly as other network-dependent settings behave), with help text stating it
  performs an online cover lookup.
- `discord.showTimestamp` — toggle for the progress bar.
- `discord.whenPaused` — select: *Hide presence* vs *Show "Paused"*.

Surfaced in `[[oscine-onboarding]]`'s Network step alongside scrobbling, since it is another
opt-in third-party disclosure.

**The templated status line (W20-6).** Discord's `status_display_type` (discord-api-docs#7674) can
only *point* the compact "Listening to X" line at an existing activity field — `name`, `state`, or
`details` — so it cannot carry arbitrary templated text on its own. W20-4 already points it at
`details`; W20-6 makes `details` the render target of `discord.statusTemplate`, so the operator's
template reaches the status line through that same seam rather than through a field Discord does not
have. The renderer (`src/main/discord/statusLine.ts`, pure and unit-tested beside `buildActivity`)
substitutes `{title}`/`{artist}`/`{album}`/`{albumArtist}` from the `PresenceTrack`, strips unknown
tokens, collapses the punctuation a missing field strands (a leading dash, a doubled `— —`, an empty
`()`), never renders blank (an all-empty template falls back to the title), and caps at Discord's
128-char field limit. The **privacy floor holds**: `generic` mode ignores the template entirely and
keeps the app-name status line, so no token can leak title or artist at the level that promised to
name nothing — the template is meaningful only in the `title-*` modes. This is a mapping change, not
a new consent surface: it templates a field already broadcast, reaches no network, and default
`{title}` reproduces the pre-W20-6 line exactly.

## R12 — Discord IPC availability & rate-limits *(medium, platform)*

The Discord desktop client may not be installed or running (a normal state, not an error), it may
restart mid-session, and the presence API is rate-limited to roughly one update per 15 seconds. A
naive implementation throws on a missing socket, spams reconnects, or trips the rate limit and gets
throttled or disconnected.

**Mitigation**: availability is a **first-class state** — Discord-absent is quiet and expected, the
way R5 treats an unresolved artist — so the client never throws on a missing socket and never blocks
playback. A reconnect state machine tolerates Discord not running, Discord restarting, and app quit
(presence is cleared on stop and on quit). The renderer emitter debounces to transitions plus a
heartbeat and the service re-throttles to Discord's cap and dedupes identical activities, so a
shuffle-heavy session cannot saturate the API. The reconnect and throttle ship **with** the
mechanism, not after it — the same discipline R1 established for the decode-memory guard.

## The cards

- **W20-1** — the shared playback signal and the throttled `presence.update` channel (foundation).
- **W20-2** — the Discord RPC client and connection lifecycle behind the `DiscordClient` interface.
- **W20-3** — the pure `buildActivity(settings, signal)` mapping and the presence service.
- **W20-4** — the `discord.*` settings descriptors, generated UI, and the onboarding Network step.
- **W20-5** — public cover-URL resolution behind the D14 gate, feeding `largeImageKey`.
- **W20-6** — the operator-templated status line: `discord.statusTemplate` + the pure `renderStatusLine` token renderer feeding `details`.

## Does not

Does NOT reopen D7 or D14. Does NOT write anything to any file. Does NOT publish the operator's
embedded or local artwork. Does NOT add a second native-ABI addon. Does NOT broadcast while disabled
(or, per setting, while paused). Does NOT integrate Discord beyond presence — no presence buttons,
no join/spectate, no bot.
