---
taskId: 01M3B0K85G0NMJA750XPCCCD4T
title: Tag field registry + generic override store
status: todo
priority: medium
labels:
  - '1.1'
  - tag-writeback
workstream: W16
workstreamId: W16-15
order: 7
created: '2026-09-25T00:49:10.319Z'
updated: '2026-09-25T00:49:10.319Z'
---
Design: `oscine-tag-writeback` → "The full tag surface", **Decisions D, E, F, G** and the registry table.

## Scope
- `src/shared/tagFields.ts` (name open): a declarative registry, one entry per generic field — `key`, `label`, `group` (Credits / Numbering / Release / Content / Sorting / Advanced / Read-only), `kind` (`text | int | bool | list`), the node-taglib-sharp `Tag` property it maps to, `readOnly`. Pure and `@renderer`-free so main, preload and renderer all import it (the W8 settings registry is the precedent).
- Registry **membership is gated**: an entry ships marked admitted only once its W16-16 corpus check is green on all five codecs (Decision D). Non-admitted entries are not offered by IPC or UI.
- Excluded, per Decision F: `amazonId`, `musicIpId`, `dateTagged`, `performersRole`, the `first*`/`joined*` accessors, `pictures`. ReplayGain four are `readOnly`.
- Migration: `track_tag_overrides(track_id, field, value)` — PK `(track_id, field)`, `ON DELETE CASCADE`; `value` is JSON (no row = file's value, JSON value = set, JSON `null` = clear). Unknown `field` keys are preserved, not dropped.
- Store: set / clear / revert per field, batch-bounded like `OverridePatch`; value validation by `kind` (int range, list of non-empty strings, bool) in `src/main/ipc/validate.ts`, driven by the registry.
- IPC surface in `src/shared/ipc.ts` first. Either widen `OverridePatch` with a `fields: Record<key, value>` bag or add a sibling channel — decide in the card, record why.
- Edit-state folding (`editState.ts`) generalised to generic fields: shared value vs `mixed` across the batch, list equality by value.
- Grouped fields (incl. W16-14's album artist) stay on `track_overrides` — the registry may *describe* them for UI ordering but never routes their writes (Decision E).

## Acceptance
- Unit tests: registry integrity (unique keys, every taglib property exists on `Tag`), validation per kind, store set/clear/revert round trip, unknown-key preservation, cascade on track delete.
- No scan-path or `tracks` schema change.
