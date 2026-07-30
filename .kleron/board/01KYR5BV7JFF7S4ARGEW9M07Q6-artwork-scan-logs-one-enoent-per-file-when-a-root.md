---
taskId: 01KYR5BV7JFF7S4ARGEW9M07Q6
title: Artwork scan logs one ENOENT per file when a root is missing
status: triage
priority: medium
labels:
  - artwork
  - logging
  - dx
triageKind: bug
workstream: W2
workstreamId: W2-8
order: 0
created: '2026-07-30T00:04:09.073Z'
updated: '2026-07-30T00:04:09.073Z'
---
When a configured root is absent, the artwork pass logs one `[artwork] skipped track N: ENOENT ...` line per track instead of noticing the root is gone and saying so once.

## Measured

On a 100k synthetic library whose root `/__fermata_synthetic__` did not exist, a single `npm run dev` startup produced:

- **97,951 log lines** in ~30 seconds
- **11.65 MB** of output
- summary line confirms the shape: `{"albumsChecked":8000,"sourceFilesRead":97951,"uniqueHashes":0,"thumbnailsGenerated":0}`

The watcher already detects the same condition correctly and logs it once:

```
[watch] root 2 skipped /__fermata_synthetic__: ENOENT ... realpath '/__fermata_synthetic__'
```

## Why this is more than noise

It destroys the log as a diagnostic surface. In one dev session an Electron GPU crash — `FATAL: GPU process isn't usable. Goodbye.` — landed at **line 98,017 of 98,025**. It printed correctly and was still effectively invisible, because ~98k artwork lines arrived in the same second and evicted the scrollback. Any real error competing with this flood loses.

Note this is not what makes a silent quit silent — that was the single-instance lock, fixed separately. This is the reason a *loud* failure can also go unseen.

## Open design question

What should a vanished root do to the artwork pass?

1. **Skip the root, log once, continue** — matches what `[watch]` already does, and keeps other roots working. Probably right.
2. **Abort the pass** — safer if a missing root means the config is stale, but punishes a multi-root library for one unplugged drive.

Either way, per-track ENOENT should be logged at most once per root, and the per-track path should stay quiet for the expected-missing case. Genuine per-file ENOENT on a root that *does* exist is still worth a line — that's a real inconsistency between the DB and disk.

## Suggested acceptance

- A missing root yields O(1) log lines from the artwork pass, not O(tracks).
- A present root with individual missing files still reports those files.
- Test covers the missing-root case so the line count cannot regress.
