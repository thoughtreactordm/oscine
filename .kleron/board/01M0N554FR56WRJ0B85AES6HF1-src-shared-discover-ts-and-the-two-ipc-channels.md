---
taskId: 01M0N554FR56WRJ0B85AES6HF1
title: '`src/shared/discover.ts` and the two IPC channels'
status: done
priority: high
labels:
  - ipc
  - shared
  - D20
workstream: W12
workstreamId: W12-1
order: 3
created: '2026-08-22T16:34:09.528Z'
updated: '2026-08-24T17:56:51.539Z'
---
Spec: wiki `fermata-discover-1-0` → Data contract.

The IPC surface starts in `src/shared`, like every other one. This card is the types and the two channels, not the engine behind them.

**`src/shared/discover.ts`** — `DiscoverRecipeId`, `DiscoverGrain`, `DiscoverItem` (album | track), `DiscoverShelf`, `DiscoverShelvesResult`, `SHELF_ITEM_CAP = 10`, `SHELF_MIN_ITEMS = 3`. `RelatedAlbum` is the wrong type: no `why`, no artwork, and a different job. Do not reuse it.

**Channels** (in `src/shared/ipc.ts`):
- `discover.shelves`: `{ request: void; response: DiscoverShelvesResult }` — clock is main's.
- `discover.saveShelf`: `{ request: { recipeId: DiscoverRecipeId }; response: Playlist }` — snapshots the last `shelves` result the operator is looking at, does not re-query.

No `discover.playShelf`. Playing is a renderer gesture over ids the pane already has.

Handlers may return empty shelves / throw "not implemented" until W12-2. The contract compiling, and preload exposing it, is this card.

**Done when:** main, preload and renderer all import the same types; the two channels are in the IPC map; `npm run typecheck` is clean.
