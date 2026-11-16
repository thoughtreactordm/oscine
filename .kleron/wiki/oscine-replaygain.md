---
title: 'ReplayGain: measure, review, write'
created: '2026-11-01T03:22:12.682Z'
updated: '2026-11-16T20:48:38.472Z'
---
# ReplayGain: measure, review, write

Status: **draft spec**, not yet carded. Decision and risk numbers below (D37, R20, R21) are the
next free ones at time of writing; confirm before cutting cards.

## Why this exists

Oscine can measure ReplayGain but the operator cannot ask it to, and the result never reaches the
file. Three things are true of the code today:

- **The analyzer is complete.** `src/main/replaygain/loudness.ts` is ReplayGain 2.0 / EBU R128
  (BS.1770 K-weighting, gated 400 ms blocks, −18 LUFS reference). `ReplayGainJobService` runs it on
  two workers, checkpoints per track, cancels and resumes, and recovers an interrupted job at
  launch. `jobStore.finalizeAlbum` merges per-track histograms into an album gain; tagged tracks
  stand in as one weighted bin from their own gain.
- **Nothing starts it.** `library.startReplayGain` is wired through IPC, preload and
  `src/renderer/ipc.ts`, but no renderer code calls it. The only caller is
  `scripts/m2-exit-probe.mjs`. The `audio.replayGainComputeWhenMissing` help text refers to "the
  button"; there is no button.
- **Nothing writes it.** Values land in `tracks.rg_*` with `rg_source = 'computed'` and stay
  there. [[oscine-tag-writeback]] Decision F made the four fields read-only on the premise that
  "the app computes and writes it through its own path". That path was never built, so Decision F
  currently blocks the only route to the file.

Playback already uses the values (`audio.replayGainMode` off / track / album, preamp, fallback
gain), so measuring alone fixes in-app loudness. Writing them makes the measurement portable to
every other player and survives a library rebuild.

## D37 — ReplayGain is measured on request and reaches the file only through the staged review

Measurement is an explicit operator action. Computed values become a write-back like any other
correction: staged into `track_tag_overrides`, reviewed old → new, flushed by the existing atomic
per-file writer with backup, hash-verify and rollback. This executes D7 (as amended by W16/D28);
it does not reopen it. Nothing is ever typed by hand.

**Decision A — the start is explicit; no auto-run after scan.** Decoding is the expensive part of
the whole app: at the 100k-track scale target a full measurement is hours of two-worker CPU. A scan
that finds untagged tracks raises a non-modal nudge ("1,204 tracks have no ReplayGain — Measure")
and nothing more. `audio.replayGainComputeWhenMissing` keeps its meaning: off refuses the job and
the control says why.

**Decision B — Decision F is amended, not dropped.** The ReplayGain fields stay out of the editor
and are refused by every hand-edit entry point (`tagOverrides.*` IPC, MCP `stage_tag_changes`). What
changes is the flush gate: `readOnly` stops meaning "never written" and starts meaning "never
hand-edited". Rows under ReplayGain keys can enter `track_tag_overrides` only from the ReplayGain
staging service. Amended text for [[oscine-tag-writeback]]:

> **Decision F — read-only fields.** ReplayGain (track/album gain and peak) is shown, never
> hand-edited: a hand-typed gain is a loudness bug. Measured values reach the file through the
> staged review like any other correction, staged only by the ReplayGain service from
> `rg_source = 'computed'` rows (see [[oscine-replaygain]] D37). …rest unchanged…

**Decision C — albums are staged whole or not at all.** An album gain is only correct if every
track of the album carries it. Staging skips an album with any track unmeasured, failed or
missing an album gain, and reports it with the reason. Singles (no `album_id`) stage track gain and
peak only.

**Decision D — mixed albums fill gaps, never overwrite silently.** When an album mixes tagged and
computed tracks, `finalizeAlbum` already computes one album gain across both. Staging writes it
to the computed tracks, and to tagged tracks whose file has no album gain. A tagged track whose
existing album gain differs from the computed one by more than 0.1 dB is staged but shown
**deselected** in the review, so the operator opts in per row. Track gain on a tagged track is
never staged.

