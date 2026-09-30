---
taskId: 01M3D7PRB92M9ZKRSQDHKNXEDX
title: Apple MusicBrainz artist-id setters throw on clear
status: done
priority: low
labels:
  - '1.1'
  - tag-writeback
  - gate
triageKind: bug
workstream: W16
workstreamId: W16-20
order: 2
created: '2026-09-25T21:31:54.087Z'
updated: '2026-09-27T00:39:10.126Z'
---
Found by the W16-16 per-field corpus gate (`npm run probe:writeback-corpus`), linux/x64.

**Red cells:** `musicBrainzArtistId` × aac and `musicBrainzReleaseArtistId` × aac, both `written:<field>:clear`.

node-taglib-sharp's `AppleTag` setters for these two fields call `v.split("/")` before storing, because MB artist ids are multi-valued and joined with `/`. The gate's clear contract for `text` fields is `undefined` (`CLEAR_VALUE` in `scripts/lib/writeback-field-cases.mjs`), and on `.m4a` the setter throws `Cannot read properties of undefined (reading 'split')`. `null` throws the same way. The other three containers accept `undefined`.

A one-off experiment shows that `''` clears both fields on `.m4a` (they read back as `undefined`). The gate was not changed to use `''`: the clear contract applies to all text fields, and changing it to turn a cell green is exactly the quiet fix the gate forbids.

**To resolve:** decide the writer's text-clear contract (W16-17). Either (a) `''` for every text field, or (b) a per-field exception for these two Apple setters. Update `CLEAR_VALUE` or the field case to match, then re-run the gate on both platforms. Also worth checking: an id value that contains `/` is stored as several iTunes strings. Confirm it reads back joined, so a multi-artist id round-trips.

## Resolution

**Chose (b), in the writer.** The text clear contract stays `undefined`, and `CLEAR_VALUE` is unchanged. Both fields get an entry in W16-19's `PROPERTY_ACCESS` seam (`src/main/library/writeback/genericFields.ts`). The entry's write turns a clear (`undefined` / `null` / `''`) into `''` only when the tag is an `Mpeg4AppleTag`. `setItunesTagBoxes` skips empty split pieces, so `''` leaves no box. Every other tag family gets the plain clear. An MP4's `file.tag` is the Apple tag itself, never a combined tag. Reads go through the plain property. The gate mirror `scripts/lib/writeback-tag-access.mjs` carries the same entries, so the gate exercises the writer rather than raw taglib.

**Multi-id round-trip confirmed.** A `/`-joined id is stored as one iTunes string per id and reads back joined on MP4. It round-trips as-is on ID3v2, Xiph and APE. The gate's field cases for both keys are now two joined ids, so the multi-value path is tested on every codec.

**Admitted.** Both `held()` wraps were removed from `src/shared/tagFields.ts`. No field is held now. `held()` stays, with a reasoned eslint-disable, for the next red cell.

**Tests.** `tests/tooling/writebackTagAccess.test.ts` checks writer/mirror parity for the MP4 clear (all three clear shapes), the joined round-trip and the non-MP4 clear. The held-refusal tests now pin admission through a new `tests/support/pinAdmission.ts` (tagFieldValidate's inline pin moved there too). The pending-set test in genericFlush uses a read-only key instead, because `store.ts` builds `FLUSHABLE_TAG_FIELDS_SQL` at load, where a pin cannot reach it.

**Evidence:** linux/x64 corpus gate passed all 537 checks, both rows ✅ on all five codecs. lint, format:check, typecheck and test (4519) are green.

**Owed:** the Windows gate run (`npm run probe:writeback-corpus` on windows-latest / a Windows host). Not committed yet; the working tree also holds W16-19's uncommitted change in the same files.
