---
taskId: 01KYWWVQQB80JQ6KK80HX96KYN
title: Settings registry and the typed schema
status: todo
priority: high
labels: []
workstream: W8
workstreamId: W8-1
order: 28
created: '2026-07-31T20:11:44.746Z'
updated: '2026-07-31T20:11:44.746Z'
---
The declarative registry every other card in this stream reads from. Pure data and pure functions — no storage, no IPC, no Vue.

Lives in `src/shared/settings.ts`, because it is a cross-process contract: main resolves durable keys before the window opens, the renderer generates its UI from the same definitions, and the two must not drift. This is the same rule that put the IPC contract in `src/shared/ipc.ts`.

## The descriptor

Each key declares:

- `key` — dotted, namespaced by domain (`audio.crossfadeMs`, `library.watcher.enabled`, `view.shell.paneSizes`)
- `type` and `default` — the default is authoritative; nothing else may hardcode one
- `scope` — `durable` (SQLite, main-readable, exportable) or `view` (localStorage, machine-local)
- `version` and an optional `upgrade(oldValue, oldVersion)` — see the migration rule below
- `validate` — returns the value or a reason; invalid values fall back to `default` and raise a notice rather than throwing
- `cascade` — whether the key accepts per-entity overrides (W8-5) and which entity kinds
- `control` — a hint (`toggle`, `number`, `select`, `slider`, `path`, `custom`) plus its constraints; `custom` names a component for the genuinely bespoke cases
- `label`, `help`, `keywords`, `category`, `order` — what W8-6 renders and searches
- `advanced` and `requiresRestart` — presentation flags, not behaviour

## Rules this card establishes

- **A key's default lives here and nowhere else.** Existing constants scattered through `transportPreferences.ts`, `shellLayout.ts`, `groupingLayout.ts` and friends move into descriptors as part of W8-3.
- **Unknown keys are preserved.** The registry defines what is *known*; it does not define what a store is allowed to hold. A store that encounters a key with no descriptor keeps it untouched. Switching branches must not destroy settings.
- **Migration is per-key.** A renamed or retyped key bumps its own `version` and supplies `upgrade`; there is no global settings version. This deliberately differs from `migrate(db, MIGRATIONS)` in `src/main/db/`, which owns the library schema — the tradeoff is more descriptors and less blast radius.

## Done when

- `defineSetting` (or equivalent) is exported and the registry is assembled from per-domain modules.
- `resolveDefault`, `validateValue` and `migrateValue` are covered in `tests/shared/` including: unknown key passthrough, invalid value falls back with a notice, `upgrade` chains across more than one version bump, and a descriptor with a bad default fails at build/test time rather than at runtime.
- No storage code, no IPC channel and no component imports this card's output yet. It compiles and tests standalone.
