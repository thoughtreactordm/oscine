---
title: Oscine — Remote
created: '2026-10-01T03:42:17.288Z'
updated: '2026-10-01T03:42:17.288Z'
---
Design authority for **W21 — Oscine Remote**. Records decisions **D32** and **D33** and risks
**R13** and **R14**. Read `[[fermata-design]]` for the invariants this stream honours (the renderer
never touches the OS, audio lives in the renderer, the relative-path rule) and D14, which this
stream sits beside rather than inside. `[[oscine-discord-presence]]` is the closest sibling: D31's
reasoning about a consent model chosen by what a mechanism discloses carries over directly.

*Status: draft, 2026-09-30. Cards below are proposed, not yet on the board.*

## What this is

A phone remote for the desktop app. Oscine hosts a small server on the local network; a phone opens
it as an installed PWA and controls playback, and the phone's **native media controls** (lock
screen, notification shade, headset buttons) drive Oscine as well. **Audio always stays on the
desktop.** The phone plays nothing audible; it is a remote, not a second output.

A **post-1.1 follow-up**: it opens Oscine's first *inbound* network surface, adds a main-process
module, a fourth build target and a settings group.

Architecturally it is a **third media-key surface**. Today OS media keys and MPRIS reach playback
through the renderer's `MediaSessionTransport` (`src/renderer/playback/mediaSession.ts`), and
playback state leaves the renderer through the W20-1 `presence.update` signal. The remote reuses both
seams: phone commands enter the same transport the media keys use, and phone state is fanned out
from the same signal Discord consumes. The remote can therefore do nothing the media keys cannot,
plus seek and volume.

**v1 scope**: now playing (title, artist, album, cover), play/pause, next/previous, seek, volume.
**Not v1**: library browsing, queue editing, playlist management. Read-only up-next is an open
question for W21-1.

## D32 — The remote lives in this repo, is served by the app, and is off by default

**The PWA is a fourth build target of the oscine repo, served by the running desktop app over the
LAN. The server is inbound-only, LAN-only, behind its own master toggle (default off), and a phone
gains control only by scanning a pairing QR code on the desktop.**

*In-repo, not a separate project.* The desktop app serves the PWA, so the phone always runs exactly
the client the running Oscine shipped: client and server cannot skew, and a separate repo would
only add a published shared package and the version matrix that comes with it. The wire protocol is
a cross-process contract like any other and lives in `src/shared/remote.ts`, imported by both sides,
under the same rule that puts IPC in `src/shared/ipc.ts`. Layout:

```
src/shared/remote.ts     wire protocol: state snapshot, commands, events, protocol version
src/main/remote/         HTTP(S) + WebSocket server, pairing, CA, mDNS, static serving
src/remote/              the PWA (Vue 3, its own Vite build into out/remote, not an Electron renderer)
tests/remote/            client tests; server tests under tests/main/remote/
```

The PWA imports the token layer from `src/renderer/theme/` so the remote and the desktop look like
the same app, and can mirror the operator's active theme over the wire.

*Consent.* D14 gates **outbound** requests to remote hosts; a listening socket makes none, so the
remote sits outside D14 and does not reopen it. But it is still opt-in and defaults off, for the
D31 reason pointed the other way: what matters is what the mechanism *exposes*, and a listening port
that accepts playback commands is exposure whether or not a byte leaves the LAN. `remote.enabled`
is the master toggle; nothing listens while it is off.

*Server surface rules*, which ship with the server, not after it:

- **The server lives in main.** The renderer never opens a socket (renderer-never-touches-the-OS).
- **No route maps to the filesystem.** Artwork is `/art/<trackId>`, resolved through the library and
  the artwork cache; there is no path parameter anywhere, so the relative-path invariant cannot be
  bypassed from the phone.
- **LAN only.** Connections from non-private source addresses are refused. No UPnP and no port
  mapping, ever.
- **Every control surface is authenticated.** Static PWA assets and the pairing bootstrap are the
  only unauthenticated routes. WebSocket upgrades check `Origin` against the server's own origin
  (blocking cross-site WebSocket hijacking from other pages on the phone) and authenticate in the
  first frame, because browsers cannot set headers on a WebSocket.

*Pairing.* The desktop shows a QR code carrying a **single-use, short-lived token in the URL
fragment** (so it never reaches a server log). The PWA exchanges it for a long-lived per-device
credential held in origin-scoped storage. The desktop lists paired devices and can revoke each one;
pairing attempts are rate-limited.

*Rejected*: (a) a separate repo with a shared package. Version skew between two halves that always
ship together, for no benefit. (b) A cloud relay for access away from home. An outbound service, a
D14 surface and infrastructure to run, all for a non-goal. (c) A native mobile app. Store
distribution, a second toolchain, and a separate project after all. Reconsider only if R13 shows a
PWA cannot hold lock-screen controls. (d) Hosting the server in the renderer. It cannot open
sockets, and must not. (e) Unauthenticated LAN control (the "trust the network" model). Guest Wi-Fi,
shared flats and dorms make "on my network" a weak claim.

