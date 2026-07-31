# Fermata

A format-first local music player for large libraries.

Fermata plays the files you already own. It indexes local folders into SQLite, browses and searches
tens of thousands of tracks without stuttering, and handles MP3, FLAC, Ogg Vorbis, Opus, AAC and WAV
consistently across platforms. No streaming service, no account, no cloud library.

Windows and Linux are both first-class targets.

## Status

Early development, milestone M1. The application skeleton is up; the library, playback and UI
milestones are in progress. Not yet usable as a music player.

## A caveat worth stating up front: no bit-perfect output

Fermata is built on Electron and the Web Audio API. Chromium always resamples audio to a single
device sample rate, and it offers no exclusive-mode or WASAPI-exclusive output path.

**That means Fermata cannot deliver bit-perfect playback.** A 24-bit/192 kHz file will be resampled
to whatever rate the output device is running at. For most listening this is inaudible, and the
trade buys a consistent decoder across every platform plus a mature audio graph for crossfade, gain
and EQ. If bit-perfect or exclusive-mode output is a requirement for you, Fermata is the wrong
player and no amount of configuration will change that.

This is decision **D1** in the design document, recorded with its rejected alternatives. It is a
known, accepted cost rather than an oversight, and it would take a different audio backend to
revisit.

## Development

```bash
npm install
npm run dev        # launches the app with renderer HMR
npm run build      # typecheck, then build main / preload / renderer
npm run typecheck  # both the Node and the web project
```

Requires Node 20 or newer.

## Packaging

```bash
npm run dist:linux  # AppImage + deb into release/
npm run dist:win    # NSIS installer into release/
```

Run each on its own platform — the native dependencies resolve platform-specific prebuilt addons
that are only installed there, so cross-building yields a broken app rather than a build error.

The icon set in `build/` is generated from the title bar's mark by `npm run icons`, one render per
size rather than one master downscaled, so 16 px stays legible on a 1x panel.

## Layout

```
src/
  main/      Node side: database, scanner, jobs, playlists, IPC handlers
  preload/   the contextBridge surface, and nothing else
  shared/    the IPC contract, imported by both sides so they cannot drift
  renderer/  Vue 3 UI, plus the Web Audio engine
tests/
```

The renderer runs with `contextIsolation` on, `nodeIntegration` off and `sandbox` enabled. It has no
filesystem access; every library operation crosses a typed IPC boundary defined once in
`src/shared`.

## Documentation

The design document is the authority on architecture and on decisions already settled. It lives in
this repository's Kleron wiki at `.kleron/wiki/fermata-design.md`, alongside the task board — clone
the repo and the full project context comes with it.
