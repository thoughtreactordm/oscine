---
taskId: 01KYT8HF61YMV4Z7FW79HWWP7Y
title: 'OS media integration: SMTC, MPRIS and hardware media keys'
status: done
priority: medium
labels:
  - M5
  - audio
  - platform
  - cross-platform
  - media-session
workstream: W3
workstreamId: W3-10
effort: high
order: 4
created: '2026-07-30T19:38:07.936Z'
updated: '2026-07-31T19:17:34.313Z'
---
Make the OS recognise Fermata as the machine's music player: the Windows SMTC now-playing card, the Linux MPRIS client that GNOME/KDE surface in their media widgets, and hardware media keys reaching the transport in both places.

**Implemented in `f583d6a`.** Linux verified end to end against the decoded path; Windows remains hand-verification. The three unknowns are settled below, and two came back against this card's assumptions — read those before touching the code.

## Standing on nothing

The design document does not mention media keys, MPRIS, SMTC, D-Bus, system tray, global shortcuts or desktop entries anywhere. This is genuinely new surface rather than a D-number being reopened, and it conflicts with no settled decision. It does depend on one — see the next section, which is the whole reason this card is not a two-hour job.

## Mechanism — what we do and do not write

We write no WinRT and no D-Bus. Chromium already implements both backends and drives them from a single web API:

- **Windows** — `ISystemMediaTransportControls`. The card on the volume flyout, plus hardware key delivery.
- **Linux** — `org.mpris.MediaPlayer2` on the session bus. How every modern DE both displays a player and routes media keys to it.

Both are fed by `navigator.mediaSession` in the renderer. Electron inherits the lot.

## The blocker this card exists to solve

**Chromium's media session is populated by `HTMLMediaElement` players. Web Audio is not a player.**

`DecodedAudioEngine` — the D2 path, which is to say the normal path — schedules `AudioBufferSourceNode`s. As far as Chromium is concerned Fermata plays nothing. `setActionHandler` registers successfully and never fires, no SMTC card appears, and no MPRIS bus name is published.

`StreamingAudioEngine` *would* register, because W3-5's fallback is a real `HTMLAudioElement` through `MediaElementAudioSourceNode`. That is worse than silence: OS controls that materialise only for tracks the R1 guard sent to streaming, and vanish for everything else. An intermittent integration reads as a bug, not a missing feature.

The fix is the standard one for Web Audio applications: a **silent anchor `<audio>` element** that plays exactly when the engine plays. The constraints are not obvious and all three are load-bearing:

- It must carry a real audio track. Silent PCM, not an empty `src`.
- It must not be `muted` and must have `volume > 0`. Chromium's effective-volume test is how it decides a player wants audio focus; a muted element is ignored outright.
- Duration must clear Chromium's significant-playback threshold (about five seconds) and it must loop. Shorter media is treated as a sound effect and opens no session.

All three held up. Built as a ten-second 8 kHz mono WAV blob rather than a data URL — same bytes without base64's third, and no 80 kB literal in the bundle. 8-bit PCM is unsigned, so the silence fill is `0x80`; a zero fill is the negative rail held flat, not silence.

## What was built

- `src/renderer/playback/mediaSession.ts` — the rules: status mapping, metadata construction, position-state policy, the anchor lifecycle, the surface adapter. DOM-free and testable under plain Node.
- `src/renderer/playback/browserMediaSession.ts` — the DOM: the silent WAV, the anchor element, `navigator.mediaSession`, blob artwork.
- The binding hangs off `createPlaybackController` behind an injected `createMediaSession`, not off a panel — the OS card is a second view onto exactly the state the transport reads, and living there means `dispose()` already covers it. `stores/playback.ts` bolts on the real platform.
- `resume()` / `pause()` added alongside `toggle()` on the controller. Idempotent intents, never a flip: with a track on the R1 streaming fallback its real media element is a session participant alongside the anchor, so one OS press can reach playback twice. Two resumes settle on playing; two toggles cancel out.
- `app.setAppUserModelId('dev.fermata.app')` before window creation, matching `appId`.
- `electron-builder.yml` gains the Linux desktop entry with `StartupWMClass: Fermata`.
- `scripts/media-session-probe.mjs` / `npm run probe:media-session` — a throwaway Electron app in its own user-data directory that reproduces the mechanism and reports what Chromium actually publishes. Re-run it when Electron is upgraded.

## Unknowns — settled by measurement, Electron 43, Wayland

**1. Artwork over `fermata://` — NO.** The assumption in this card was wrong. Chromium rejects the privileged scheme outright:

```
MediaImage src can only be of http/https/data/blob scheme: fermata://artwork/probe/large
```

