---
taskId: 01KYTWRN9JPP4M8S15ZRAW94DP
title: m3u8 export
status: todo
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
updated: '2026-07-31T01:31:35.088Z'
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
