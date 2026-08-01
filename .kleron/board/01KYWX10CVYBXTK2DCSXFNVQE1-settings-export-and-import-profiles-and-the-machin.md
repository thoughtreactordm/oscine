---
taskId: 01KYWX10CVYBXTK2DCSXFNVQE1
title: 'Settings export and import — profiles, and the machine-local exclusion list'
status: in-review
priority: medium
labels: []
workstream: W8
workstreamId: W8-13
dependsOn:
  - 01KYWWWA83W72X3CAT388JY932
  - 01KYWWYMJXQ2472MV9SV4QYJ1Q
order: 40
created: '2026-07-31T20:14:37.465Z'
updated: '2026-08-01T20:40:46.670Z'
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

---

## Built — `fc37d2a`

`portable` is a kernel field (`src/shared/settings/kernel.ts`), defaulting to true for durable keys and **refused outright** on view scope — so "view state never travels" is a definition rather than a rule the exporter remembers. `audio.outputDevice` carries `portable: false`; it is the only durable key that does. Root folders needed no flag: they live in the library database, not the settings table, so there is no descriptor to hold back.

`src/shared/settings/profile.ts` is the whole of the logic and is pure. `descriptors` is a required argument on every function rather than defaulting to `SETTINGS_REGISTRY` — the registry is assembled a level up, and reaching for it from inside `settings/` would be an import cycle.

### Decisions worth knowing about

- **Stored keys only travel.** A key sitting at its default has not been decided, and writing it into the file would pin today's default into a configuration that outlives the build which chose it.
- **`unchanged` still writes.** The row is part of the configuration in its own right — it is what stops the key tracking a default a later build moves — so the round trip reproduces it. The status describes what the operator will *see*, not whether a row is touched.
- **A known key at a newer version is refused, not preserved.** The unknown-key rule protects rows that already exist; on import there is nothing to lose by skipping, and writing it would leave the key reading as its default while hiding the operator's own value. It previews as `incompatible`, distinct from `invalid`.
- **Replace never sweeps the non-portable keys.** Wiping the output device would be a machine-local setting lost to an operation that promised to carry a configuration between machines. Unknown rows are left for the same reason a reset leaves them.
- **Main recomputes the plan.** The renderer previews with `planSettingsImport` and main runs the same function on apply rather than trusting the plan it is sent. Same inputs both sides, so the preview is what happens.

### Surface

`settings.exportProfile` / `settings.readProfile` / `settings.importProfile`. Reading is separate from importing precisely so that picking a file commits the operator to nothing. Both dialogs are injected into `SqliteSettingsService` the way `SqlitePlaylistService` takes its own, so the whole path — including writing and reading a real file — is drivable from a test with a temp directory and no application. Export and import sit in the rail footer beside "Reset all settings…"; the preview is `ImportProfileDialog.vue`, virtualized like every other list.

### Tests

- `tests/shared/settingsProfile.test.ts` — the exclusion proof walks `SETTINGS_REGISTRY` and asserts `key in profile.settings === descriptor.portable` for every descriptor, so a new non-portable key is covered the moment it is defined. Round trip, upgrade-on-import, unknown preservation, merge vs replace, invalid and incompatible.
- `tests/main/settings/profile.test.ts` — the same over real SQLite and real files, including that an import survives a reload and that a refused value never reaches the table.
- `tests/renderer/settings/profile.test.ts` — preview against the live surface, flush-before-import, and the boundary guard below.

### One thing that only showed up in the app

`ipcRenderer.invoke` serialises with structured cloning, which refuses a `Proxy`. The picked file held in a plain `ref` became a reactive proxy, and the import failed with "an object could not be cloned" — nothing about settings. Fixed at both ends (`shallowRef` in the component, `toRaw` at the store's IPC call) with a regression test. Found by driving the dialog in a scratch second instance; the unit tests could not have caught it because the fixture bridge is an in-process function call.

### Not done here

The export path's save dialog is native, so it was verified through the injected-picker tests rather than in the running app. Import was driven end to end in a scratch instance: preview, mode toggle, confirm, toast, and the surface updating live off the broadcast.