and publishes no `mpris:artUrl` at all. Re-fetched into a blob the same bytes are accepted, and Chromium materialises them as the temp file MPRIS needs (`mpris:artUrl file:///tmp/.org.chromium.Chromium.XXXXXX`, a real PNG). Only `MediaImage` is fussy — `fetch` reaches the scheme fine — so the fix costs one local request per cover. The resolution is cached against the routes that produced it, because every track on an album carries the same two routes and re-reading them would blink the cover out of the card at every boundary.

Also worth knowing: Chromium normalises the image to its own desired size (150×150 observed on Linux), so advertising both variants costs nothing and buys the larger source SMTC wants.

**2. Bus name — `org.mpris.MediaPlayer2.chromium.instance<pid>`.** Not derived from the product name. Unchanged by `setAppUserModelId` *and* unchanged by `app.setName`, both measured. So `app.setName` is deliberately not called: it would buy nothing and would move `app.getPath('userData')`, relocating the library database and artwork cache (`db/location.ts`). **Linux identity comes from the desktop entry and `StartupWMClass`, not from the bus name** — this card's acceptance wording ("publishes an MPRIS bus name identifying Fermata") is not achievable and should be read as the desktop-entry half.

**3. Feature switch — not needed.** MPRIS publishes unaided on Electron 43. No `enable-features` added.

## A fourth thing, found by running it

**Chromium never withdraws an MPRIS bus name once it has one, and reports the last player state it *observed*.** Releasing the anchor when playback stops therefore does not remove the OS card — it freezes it, and the renderer has no way to know when the observation landed. Measured: released while playing, MPRIS was stuck advertising `PlaybackStatus = Playing` under the document title *for the rest of the process's life*, a phantom card no later transport action could clear. Releasing from the element's `pause` handler only sometimes won the race.

So stopping now **pauses** the anchor and leaves it, and leaves the last track's metadata standing. Blanking the metadata does not blank the card either — it replaces a real track with the document title and the anchor's own ten-second duration. Freezing on the last track, paused, is what every other player shows and the closest the platform gets to "nothing is playing". The element is released for real only in `dispose()`.

The acceptance item "no session is published while nothing is playing" holds in the sense that matters and can be met: **no bus name exists until the first playback** (verified). After that, withdrawal is not ours to do.

## Verification — Linux, done

Wayland, dev build, decoded path (`prefetchStatus: ready`, no streaming fallback), real 2960-track library:

| | app | OS |
|---|---|---|
| before any playback | idle | **no MPRIS name** |
| play | playing | `Playing`, correct title/artist/album, `mpris:artUrl` real file, `mpris:length` 272373333 |
| OS pause | paused | `Paused` |
| OS play | playing | `Playing` |
| OS next | `(intro)` | `(intro)` |
| OS previous | `$avior Self` | `$avior Self` |
| OS seek → 90 s | 91.8 | 92.02 |
| natural track boundary | `(intro)` | `(intro)`, `Playing` |
| stop | idle | `Paused`, card frozen on the last track with its real metadata |

Console clean: no `[media-session]` lines, no `MediaImage` rejection, no unhandled rejections. The anchor is off-DOM (`document.querySelectorAll("audio,video").length === 0`) and outside the audio graph, so it never reaches `DecodedBufferLedger` and never appears in `[audio] R1` diagnostics.

Automated: 38 tests in `tests/renderer/playback/mediaSession.test.ts` over the status mapping, metadata construction, position-state triggers and seek detection, the anchor lifecycle, the artwork cache's reuse/staleness/revocation, and the pause-arrives-twice case; plus controller tests for `resume`/`pause` idempotence and binding disposal. Full repository gate green.

## Still outstanding

- **Windows.** Everything Windows-side is unverified: the volume-flyout card, hardware keys, the AppUserModelID, `setThumbarButtons` (not implemented — optional, left out). Needs the packaged NSIS build.
- **Packaged Linux.** The desktop-entry half only exists in the AppImage, so the DE application name and icon are unverified. Re-run the table above against the AppImage.
- Hardware media *keys* specifically were exercised through `playerctl`, which is the same D-Bus path the DE uses for keys, but not by physically pressing a key.

## Non-goals

- No `globalShortcut`. It grabs media keys **system-wide**, so Fermata would steal play/pause from every other player whether focused or not, and it does nothing under Wayland. MPRIS is not the elegant option on Linux, it is the only one that works on a current desktop. Revisit only if MPRIS proves unavailable on a target DE.
- No system tray, no minimise-to-tray, no taskbar progress. Separate concerns.
- No macOS. D10 stands.
- No last.fm or scrobbling. Unrelated surface that this card's metadata plumbing will look like an invitation to add.
