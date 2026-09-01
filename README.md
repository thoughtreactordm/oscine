# Oscine

A format-first local music player for large libraries.

Oscine plays the files you already own. It indexes local folders into SQLite, browses and searches
tens of thousands of tracks without stuttering, and handles MP3, FLAC, Ogg Vorbis, Opus, AAC and WAV
consistently across platforms. No streaming service, no account, no cloud library.

Windows and Linux are both first-class targets.

## Status

Feature-complete and stabilising for the **1.0.0** release (currently `1.0.0-rc`). The whole stack
is in place and usable end to end:

- **Library** — point it at folders; incremental scan on launch plus a live filesystem watcher;
  FTS5 instant search; virtualized Artist/Album/Song browsing tuned for a 100k-track scale target;
  a content-addressed artwork cache.
- **Playback** — gapless and equal-power crossfade (mutually exclusive per boundary), ReplayGain
  read-or-compute, a two-tier up-next queue over per-tab playlists, and OS media-session integration.
- **Playlists** — named playlist tabs, drag reorder, m3u8 export, and a pinned "My Favorites".
- **Tunedeck** — a resizable deck with a format/signal readout, play history and related-in-library,
  plus an opt-in artist nexus (MusicBrainz identity, Wikipedia biography, in-library relations) that
  stays fully functional with networking declined.
- **Discover** — nine deterministic local recipes over your library and listening log; no model and
  no network; save any shelf as a playlist.
- **Listening & scrobbling** — an uncapped, snapshotting listens log, a stats dashboard, and Last.fm
  scrobbling with an offline outbox.
- **Podcasts** — a parallel domain: subscribe, auto-download and play from disk, with an
  Apple-catalogue Discover pane.
- **Tag write-back** — an explicit, staged, operator-reviewed flush of metadata and embedded-artwork
  corrections to disk, with atomic writes, backup and rollback. Nothing is ever written implicitly.
- **Theming** — a CSS-token layer with three built-in themes, a live per-token editor with WCAG AA
  contrast warnings, and configurable font roles. Swapping a theme touches zero component code.
- **Onboarding & settings** — a first-run wizard and a scoped settings cascade.

The CI matrix builds and tests both platforms on every push.

## A caveat worth stating up front: no bit-perfect output

Oscine is built on Electron and the Web Audio API. Chromium always resamples audio to a single
device sample rate, and it offers no exclusive-mode or WASAPI-exclusive output path.

**That means Oscine cannot deliver bit-perfect playback.** A 24-bit/192 kHz file will be resampled
to whatever rate the output device is running at. For most listening this is inaudible, and the
trade buys a consistent decoder across every platform plus a mature audio graph for crossfade, gain
and EQ. If bit-perfect or exclusive-mode output is a requirement for you, Oscine is the wrong
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
npm test           # Vitest
npm run lint       # ESLint (warnings are errors)
```

`lint`, `format:check`, `typecheck`, `test` and `build` are the pre-push gate; CI runs all five on
`ubuntu-latest` and `windows-latest`. Requires a current LTS Node (20 or newer).

## Packaging

```bash
npm run dist:linux  # AppImage + deb into release/
npm run dist:win    # NSIS installer into release/
```

Run each on its own platform — the native dependencies (sharp, node-web-audio-api) resolve
platform-specific prebuilt addons that are only installed there, so cross-building yields a broken
app rather than a build error.

The icon set in `build/` is generated from the title bar's mark by `npm run icons`, one render per
size rather than one master downscaled, so 16 px stays legible on a 1x panel.

## Layout

```
src/
  main/      Node side: SQLite library, scanner + watcher, jobs (scan, ReplayGain),
             playlists, podcasts, scrobbling, tag write-back, IPC handlers
  preload/   the contextBridge surface, and nothing else
  shared/    the IPC contract, imported by both sides so they cannot drift
  renderer/  Vue 3 UI (panels as islands), plus the Web Audio engine behind an interface
tests/       mirrors the process split: tests/main/ and tests/renderer/
```

The renderer runs with `contextIsolation` on, `nodeIntegration` off and `sandbox` enabled. It has no
filesystem access; every library operation crosses a typed IPC boundary defined once in
`src/shared`. Audio lives in the renderer because Web Audio has no main-process equivalent, behind an
`AudioEngine` interface so the decode implementation can be replaced without the UI noticing.

## Documentation

The design document is the authority on architecture and on decisions already settled — read it
before proposing architectural change. It lives in this repository's Kleron wiki at
[`.kleron/wiki/fermata-design.md`](.kleron/wiki/fermata-design.md), alongside the task board, so a
clone carries the full project context. Its "Status as of 1.0" block maps what shipped beyond the
original frozen scope. Subsystem contracts that outgrew the design doc have their own notes under
[`docs/`](docs/) (artwork cache, ReplayGain). Project-wide conventions and invariants for
contributors — and for coding agents — live in [`CLAUDE.md`](CLAUDE.md).

## License & brand

The source code is licensed under the [MIT License](LICENSE) — free to use, fork, and distribute,
including commercially.

The **Oscine™ name, logo, icon, wordmark, and visual identity** are trademarks of Thought Reactor
and are **not** covered by the MIT License. Forking the code means renaming and rebranding: remove
the Oscine name and logo assets and replace them with your own. Truthful nominative references
("a fork of Oscine", "based on Oscine") are always fine.

See [TRADEMARK.md](TRADEMARK.md) for the full brand policy and a list of the reserved assets.