**Decision E — Opus writes `R128_*`, never `REPLAYGAIN_*`.** RFC 7845 §5.2.1 defines
`R128_TRACK_GAIN` / `R128_ALBUM_GAIN` for Opus: a signed Q7.8 integer (1/256 dB) relative to
−23 LUFS, applied on top of the header output gain. There is no peak tag. node-taglib-sharp's
`XiphComment` writes `REPLAYGAIN_*` for Opus like any Vorbis comment, which other Opus players
ignore or double-apply. So for Opus:

- write `R128_TRACK_GAIN = round((trackGainDb − 5) × 256)` and the album equivalent, through the
  raw-field path W16-19/20 established (`PROPERTY_ACCESS`), not the portable property;
- remove any `REPLAYGAIN_*` fields in the same write;
- drop peaks.

The scanner must read them back: music-metadata does not map `R128_*` (checked:
no R128 handling in `node_modules/music-metadata/lib`), so `metadata.ts` reads them from the native
Vorbis comments and converts `gainDb = value / 256 + 5`. Without this, every Opus file `rsgain` or
`opusenc` tagged is re-measured, and our own writes never read back as `'tag'`.

**Decision E, as built (W25-5 / RG-5).** Sub-decisions settled while building the writer branch:

- **E.1 — remove the written scope's `REPLAYGAIN_*` only.** A track-gain write removes
  `REPLAYGAIN_TRACK_GAIN` and `REPLAYGAIN_TRACK_PEAK`; an album-gain write removes the album pair.
  This narrows "remove any `REPLAYGAIN_*`": a flush can carry one scope alone (a Decision D tagged
  track takes album gain only; the review lets a row be deselected), and removing the other
  scope's `REPLAYGAIN_*` would delete the file's only value for it with nothing written in its
  place. A clear removes the scope's `R128_*` and `REPLAYGAIN_*` together.
- **E.2 — peaks are refused, not silently dropped.** On Opus, a peak key in a write fails the
  file, the way a held key does (W16-17), and `ReplayGainStagingService` never stages a peak for
  a track whose `codec` is `opus`, so the review never offers one.
