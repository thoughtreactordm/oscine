---
taskId: 01M25X4H6VM3YZGXXMNEJ5QZ0G
title: In-app updates — manual check-and-install over the GitHub Releases channel
status: in-progress
priority: medium
labels:
  - main
  - renderer
  - packaging
  - D10-adjacent
workstream: W6
workstreamId: W6-6
order: 0
created: '2026-09-10T14:56:48.346Z'
updated: '2026-09-10T15:00:09.697Z'
---
No wiki page — this is polish-tier work on the existing packaging channel, not a new milestone, and it slots into W6 rather than reopening a D-number. It does touch the two settled positions below (deb, macOS); if the deb-exclusion and unsigned-NSIS posture want to be recorded as a decision rather than living only here, land that in `fermata-design` when the card is picked up.

**Half the infrastructure already exists — do not rebuild it.** CI cuts a draft `v<version>` GitHub Release on a version-bumped push to `main` and uploads the NSIS `.exe`, the AppImage and the deb, then publishes it; `electron-builder.yml` already carries a `publish:` block (`github` / `thoughtreactordm` / `oscine`). The distribution channel is done. There is no updater code in `src/` yet (nothing references `electron-updater` or `autoUpdater`) — that is the work.

**The one real gap in CI: publish the update metadata.** `electron-updater` reads `latest.yml` (Windows) / `latest-linux.yml` (Linux) plus the NSIS `.blockmap`, not the raw installer assets. The job builds with `--publish never` and hand-uploads only the binaries via `gh release upload`, so those files are generated into `release/` and then dropped on the floor. Add `latest*.yml` and `*.blockmap` to the upload lists in both platform jobs. Without this the updater has nothing to check against, so it is not optional and it is not last.

**The one new runtime dependency is `electron-updater`** — the electron-builder-native companion, no separate update server since we publish to GitHub Releases. It ships in the AppImage/NSIS automatically via the production-dependency closure electron-builder bundles.

**Main process — a new `src/main/update/` module** beside the existing service modules. No-op behind `app.isPackaged` so `npm run dev` never touches it. Manual mode: `autoUpdater.autoDownload = false`; expose `checkForUpdates()`, `downloadUpdate()`, `quitAndInstall()`; relay `update-available` / `download-progress` / `update-downloaded` / `error` out to the renderer.

**IPC surface starts in `src/shared/ipc.ts`, per the contract convention** — a `check` invoke, a `download` invoke, an `install` invoke, and a progress/status event stream, typed in `src/shared` so the two sides cannot drift. Not authored in a handler first.

**Renderer — a Settings panel island**, token-themed, no cross-panel coupling: "Check for updates" → status line (up to date / available / downloading with progress / ready → "Restart to install").

**Three narrowings, settled:**
- **deb is not auto-updatable and never will be** — dpkg/apt owns the install and `electron-updater` refuses to touch it. Detect the non-AppImage Linux case and show a "new version available → open releases page" notice instead of an in-app download. The AppImage path *does* self-update (swaps the file via the `APPIMAGE` env var).
- **Unsigned NSIS auto-update works** — SmartScreen warns on each install. Acceptable for "basic"; an Authenticode cert is a later polish item, explicitly out of scope for this card, not a blocker.
- **Manual first.** Silent background auto-download is a later flag flip (`autoDownload = true` + a periodic `checkForUpdates`) once the manual path is proven — not this card.

**macOS is out of scope (D10)** — which conveniently dodges the one platform where signing is *mandatory* for updates.

**Done when:** a packaged Windows build and a packaged Linux AppImage each detect a newer published release, download it, and relaunch into it; a deb (or other non-AppImage) install shows the releases-page fallback instead of a failed download; the dev build no-ops; and CI attaches `latest*.yml` and the `.blockmap` to the release so the updater has something to read.