*Accepted cost*: Oscine's first inbound surface to document and default off; a fourth build target
in `build`, `typecheck` and CI; pairing state to persist and revoke.

*Revisit when*: away-from-home control becomes a goal (that is a relay or VPN question and a new
decision, not an amendment); or R13's spike shows the PWA cannot hold native controls on one of the
two mobile platforms, at which point (c) is reopened for that platform only.

## D33 — Transport security: a name-constrained local CA and a stable mDNS hostname

**On first enable, Oscine generates a per-install root CA, name-constrained to private address space
and `.local`, and uses it to sign the server certificate for a stable mDNS hostname. The phone
trusts that root once, during pairing. Plain HTTP serves only the bootstrap page.**

*Why HTTPS at all.* Verified 2026-09-30: the Media Session API does **not** require a secure context,
so lock-screen controls work over plain HTTP. HTTPS is needed for the rest of what makes it an app:
service workers and therefore Android's real install (standalone WebAPK rather than a browser
shortcut), `crypto.subtle`, and confidentiality of the pairing credential and commands on networks
the operator does not control.

*The CA.*
- Generated once per install. The key is stored encrypted via Electron `safeStorage`.
- **X.509 Name Constraints** limit the root to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and
  `.local`, so a leaked key cannot mint a certificate for the operator's bank. That Chrome and iOS
  both enforce constraints on a user-installed root is to be **verified in W21-0**, not assumed.
- Server certificates meet Apple's rules, which apply to user-added roots too: RSA ≥ 2048 (or ECDSA
  P-256), SHA-2, the hostname and current IP in SAN, `serverAuth` EKU, **≤ 825 days** validity. The
  server certificate is reissued silently when the LAN IP changes or expiry nears; the root does not
  change, so the phone never re-trusts.
- Certificate generation uses a pure-JS X.509 library (Node's `crypto` parses certificates but cannot
  issue them). **No native addon**; the cross-build problem sharp and node-web-audio-api impose does
  not grow.

*The stable origin.* A PWA's identity is its scheme, host and port: the installed app, its storage
and the device credential are all keyed to it. A URL built on a DHCP address orphans the install the
first time the address changes. So Oscine advertises itself over mDNS as
`oscine-<machine>.local` on a fixed default port (chosen in W21-2, configurable), and that name, not
the IP, is the origin. See R14 for where this is not enough.

*The pairing flow, with the CA folded in.*

1. The desktop shows QR #1: `http://<host>:<port>/setup`. The page offers the CA (a `.mobileconfig`
   on iOS, a `.crt` on Android) with per-platform install steps, and shows the CA fingerprint, which
   the desktop shows too.
2. Once the CA is trusted, the desktop shows QR #2: `https://<host>:<port>/pair#<token>`. The PWA
   installs from this origin.

The HTTP bootstrap is trust-on-first-use, as every LAN pairing is; the fingerprint comparison is
what defends it. After step 2 the HTTP listener serves nothing but `/setup`. A development flag
allows the full control surface over HTTP, for the W21-0 spike and for `npm run dev`; it is never a
setting.

