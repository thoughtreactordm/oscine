# Oscine

A local music player for large libraries, for Windows and Linux.

Oscine indexes local music folders into a SQLite library and plays MP3, FLAC, Ogg Vorbis, Opus, AAC (`.m4a`) and WAV. It is designed for libraries of up to 100,000 tracks. There is no streaming integration and no account; the library is the folders on disk.

Oscine is open source under the [MIT License](LICENSE) and is distributed as a packaged desktop application.

- [Download](https://github.com/thoughtreactordm/oscine/releases/latest)
- [User guide](https://oscine.app/learn)
- [Website](https://oscine.app)
- [Discord](https://discord.gg/u3npX42WbP)
- [Issues](https://github.com/thoughtreactordm/oscine/issues)

## Install

Download the latest release from [GitHub Releases](https://github.com/thoughtreactordm/oscine/releases/latest).

| Platform | Package |
|---|---|
| Windows | `Oscine.Setup.<version>.exe` (NSIS installer) |
| Debian, Ubuntu and derivatives | `oscine_<version>_amd64.deb` |
| Other Linux distributions | `Oscine-<version>.AppImage` |

Updates are checked manually from Settings. The Windows installer and AppImage builds download the update and restart into it. `.deb` installs are directed to the releases page, since the package is managed by apt.

macOS is not supported.

## Features

- **Library:** incremental scan on launch, filesystem watcher, FTS5 full-text search, virtualized Artist, Album and Song views, and a content-addressed artwork cache.
- **Playback:** gapless playback or equal-power crossfade (per track boundary, never both), ReplayGain from tags or computed, a two-tier up-next queue, keyboard shortcuts, and OS media controls (MPRIS on Linux, system media controls on Windows).
- **Playlists:** playlist tabs, drag reordering, m3u8 export and a pinned Favorites playlist.
- **Tunedeck:** a resizable panel showing format and signal details, play history and related tracks in the library. An optional artist view pulls identity data from MusicBrainz and biographies from Wikipedia; it requires network access and is off by default.
- **Discover:** ten rule-based recommendation shelves built from the library and listening history. No network access or ML model. Shelves can be saved as playlists.
- **Listening history and scrobbling:** a full listens log, a statistics dashboard, and scrobbling to Last.fm and ListenBrainz with an offline queue.
- **Podcasts:** subscriptions, automatic downloads, local playback and search of the Apple Podcasts catalogue.
- **Tag write-back:** metadata and embedded artwork edits are stored in the database first and written to files only after the user reviews and confirms them. Each file write is atomic, backed up, hash-verified and rolled back on failure.
- **Theming:** three built-in themes, a per-token theme editor with WCAG AA contrast warnings, configurable fonts, and shareable `.osctheme` files.
- **Settings:** first-run setup, scoped settings, and profile export and import.

## Limitations

Oscine does not support bit-perfect or exclusive-mode output. It uses Electron and the Web Audio API, and Chromium resamples all audio to the output device's sample rate with no WASAPI-exclusive path. A 24-bit/192 kHz file is played at the device rate. This is a deliberate trade-off, recorded as decision D1 in the design document: it gives one decoder across both platforms and a Web Audio graph for crossfade and gain. Changing it would require a different audio backend.

## Design principles

- The library is local files. No streaming services or stores.
- Network features (artist info, scrobbling, podcasts) are opt-in. The app is fully usable offline.
- Files are never modified without explicit user confirmation.
- All lists are virtualized and must perform at 100,000 tracks.
- Windows and Linux behave identically. No platform-specific code paths for paths or shells.
- Themes are defined through CSS tokens. Changing a theme requires no component changes.

The [design document](.kleron/wiki/fermata-design.md) records these principles and the fifteen architectural decisions (D1–D15) behind them. Contributions are reviewed against it.

## Contributing

Oscine is open source but does not accept general contributions. The project's direction is set by its maintainer and its design document. The following policy applies to issues and pull requests.

### Bug reports and fixes

Report bugs through [GitHub Issues](https://github.com/thoughtreactordm/oscine/issues). Include the Oscine version, operating system, install type (NSIS, AppImage or `.deb`), steps to reproduce, expected and actual behaviour, and logs where available.

Bug fix pull requests are accepted. Fork the repository, keep the change limited to the fix, and reference the issue in the PR.

### Feature requests

Discuss feature proposals in the [Discord](https://discord.gg/u3npX42WbP) before writing code. Discussion is kept there so it is public and accessible to everyone.

Feature pull requests from forks are accepted for review, but review does not imply acceptance. A feature PR must:

- Describe what the change does, why it belongs in Oscine, and which design decisions (D-numbers) and invariants it affects.
- Be as small as possible. Split large features into separate, sequential PRs to limit the scope of each change and reduce conflicts and duplicated work.
- Follow the conventions and invariants in [`CLAUDE.md`](CLAUDE.md) and the design document. A PR that reverses a settled decision must show that the decision's "revisit when" condition has been met.
- Pass `lint`, `format:check`, `typecheck`, `test` and `build` on Windows and Linux.

### Use of AI tools

AI-assisted contributions are accepted if the use of AI is disclosed. Oscine's own use of AI is documented in the [AI/LLM disclosure](https://oscine.app/disclosure). Each PR must state:

- Which AI tools and models were used.
- Which parts of the change they were used for (design, code, tests, documentation, PR description).
- What the contributor reviewed and tested themselves.

Keep any `Co-Authored-By` trailers added by AI tools. Contributors are responsible for every line they submit.

Pull requests that appear to conceal the use of AI tools will be closed without review.

### Changes outside the project's scope

Changes that conflict with the design principles, such as streaming integration, a different audio backend or a macOS port, will not be merged. These are better suited to a separate project. The MIT License permits this; forks must be renamed and rebranded as described in [License and trademark](#license-and-trademark).

## Building from source

Requires Node.js 20 or later.

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # Vitest
npm run lint       # ESLint, warnings are errors
npm run typecheck  # tsc (main) and vue-tsc (renderer)
npm run build      # typecheck, then build main, preload and renderer
```

CI runs `lint`, `format:check`, `typecheck`, `test` and `build` on `ubuntu-latest` and `windows-latest`.

### Packaging

```bash
npm run dist:linux  # AppImage and .deb in release/
npm run dist:win    # NSIS installer in release/
```

Each platform must be packaged on that platform. The native dependencies (sharp, node-web-audio-api) install platform-specific prebuilt binaries, so a cross-platform build produces a broken app.

The icons in `build/` are generated from `build/oscine-logo.svg` by `npm run icons`.

### Project structure

```
src/
  main/      main process: SQLite library, scanner and watcher, background jobs,
             playlists, podcasts, scrobbling, tag write-back, updates, IPC handlers
  preload/   contextBridge API
  shared/    IPC channel definitions and types used by both processes
  renderer/  Vue 3 UI and the Web Audio playback engine
tests/       tests/main/ and tests/renderer/, matching the process split
```

The renderer runs with `contextIsolation` and `sandbox` enabled and `nodeIntegration` disabled. It has no filesystem access; all library operations go through typed IPC channels defined in `src/shared`. Audio playback runs in the renderer, since Web Audio is not available in the main process, behind an `AudioEngine` interface.

### Documentation

- [User guide](https://oscine.app/learn)
- [Design document](.kleron/wiki/fermata-design.md): architecture and settled decisions. Read it before proposing architectural changes.
- [`docs/`](docs/): artwork cache and ReplayGain internals.
- [`CLAUDE.md`](CLAUDE.md): conventions and invariants for contributors and coding agents.

## License and trademark

The source code is licensed under the [MIT License](LICENSE).

The Oscine™ name, logo, icon, wordmark and visual identity are trademarks of Thought Reactor and are not covered by the MIT License. Forks distributed as separate products must remove the Oscine name and brand assets. Factual references such as "a fork of Oscine" or "based on Oscine" are permitted.

See [TRADEMARK.md](TRADEMARK.md) for the full policy and the list of reserved assets.
