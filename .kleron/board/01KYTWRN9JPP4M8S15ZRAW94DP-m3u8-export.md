---
taskId: 01KYTWRN9JPP4M8S15ZRAW94DP
title: m3u8 export
status: in-review
priority: medium
labels:
  - M4
  - main
  - interop
workstream: W5
workstreamId: W5-4
dependsOn:
  - 01KYTWQWYQK7NG2VNSA4MTGT2K
order: 23
created: '2026-07-31T01:31:35.088Z'
updated: '2026-07-31T02:41:43.310Z'
---
## Scope

- Main-process export of a playlist to `.m3u8`: UTF-8, `#EXTM3U` header, one `#EXTINF:<secs>,
  <artist> - <title>` per entry.
- Paths are the whole difficulty. Tracks are stored relative to a named root; export has to
  rejoin per-platform and then emit either paths relative to the destination file or absolute
  paths, as the operator chooses. Neither branch may leak a stored POSIX separator onto
  Windows or a Windows separator onto Linux.
- Save dialog in main, invoked over IPC. The renderer never touches the filesystem.
- Export only. Import is backlog per **D12** — do not build it, and do not leave a half-parser
  behind.

## Acceptance

- A playlist containing duplicate tracks, non-ASCII names and a track under a second root
  exports correctly, with a test over the emitted text.
- The exported file opens in at least one other player on each platform; say which players in
  the card comments.
- `fermata/no-windows-path-literals` stays green — no hand-rolled concatenation in the writer.
- Tests in `tests/main/library/`.

## Notes

**D12**. This is the interop escape hatch that makes a v1 without smart playlists defensible,
so the path handling matters more than the feature surface does.

## What was built

`playlists.exportM3u8` on the IPC contract, with the request carrying the path style so the
choice is per export rather than a setting. Cancelling resolves `null`, following
`library.addRoot`.

- `src/main/library/playlists/m3u8.ts` — the renderer, pure, taking its `PlatformPath` as an
  argument so win32 and posix are both exercised from one machine. Also owns the suggested
  filename (illegal characters, trailing dots, reserved device names) and the extension GTK
  does not append.
- `PlaylistStore.readForExport` — the playlist's name and every entry rejoined through
  `toAbsPath` against the root that entry's track was stored under. Unpaged, deliberately: an
  export is one file, and a playlist half-written is worse than one not written.
- `SqlitePlaylistService.exportM3u8` — dialog, render, write. The dialog function is injected
  the way `pickFolder` is, so the whole path including the real write is drivable from a test.
- Failure surface: unknown playlist throws `not-found` *before* the dialog opens; an
  unwritable destination throws `io-error` whose message carries no path.

Two decisions worth flagging in review:

- **LF and no BOM, on both platforms.** `.m3u8` carries its encoding in the extension, a BOM
  risks a parser missing `#EXTM3U` on line one, and every player that reads the format takes
  LF. The payoff is that both platforms emit byte-identical files from the same library.
- **The result carries the file's name, never its folder.** `IpcErrorPayload` promises no
  absolute path crosses the boundary, and a success payload has no more business disclosing
  the filesystem layout than a failure does.

Line breaks are folded out of tags before they reach an `#EXTINF` line — a newline in a tag
would otherwise close the record and let the remainder be read as a location.

## Verification

`lint`, `format:check`, `typecheck`, `test`, `build` all green. 30 new tests in
`tests/main/library/m3u8Export.test.ts`, plus the validator cases in `tests/main/ipc/`.

The acceptance fixture — a playlist with a duplicate entry, non-ASCII directory and track
names (`Björk`, `日本語/02 曲.flac`) and a track under a second root — was exported in both
styles and opened on **Linux** in:

- **mpv 0.40** (`--playlist=`): all four entries resolved and played, in both styles.
- **VLC 3.0** (`-I dummy --play-and-exit`): four `flacsys` demuxers opened, in both styles.

Both were run from an unrelated working directory, which is what proves the relative branch
resolves against the playlist file rather than against the process cwd. `file(1)` reports
`M3U playlist, Unicode text, UTF-8 text`.

**Still owed: the Windows half of that criterion.** Nothing in the implementation is
platform-conditional and the win32 path branches are covered by unit tests, but no `.m3u8`
written by this code has been opened by a Windows player yet. Worth doing with foobar2000 or
MusicBee before this leaves review.

**No UI affordance.** The seam is complete through the preload bridge and the playlists store
(`exportM3u8(playlistId, pathStyle)`), but nothing invokes it: the tab bar has no context menu
to hang it on, and adding one belongs to the pane cards rather than here.