*Rejected*: (a) a self-signed server certificate with click-through. Chrome will not register a
service worker on a page with a certificate error, so it costs the friction of HTTPS and delivers
none of the benefit. (b) A public domain resolving to LAN IPs with a publicly trusted certificate
(Plex's `plex.direct` model). Zero phone setup, but it needs certificate-issuing infrastructure run
indefinitely, publishes every hostname to Certificate Transparency logs, breaks on routers with
DNS-rebinding protection (Pi-hole, OpenWRT, pfSense), and is an outbound service behind D14. (c)
HTTP-only. Viable for the spike, but no Android install and the credential crosses the air in clear.

*Accepted cost*: certificate installation is the worst step of the setup: about six taps on iOS
behind deliberately alarming warnings, and a screen-lock requirement plus a possible persistent
"network may be monitored" notice on Android. It happens once per phone. Firefox for Android ignores
user CAs by default and is not a supported client.

*Revisit when*: W21-0 shows name constraints are not enforced on a supported platform. Then the
default becomes **sign-and-discard**: issue a server certificate for the `.local` name at the full
825 days and destroy the CA key, trading a re-pair every 825 days (and on any hostname change) for
there being no key left to leak. Also revisit if either mobile OS changes how user-installed roots
are trusted.

## The playback signal, widened

`PresenceSignal` (`src/shared/presence.ts`) carries `{ track, positionMs, paused, playing }`,
emitted on transitions plus a 15 s heartbeat (`presenceEmitter.ts`). That is the right cadence for
the remote too: the PWA extrapolates position locally from `positionMs` and receipt time while
playing, the way Discord renders its progress bar, so no per-frame stream is needed
(`[[abortsignal-any-electron]]`). Three gaps, settled in W21-1:

- It lacks **volume** (and shuffle/repeat, if those join v1). Widen the signal or add a sibling
  channel; whichever, the Discord consumer must not start disclosing fields it does not use.
- The emitter must run whenever **either** consumer is enabled, not only when Discord is.
- A **seek** must count as a transition, or the phone's scrubber drifts for up to 15 s.

Commands go main → renderer on a new push channel, typed in `src/shared/ipc.ts`, and land in
`MediaSessionTransport`. Seek and volume are the two commands the OS media keys do not already send.

## The phone side: holding native controls with silent audio

Mobile OSes show lock-screen and notification controls only for a page that is **playing audio**.
The PWA therefore plays a looping, effectively silent audio element, started from the user's
"Connect" tap (autoplay rules require a gesture), and mirrors the desktop into
`navigator.mediaSession`: metadata from the signal, `playbackState`, `setPositionState` from the
extrapolated position, and action handlers that send commands upstream. Artwork is `/art/<trackId>`
on the same origin, which the phone's `MediaImage` accepts. The `oscine://` wall MPRIS hit
(`browserMediaSession.ts`) does not apply here.

This is the least certain part of the stream. See R13.

## R13 — Mobile background audio *(high, platform, unverified)*

The native-controls requirement rests on the phone keeping a silent loop alive in the background.
Android Chrome is expected to cooperate, with a media notification for as long as the loop plays.
iOS is not: it suspends background audio in standalone web apps inconsistently between releases,
and its Media Session support in installed PWAs has a history of bugs. Unknowns to settle:

- whether the session survives screen lock, app switching and a long idle period on each OS;
- whether a desktop **pause** can be shown as paused on the phone while the loop keeps running, or
  whether pausing the loop is required and lets the OS reclaim the session;
- whether digital silence is optimised away and a near-silent signal is needed instead;
- **audio focus**: the loop takes focus, so the remote will pause the operator's other phone audio
  (and be interrupted by it); plus the battery cost of an audio session held open for hours.

**Mitigation**: W21-0 is a spike on real iOS and Android devices **before** any other card starts,
over plain HTTP since Media Session needs no certificate. If iOS cannot hold the session, the remote
still works as an in-app control surface there, and D32(c) is reopened for iOS only. The stream does
not paper over a broken lock screen.

## R14 — LAN reachability and origin stability *(medium, platform)*

A server on the LAN is not the same as a server the phone can reach. Expected failure modes:

- **`.local` on Android.** iOS resolves mDNS natively; Android's resolution has historically been
  unreliable and must be checked across versions in W21-0. The fallback is a DHCP reservation, and
  the setup page says so.
- **Firewalls.** The first listen triggers the Windows Defender Firewall prompt; Linux distributions
  running `ufw` or `firewalld` block silently. Setup must detect "listening but unreachable" and say
  why, not hang.
- **Client isolation.** Guest and some mesh networks stop devices from seeing each other. This is
  undetectable from the desktop, so the setup page names it.
- **A VPN on the phone** may route LAN traffic away.

**Mitigation**: reachability is a first-class state, as R12 made Discord's absence one. The settings
pane shows the advertised hostname, port and IP, the listener state, and a self-check (resolving its
own mDNS name), and the setup page diagnoses the common failures rather than showing a spinner.

## The settings surface

`category: 'network'`, `portable: false` descriptors in `src/shared/settings/`:

- `remote.enabled`: master toggle, **default `false`**. Nothing listens while it is off.
- `remote.port`: fixed default, configurable.
- `remote.hostname`: the mDNS name, default derived from the machine name.
- Paired devices: internal state with a list and per-device revoke in the pane, not a descriptor.
- The pairing action (shows QR #1 / #2) and the reachability readout.

## The cards *(proposed)*

- **W21-0**: spike. Silent-audio Media Session on real iOS and Android over HTTP; Android `.local`
  resolution; name-constraint enforcement on a user-installed root. Gates everything below.
- **W21-1**: the wire protocol in `src/shared/remote.ts` (state snapshot, commands, events,
  protocol version), the widened playback signal, and the main → renderer command channel into
  `MediaSessionTransport`.
- **W21-2**: the main-process server: HTTP/HTTPS + WebSocket, static serving of the PWA build,
  `/art/<trackId>`, LAN-only admission, `Origin` checks, the `remote.*` settings and lifecycle.
- **W21-3**: pairing: QR, single-use token, device credentials, device list and revoke, rate limits.
- **W21-4**: transport security: the name-constrained CA, server certificate issuance and rotation,
  `safeStorage`, mDNS advertisement, the `/setup` bootstrap page.
- **W21-5**: the PWA: Vite build target, now-playing and transport UI on the token layer, the
  silent-audio Media Session bridge, install manifest and service worker.
- **W21-6**: integration: `build`/`typecheck`/CI wiring for the fourth target, the reachability
  self-check, and the onboarding entry.

## Does not

Does NOT play audio on the phone. Does NOT reach the internet: no relay, no UPnP, no port mapping,
no public certificate. Does NOT reopen D14. Does NOT serve any file by path. Does NOT listen while
disabled. Does NOT browse or edit the library in v1. Does NOT add a native addon.
