---
taskId: 01M126ZBGXQZ8QTJ9W6E5N2CBS
title: 'tags.* IPC contract, preload surface, and renderer store'
status: done
priority: high
labels: []
workstream: W15
workstreamId: W15-2
dependsOn:
  - 01M126Z037ZH3B7X34PTQRPCGR
order: 1
created: '2026-08-27T18:16:04.893Z'
updated: '2026-08-28T00:56:42.085Z'
---
Contract-first: the cross-process surface for user tags. `src/shared` is the only place this may originate.

## `src/shared/ipc.ts` (or a `src/shared/tags.ts` it re-exports)

```
tags.list      ()                          -> { id, key, label, trackCount }[]
tags.forTrack  (trackId)                   -> { file: string[], user: Tag[] }
tags.add       ({ trackIds, label })       -> void        // batch-capable
tags.remove    ({ trackIds, tagId })       -> void
tags.rename    ({ tagId, label })          -> void
tags.suggest   (trackId)                   -> Suggestion[] // stub here; wired to MB in a later card
```

`tags.suggest` returns an empty list until the MusicBrainz card lands — declare it now so the renderer store is complete, but do not fetch yet.

## Preload

Extend the narrow typed `contextBridge` surface. Renderer never touches the DB directly (invariant). Types imported from `src/shared`, so main and renderer cannot drift.

## Renderer store (`src/renderer/stores/`)

Pinia store mirroring the favorites store shape: `forTrack` cache keyed by trackId, `add`/`remove`/`rename` actions that call IPC and update optimistically, and a `vocabulary` list for the browse/column surfaces. Writes apply immediately and reflect the broadcast, matching the settings/favorites "nothing staged behind OK/Cancel" convention.

## Out of scope

The Tunedeck pane, the TrackList column, the actual MB fetch behind `tags.suggest`.
