---
taskId: 01M3B0K85G0NMJA750XPCCCD4T
title: Tag field registry + generic override store
status: done
priority: medium
labels:
  - '1.1'
  - tag-writeback
workstream: W16
workstreamId: W16-15
order: 14
created: '2026-09-25T00:49:10.319Z'
updated: '2026-09-27T00:20:50.496Z'
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

## Decisions (made while implementing)
- **Sibling channels, not a `fields` bag on `OverridePatch`.** `tagOverrides.set` / `tagOverrides.revert`. The two tiers share only the track ids. A grouped edit re-keys the browse and writes into display rows. A generic edit is just a `track_tag_overrides` row, so the renderer doesn't need to reload the browse. They also clear differently: `null` clears here, while a grouped string clears with `''`. Widening the patch would have tied one validator and one store transaction to both behaviours.
- **Three intents over two channels:** `set` takes a value (set) or `null` (clear the frame). `revert` deletes the row, back to the file's own value.
- **Normalisation:** empty text and empty lists become `null`, so a clear has only one spelling in the store. List entries must not be blank; their whitespace is kept.
- **`real` kind added** (a fifth kind beyond `text | int | bool | list`) for the four read-only ReplayGain values. Gain and peak are fractional. No editable field uses it, and the validator rejects it.
- **Nothing is admitted.** Every entry ships `admitted: false` until W16-16's corpus check passes for it, so `tagOverrides.set` currently rejects every key. `revert` accepts any registry key, admitted or not, so a field that loses admission can still have its corrections cleaned up.
- **Unknown keys and values that don't fit the field's kind** are skipped when read and never deleted. `revertAll` (used by "discard all") removes only keys this build knows. Only the `tracks` cascade removes the rest.
- **No `tagOverrides.getEditState` channel yet.** The effective value needs the on-demand taglib file read, which is W16-17's job. `buildTagFieldEditState` (the pure fold) and `TagOverrideStore.get/getMany` are ready for it to use.
- Pending-set membership (`pendingWritebackTrackIds`) is not extended here either. That lands with W16-17's diff, so the review never lists tracks it can't diff.
- Migration is **026**. `track_tag_overrides` is declared `open` in the D11 bundle table registry, the same as `track_overrides`.
