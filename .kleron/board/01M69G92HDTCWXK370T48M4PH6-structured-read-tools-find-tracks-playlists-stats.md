---
taskId: 01M69G92HDTCWXK370T48M4PH6
title: 'Structured read tools — find_tracks, playlists, stats, tag fields, find_issues'
status: done
priority: medium
labels:
  - D36.3
  - D36.4
  - main
workstream: W24
workstreamId: W24-4
dependsOn:
  - 01M69G8CVSNWTRX2K34EJ4AWJP
order: 23
created: '2026-10-31T17:31:50.699Z'
updated: '2026-11-01T03:29:07.701Z'
---
Spec: wiki `oscine-mcp` → D36.3, D36.4.

All tools in the Read capability, built on existing services, with zod-validated input.

- **`find_tracks`**: a filter richer than `LibraryBrowseFilters` (effective tag values with overrides applied, presence/absence of a field, format, year range, duration, play count, last played), a caller-chosen field list, a cursor.
- **`get_tracks`** by ids; **albums** and **artists** listings; **`list_playlists`** and **`get_playlist`** (entries with entry ids, so later edits can target them).
- **Stats and history**: top tracks/artists/albums over a range, and recent listens, from the existing stats engine.
- **`list_tag_fields`**: the W16 registry (keys, value types, which formats support each), so an agent knows what `stage_tag_changes` will accept.
- **`find_issues`** with four checks: missing album artist; years that disagree within an album; likely duplicates (same normalised artist + title, similar duration); artist names that differ only in case, punctuation or diacritics. Each result is grouped and compact.
- **Output rules** (D36.3): numeric ids plus display text; root name + POSIX-relative path, never absolute; row caps with cursors; descriptions that say what the tool cannot do.

**Tests:** each tool against a fixture library, including cursor paging to the end, cap behaviour, an absolute path never appearing in any output (asserted over every tool), and each `find_issues` check finding a planted case and not a near miss.

**Done when:** an agent can answer "which albums are missing album artist" and "what did I play most last month" with the structured tools alone.
