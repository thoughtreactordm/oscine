---
taskId: 01KYWX10CVYBXTK2DCSXFNVQE1
title: 'Settings export and import — profiles, and the machine-local exclusion list'
status: todo
priority: medium
labels: []
workstream: W8
workstreamId: W8-13
dependsOn:
  - 01KYWWWA83W72X3CAT388JY932
  - 01KYWWYMJXQ2472MV9SV4QYJ1Q
order: 40
created: '2026-07-31T20:14:37.465Z'
updated: '2026-07-31T20:14:37.465Z'
---
Move a configuration between machines, keep a known-good copy, or hand one to someone reproducing a bug.

## What travels

Durable keys only, and not all of them. The registry gains a `portable` flag; keys that describe *this machine* are excluded by default:

- `audio.outputDevice` — a device name that means nothing elsewhere
- root folder paths — absolute, machine-specific, and the one thing that must never be blindly imported
- window geometry and anything `view`-scoped

Everything else — audio behaviour, library policy, interface preferences, theme and token overrides — travels. The exclusion is a declared property of each descriptor, not a list maintained in the exporter, so a new setting cannot be forgotten by the export.

## Format

JSON, human-readable, with each key's `version` alongside its value so an import into a newer build runs the same per-key `upgrade` chain as a stored value would. An export is not a snapshot of a schema version; it is a bag of independently versioned values, which is exactly why W8-1 chose per-key migration.

Unknown keys in an imported file are preserved into the store rather than rejected — importing from a newer build must not silently drop what it does not understand.

## Import UX

Show the diff before applying: what changes, what is new, what is excluded and why. Applying is one action and is undoable via reset (W8-7) only in the crude sense, so the preview is doing real work here. Offer merge (apply only keys present in the file) and replace (also reset keys absent from it) as distinct choices — they are not the same operation and conflating them will lose settings.

## Relationship to D11

The D11 export bundle carries playlists, ratings and play counts between machines. This is its configuration companion and should use compatible framing, but it is a separate file and a separate action — an operator moving a library should not be forced to take a configuration with it.

## Done when

- Export excludes every non-portable key, proven by a test that walks the registry rather than a fixed list.
- Round-trip export/import on a clean profile reproduces the source exactly.
- Import from an older version runs upgrades; import from a newer one preserves unknowns.
- Merge and replace are distinct, previewed, and tested.