- **E.3 — Opus is detected from the decoded codec** (`OggOpusCodec` in the file's properties),
  not the extension, so an Opus stream in `.ogg` still gets `R128_*`. The accessor reads `R128_*`
  over `REPLAYGAIN_*` (the scanner's RG-2 precedence) and falls back to `REPLAYGAIN_*` when
  `R128_*` is absent or malformed.
- **E.4 — the R20 hold is separate from the field hold.** `OPUS_R128_WRITE_CONFIRMED`
  (`src/main/library/writeback/genericFields.ts`) is `false`, and while it is, any ReplayGain key on
  an Opus file fails the file. Unholding the four fields for FLAC, MP3, Vorbis and AAC does not
  unhold Opus. Flip it only once R20 is confirmed (open question 1).
- **E.5 — the `real` clear is `NaN`.** node-taglib-sharp's Apple ReplayGain setters test
  `Number.isNaN` and then call `toFixed`, so `undefined` throws on MP4. `NaN` removes the frame on
  every family (`written:<field>:clear` rows).

**Decision F — staged values are a snapshot; re-measuring invalidates them.** Staging copies
numbers into `track_tag_overrides`. If a later job re-measures a track, its staged ReplayGain rows
are deleted in the same transaction, so a review never offers a stale measurement. The diff
compares with tolerance (gain ±0.005 dB, peak ±1e-6) so re-staging identical values is not a
pending change.

**Decision G — the review surface, as built (W25-6 / RG-6).**

- **G.1 — "deselected" is derived, never stored.** A row starts with its album gain and album peak
  unchecked when the diff's fresh-read `current` album gain is a number and differs from the
  staged `proposed` by more than `REPLAYGAIN_MIXED_ALBUM_DESELECT_DB` (0.1). That is
  `isMixedAlbumOverwrite` in `tagWritebackModel.ts`. Other fields on the same row stay checked.
  Select all / row toggle still turn it on: that is the opt-in.
- **G.2 — R21 grouping is joined at preview.** `PendingWrite.replayGain = { albumId }` is set only
  on rows whose album gain changes and whose track has an album (`TagWritebackService`'s `albumOf`
  dep, `trackAlbumResolver`). An album is **split** when some, but not all, of its album-gain rows
  are selected. Nothing selected is not a split. A row's track gain alone is never a split.
- **G.3 — partial albums are judged against the batch as sent.** The store snapshots the rows and
  selection before Apply. An album gain lands where it was selected and its file came back written
  or skipped. A failure, a deselected row, or a file a cancelled flush never reached counts as
  left behind.
- **G.4 — the after-flush re-read (answers OQ5).** See open question 5.
- **G.5 — "staged" ignores the hold.** `Track.rgStaged` is true whenever a ReplayGain row stands in
  `track_tag_overrides`, held or not. While the fields are `held()` the rows stay out of the review
  (the pending set honours the hold), and the stage notice says so.

**Decision H — forced re-measure, as built (W25-7 / RG-7).**

- **H.1 — `forced` is a job property, stored.** `replaygain_jobs.forced` (migration 032). A forced
  job queues its scope whatever `rg_source` says, and its items land with `complete()`'s guard
  relaxed to `rg_source IS NULL OR forced`: a `'tag'` or `'computed'` value is overwritten in the
  database only. Stored rather than held in memory so a paused forced job resumes under the same
  rule. Unforced items keep the tagged-value race rule.
- **H.2 — albums travel as album ids and main expands them.** `library.startReplayGain` takes
  `{ trackIds?, albumIds?, force? }` (`ReplayGainStartRequest`), a widening of the spec's
  `{ trackIds?, force? }`. Main queues every track of each named album, never the run a browse
  predicate left visible, so Decision C still holds when the result is staged. A track selection
  stays tracks: re-measuring one track of an album re-finalizes the album gain from the others'
  stored histograms (or tag stand-ins), as any job does.
- **H.3 — a scoped start supersedes a paused or cancelled job.** Only the latest job is resumable,
  since it is the one every surface shows. An unscoped start still refuses beside a resumable
  latest job (resume it instead). A scoped start refuses only an active job and retires a paused
  one as cancelled; nothing measured is lost, and the next library-wide start re-queues what is
  still unmeasured.
- **H.4 — the context-menu entry always forces.** "Measure ReplayGain" on the library track row,
  track selection, album header run and Sources album facet (`src/renderer/panels/replayGainMenu.ts`)
  is the explicit request D37 asks for, so it re-measures tagged and measured tracks too. The
  `audio.replayGainComputeWhenMissing` gate still refuses it when off.
- **H.5 — Decision F deletions now notify.** `complete()` and `finalizeAlbums` return the tracks
  whose staged rows they dropped, and the job service sends a `tagOverrides` library change for
  them (`onStagedCleared`), so an open review re-reads.

**Revisit when.** An operator needs ReplayGain 1.0 (89 dB) compatibility; a format outside the v1
codec set; or a client asks for agent-staged ReplayGain over MCP.

## Scope

Three phases. Phase 1 alone fixes in-app loudness for untagged tracks.

### Phase 1 — start the measurement

- **Settings → Audio, "Measure ReplayGain" block**, under the existing ReplayGain settings: counts
  (tagged / measured / missing), Start, a progress bar with current track, Cancel, Resume for a
  cancelled or interrupted job. Disabled with the reason when `replayGainComputeWhenMissing` is off.
  Fix that setting's help text to name the control.
- **Post-scan nudge** (Decision A): a toast with a Measure action when a scan leaves
  `rg_source IS NULL` tracks; suppressed while a job is running.
- **Command palette:** "Measure missing ReplayGain".
- **Progress throttling.** The progress event already exists (`onReplayGainProgress`); confirm it is
  throttled main-side before a UI subscribes. An unthrottled progress stream is what froze the
  Cancel button last time.
- **New IPC** in `src/shared/ipc.ts`: `library.getReplayGainSummary` →
  `{ tagged, computed, missing, failed }`.

### Phase 2 — stage and write

- **Registry:** the four ReplayGain fields stay `readOnly: true`. The write gate in
  `writeback/engine.ts:308`, `writeback/service.ts:270` and `writeback/diff.ts:209` changes from
  "admitted and not read-only" to "admitted". The hand-edit refusal stays at `tagFields.ts:250`
  (`isEditable`) and is asserted at the `tagOverrides.*` handlers and MCP `stage_tag_changes`.
  Until their W16-16 rows are green the fields are wrapped in `held()`.
- **`ReplayGainStagingService`** (main): turns `rg_source = 'computed'` rows into
  `track_tag_overrides` rows, applying Decisions C, D and F. Returns
  `{ stagedTracks, stagedAlbums, skipped: Array<{ albumId, reason }> }`.
- **New IPC:** `library.stageComputedReplayGain({ albumIds?: number[] })`. No argument means every
  eligible album.
- **Opus path** (Decision E): a per-codec branch in `writeback/writer.ts` for the four keys, plus
  the `R128_*` read in `metadata.ts`. The Q7.8 conversion is a pure function in `src/shared` with
  its own tests.
- **Review surface:** a "Stage measured ReplayGain" action in the Tools tab write-back review. The
  rows render as the generic columns W16-18 already draws. Rows from Decision D render deselected.
- **After flush:** the flushed file is re-read and the track flips to `rg_source = 'tag'` (open
  question 5).
- **Display:** Track Info and the Tunedeck Loudness pane say where the value came from: "from
  file", "measured — not in file", "measured — staged".

### Phase 3 — re-measure

- `library.startReplayGain` takes an optional `{ trackIds?: number[], force?: boolean }`. `force`
  queues tracks whatever their `rg_source`, and the `complete()` guard
  (`WHERE rg_source IS NULL`) accepts a forced item. A forced result overwrites a `'tag'` value in
  the database only; the file is untouched until it is staged and reviewed. *Built in RG-7, with
  `albumIds` added (Decision H).*
- Library context menu, "Measure ReplayGain" on a track or album selection. Album selections are
  expanded to the whole album so Decision C can still hold.

## Test corpus

Extend the W16-16 per-field gate (`npm run probe:writeback-corpus`). Each ReplayGain field moves
from a `read:<field>` row to a `written:<field>` row: set on all five codecs, read back through
music-metadata within ±0.005. The Opus cells assert `R128_*` present, `REPLAYGAIN_*` absent, peak
not written. A field is unheld only when its whole row is green on Windows and Linux.

**Status (RG-5, 2026-11-16).** The `written:` rows are built: set and clear per codec, a
`reader:written:` read-back through the scanner's own path (music-metadata `common.replaygain_*`;
on Opus the native `R128_*` converted from Q7.8), and on Opus `written:<gain>:opus-r128` (a file
born with the scope's `REPLAYGAIN_*` ends with exactly the Q7.8 integer and none of them),
`reader:written:<gain>:opus-no-replaygain` and `written:<peak>:opus-not-written` (refused, file
byte-identical). Gains are tested off the Q7.8 grid (−7.23, −6.51) and peaks at six decimals.
**Linux: all four rows green, 595/595 checks.** The Windows run is still owed, so the fields stay
`held()`; Opus stays held by E.4 regardless.

Unit tests:

- `tests/main/replaygain/staging.test.ts` covers Decisions C, D and F: incomplete album, single,
  mixed album with matching and differing tags, invalidation on re-measure.
- The write-back engine admits a ReplayGain key from staging and refuses the same key from
  `tagOverrides.set` and MCP.
- The Q7.8 conversion round-trips, with clamping at ±128 dB.
- The scanner reads `R128_*` on Opus and ignores it on other codecs.
- A forced re-measure overwrites a `'tag'` row; an unforced one does not.
  `tests/main/replaygain/forcedRemeasure.test.ts` (RG-7: also album expansion, pause/resume under
  the forced rule, supersession, the change notification, the request validator).
- Renderer: the summary and progress model, with no `@renderer` imports and no DOM.
- RG-6: `tests/renderer/panels/tools/tagWritebackModel.test.ts` (Decision D rows, split album,
  partial after apply, stage notice), `tests/main/replaygain/afterFlush.test.ts` (OQ5, album join,
  `rgStaged`), `tests/renderer/panels/signalReadout.test.ts` (source labels).

## Risks

**R20 — Opus output gain.** Correct `R128_*` values assume the decoded PCM we measure already
includes the header output gain. If our decode path ignores it, every written Opus gain is off by
exactly that header gain. Verify before Phase 2 (open question 1): a fixture with a non-zero
output gain, measured, written, and checked against `rsgain`.

**R21 — album inconsistency through partial flush.** Staging is album-whole (Decision C), but the
review lets the operator deselect rows, and one file can fail its flush. Either leaves an album
with mixed album gains. Mitigation: the review warns when a selection splits an album, and the
apply summary lists albums left partial. Album-atomic flush is not attempted: it would mean
multi-file rollback, which the writer deliberately does not do. *Built in RG-6 (Decision G).*

## Open questions (check before carding)

1. Does the Opus decode path (worker analyzer and playback) apply the header output gain? (R20)
   *Still open (RG-2, RG-5).* The worker's node-web-audio-api `decodeAudioData` rejects Opus
   outright ("unsupported audio codec"), so no computed Opus gain exists yet, and `rsgain` was not
   available to cross-check. Opus writes are held by Decision E.4 until there is an Opus measure
   path and a non-zero-output-gain fixture agrees with `rsgain`.
2. Does a rescan that detects changed file content reset `rg_source = 'computed'` back to NULL?
   If not, a replaced file keeps a stale measurement.
   *Answered (RG-7): no.* The scanner re-parses only on an mtime/size change, and `upsertTrack`
   (`src/main/library/store.ts`) keeps every `rg_*` column and `rg_source = 'computed'` whenever the
   re-read file has no ReplayGain. A replaced file without tags keeps its stale measurement and is
   never re-queued by an unforced job. A file that now carries tags overwrites it with `'tag'`
   (correct). The forced context-menu measure is the manual workaround; the fix is a scanner rule
   (reset a computed row to NULL when content changed), carded separately rather than folded in
   here.
3. Are podcast episodes in `tracks`, and does `createJob` queue them? `fermata-design` says
   podcasts do not inherit album ReplayGain. They should be excluded from album finalisation and
   from staging.
4. How does node-taglib-sharp format peaks per tag type (ID3 `TXXX`, Apple freeform, Xiph)? Gains
   are `toFixed(2) + " dB"` in `xiphComment.js:684`; peaks should be six decimals.
   *Answered (RG-5):* node-taglib-sharp 6.0.3 writes peaks as `toFixed(6)` and gains as
   `toFixed(2) + " dB"` on ID3v2 `TXXX`, Apple freeform (`com.apple.iTunes`), Xiph and APE. ASF
   gains carry no " dB". Pinned in `tests/main/library/writeback/opusReplayGain.test.ts`. See E.5
   for the Apple clear.
5. Does the write-back flush re-index the file, or does `rg_source` flip to `'tag'` only on the
   next scan?
   *Answered (RG-6):* the flush did not re-index; only the next scan (new mtime) would have
   flipped it. Now `retireWrittenOverrides` re-reads a file whose flush carried a ReplayGain key
   (`src/main/replaygain/afterFlush.ts`, through the scanner's `readTrackTags`). If the file has a
   track gain, the row takes all four file values and `rg_source = 'tag'`, as a scan would. If it
   has an album gain only (track gain deselected), only the album columns refresh and the source
   stays `'computed'`. **Known gap:** the next *scan* of that album-only file sets `'tag'` with a
   null track gain and drops the measured track gain from the row. The upsert treats any file
   ReplayGain as authoritative. Still owed: a scanner rule that keeps a computed scope the file
   lacks.

## Card map (proposed)

- **RG-1** Measure control, summary IPC, post-scan nudge, palette command, help-text fix.
  Phase 1.
- **RG-2** Opus `R128_*` read in the scanner and the shared Q7.8 conversion. Independent;
  lands first in Phase 2.
- **RG-3** Write gate change and the hand-edit refusal asserted at every entry point. Fields
  `held()`.
- **RG-4** `ReplayGainStagingService`, the stage IPC, and invalidation on re-measure.
- **RG-5** Writer Opus branch, W16-16 `written:` rows, then unhold. Windows run required.
- **RG-6** Review action, deselected mixed-album rows, split-album warning, source labels.
- **RG-7** Forced re-measure and the selection context menu. Phase 3.

## Non-goals

- Writing anything without the review. No "write tags after measuring" setting.
- Hand-editing gain or peak, in the editor or over MCP.
- ReplayGain 1.0 / 89 dB reference, or a choice of target loudness.
- Clipping prevention beyond the existing peak handling in `normalization.ts`; no limiter.
- Measuring at rip time. The CD rip path still picks files up through the scan.
