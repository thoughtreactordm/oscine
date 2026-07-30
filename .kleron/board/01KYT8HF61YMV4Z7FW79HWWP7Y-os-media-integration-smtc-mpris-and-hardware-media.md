---
taskId: 01KYT8HF61YMV4Z7FW79HWWP7Y
title: 'OS media integration: SMTC, MPRIS and hardware media keys'
status: todo
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
order: 6
created: '2026-07-30T19:38:07.936Z'
updated: '2026-07-30T19:38:07.936Z'
---
Make the OS recognise Fermata as the machine's music player: the Windows SMTC now-playing card, the Linux MPRIS client that GNOME/KDE surface in their media widgets, and hardware media keys reaching the transport in both places.

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

A ten-second silent WAV as a data URL is a few hundred bytes. This is OS presentation, not audio output, so it lives in its own module rather than behind `AudioEngine` — the interface stays free of Web Audio types and gains nothing here.

## Scope

**Renderer — a media session service, bound to the playback store, not to a panel.** Panels are islands and this is a second view onto the same state the transport already reads. Suggested home is `src/renderer/playback/mediaSession.ts`, alongside the scheduler and controller.

- Own the anchor element's lifecycle. It plays when `status === 'playing'` and pauses otherwise, and it is created lazily so an idle Fermata claims no audio focus and publishes no bus name.
- Set `MediaMetadata` on `nowPlaying` change. Artwork is already solved: `Track.artwork.large` is a `fermata://artwork/<hash>` URL and `registerTrackScheme` already declares the scheme `standard`, `secure`, `supportFetchAPI` and `corsEnabled`, which is what Chromium needs to fetch it. Advertise several sizes; SMTC wants something reasonably large.
- Mirror `status` onto `playbackState`, mapping `idle`/`loading` to `none` and `ready`/`ended` deliberately rather than by accident.
- Call `setPositionState` on load, seek, and play/pause **only**. Chromium extrapolates position between updates, so driving it from `timeupdate` burns cycles and makes the OS scrubber jitter against its own interpolation.
- Register handlers for `play`, `pause`, `previoustrack`, `nexttrack`, `stop` and `seekto`, routed to the existing controller methods. `seekto` is what makes the OS scrubber draggable. `seekbackward`/`seekforward` give the ±10 s buttons.
- Register every handler we intend to honour. An unregistered action falls through to Chromium's default handling of the anchor element, which would pause silence and diverge the OS state from the real one.

**Main.**

- `app.setAppUserModelId('dev.fermata.app')` before window creation. Without it Windows labels the SMTC card "Electron" and shows the wrong icon.
- Determine whether Electron 43 needs `enable-features=MediaSessionService` and/or `HardwareMediaKeyHandling` appended for the Linux `SystemMediaControls` path. Settle this by observation, not by copying a switch from a forum post — an unnecessary switch is a liability.
- Optional and cheap: `win.setThumbarButtons()` for prev/play/next on the Windows taskbar thumbnail. Separate mechanism from SMTC.

**Packaging — `electron-builder.yml`, W6's file.** Currently only `category: AudioVideo`. The DE needs a real desktop entry to associate the MPRIS client with an app identity:

```yaml
linux:
  desktop:
    entry:
      Categories: AudioVideo;Audio;Player;
      StartupWMClass: Fermata
      MimeType: audio/flac;audio/mpeg;audio/x-vorbis+ogg;audio/mp4;audio/x-wav;
```

`StartupWMClass` is the easily-missed one — it is how the shell matches the D-Bus client to the window and therefore to a name and icon. Kept on this card rather than carved into W6 because the identity half of the acceptance cannot be verified without it.

## Interactions worth designing for, not discovering

- **Two media elements at once.** When a track is on the R1 streaming fallback, the real element and the anchor are both session participants in the same frame. An OS pause may then both invoke our handler and act on the streaming element directly, double-toggling. Decide the policy — most likely suppress the anchor while streaming owns the session — and test the transition in both directions.
- **Play arriving without a user gesture.** `AudioEngine.play()` is already async because the device may need resuming, and Chromium's autoplay policy applies inside Electron. A media key pressed before any click in the window is the cold-start case; it should degrade deterministically rather than throw an unhandled rejection.
- **R1 accounting.** The anchor's few hundred bytes are noise, but it must not enter the `DecodedBufferLedger` and must not appear in the `[audio] R1` diagnostic lines, which are milestone evidence on three closed cards.
- **Session teardown.** If the anchor stalls or ends, the session disappears mid-track. Looping must be robust, and `dispose()` must release it.

## Unknowns to settle during the work

Named here so they are answered rather than assumed:

1. Whether Chromium can resolve a `fermata://` artwork URL for SMTC and for MPRIS `mpris:artUrl` — the latter requires Chromium to materialise the image as a file. If not, fall back to a `blob:` or `data:` URL built in the renderer.
2. What bus name Electron actually publishes. Chromium derives it from its product name; whether `app.setName` influences it is worth checking rather than assuming it reads "fermata".
3. Whether the Linux path needs a feature switch on Electron 43, per above.

## Acceptance

- Both platforms, on the **decoded** path — not only on streaming fallback — show a now-playing surface carrying the correct title, artist, album and cover art, and it updates at every track transition including gapless and crossfade boundaries.
- Hardware play/pause, next and previous reach the transport and the app state and the OS state agree afterwards, including after a skip initiated from the OS side.
- The OS scrubber shows correct position and duration, and dragging it seeks.
- Linux publishes an MPRIS bus name identifying Fermata, and the DE shows the correct application name and icon from the packaged build.
- No session is published while nothing is playing.
- Pausing from the OS while a track is on the streaming fallback pauses once, not twice.
- Console stays clean, per the standard the M1 and M2 gates hold.

## Non-goals

- No `globalShortcut`. It grabs media keys **system-wide**, so Fermata would steal play/pause from every other player whether focused or not, and it does nothing under Wayland. MPRIS is not the elegant option on Linux, it is the only one that works on a current desktop. Revisit only if MPRIS proves unavailable on a target DE.
- No system tray, no minimise-to-tray, no taskbar progress. Separate concerns.
- No macOS. D10 stands.
- No last.fm or scrobbling. Unrelated surface that this card's metadata plumbing will look like an invitation to add.

## Verification

- Linux: `busctl --user list` shows a Fermata MPRIS name; `playerctl metadata` returns real tags; `playerctl play-pause` toggles playback. Then repeat against the packaged AppImage, since the desktop-entry half only exists there.
- Windows: the volume-flyout card shows metadata and art and responds to the keys; verified in the packaged NSIS build so the AppUserModelID is the real one.
- Automated coverage over the pure parts — status-to-`playbackState` mapping, metadata construction from a `Track`, position-state update triggers, and the anchor lifecycle driven by a fake engine. The OS binding itself is verified by hand and recorded here, as W3-1's Web Audio wiring was.
- Ordinary repository gate on both platforms.
