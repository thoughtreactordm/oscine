---
title: Oscine — Tag Write-Back
created: '2026-08-28T00:13:28.408Z'
updated: '2026-09-24T00:00:00.000Z'
---
# Oscine — Tag Write-Back

Design authority for **W16 "Tag Write-Back"**: the opt-in flush of app-side metadata
corrections into the source audio files. This is the last major feature gated before a 1.0
release candidate. It owns one new decision — **D28** — and executes the revisit trigger that
[[fermata-design]]'s **D7** deliberately deferred.

## Why this exists — the D7 relationship

D7 reads:

> "Tags are parsed on scan; corrections live in `track_overrides` and never touch files in
> v1." Rationale: zero corruption risk while the library layer is young. **Revisit when:**
> write-back is roadmapped as an explicit opt-in once there is a test corpus and atomic-write
> handling.

D7 did not forbid write-back; it **scheduled** it behind two named preconditions. This stream
is that trigger firing, the same way D19 legitimised scrobbling against D14 rather than
reopening it. The two preconditions are not afterthoughts — they are cards (W16-3 test corpus,
W16-2/W16-4 atomic-write and rollback) and their absence blocks the flush from shipping.

The operator problem that forces it: bad genres (and other junk tags) live in the *files*. The
app-side layers ([[fermata-listening-and-scrobbling]]'s `track_genres`, W15's `track_tags`) let
you correct what you *see*, but a library wipe or a move to a new machine re-scans the same
remote files and the junk returns. Correcting the app index without correcting the source is a
treadmill. Integrity has to reach the source.

## D28 — Corrections flush to files as an explicit, staged, atomic opt-in

**Decision.** The app-side correction layers remain the live, instant, reversible working
surface (D7's `track_overrides`, W15's `track_tags`). A distinct, operator-initiated action
computes a diff from those layers and writes it into the actual file tags — staged behind a
review gate, backed up, applied atomically per file, and reported per file. Nothing is written
to disk implicitly, on edit, or on scan.

**Rationale.** The hybrid keeps every editing interaction corruption-free and reversible (edits
are DB rows until the operator commits), while still delivering true source integrity on
demand. "Explicit opt-in" is D7's own wording; a staged batch with a review diff and a backup
is the strongest reading of it. Immediate per-edit writes were rejected: they touch remote
files on every keystroke and offer no gate before mutating bytes. Sidecar files were rejected:
they survive a wipe without mutating audio but pollute the operator's folders and are invisible
to every other player, so they do not actually normalise "how the data gets sourced".

**Revisit when.** Automatic/continuous write-back is requested (a "keep files in sync" mode), or
a format outside the v1 codec set needs writing. Neither is in scope for 1.0.

## Scope

The full tag surface is in scope, phased so the operator's genre pain is solved first and the
largest edge-case surface ships last:

- **Core text tags** — title, artist, album, track no, disc no, **genre**, year.
- **The full portable tag surface** (1.1, W16-14 – W16-18) — album artist plus every field
  node-taglib-sharp's portable `Tag` models: credits, totals, sort fields, comment, lyrics,
  compilation flag, the MusicBrainz ids and the rest. See "The full tag surface" below
  (Decisions D–H).
- **Genre normalization** — a library-wide canonicalization/alias engine (D28 sub-surface),
  because the pain is *bulk* junk, not one-off typos.
- **Embedded artwork** — APIC (ID3) / METADATA_BLOCK_PICTURE (Vorbis/FLAC). Written through a
  persistent correction layer, replacing only the front cover — see "Embedded artwork & custom
  frames" below for the settled decisions.
- **Arbitrary/custom frames** — round-tripped, not dropped, when present. Already true of the
  W16-2 engine (in-place tag edit) and gated by W16-3; W16-13 hardens the coverage.

Codec coverage is the v1 set and no more: `flac | mp3 | vorbis | opus | aac`. ID3v2 backs
mp3/aac; Vorbis comments back flac/vorbis/opus. Anything else is out of scope and the write
engine refuses it explicitly rather than guessing.

## Architecture

### The diff model (W16-1)

A **pending write** is the unit that gets reviewed and flushed. For a track it is the field-level
delta between what the file currently holds and what the merged app-side layers say it should
hold. The merge, in precedence order:

1. `track_overrides` (D7) — title/artist/album/track/disc, **extended here with `genre` and
   `year`**, and in 1.1 with `album_artist_name` (Decision E). The generic fields sit beside it
   in `track_tag_overrides`.
2. W15 `track_tags` where `source IN ('user','suggested')` — the free-form user layer, already
   named by W15 as "precisely the diff to flush".
3. Canonicalization output (W16-5) — normalized genre values derived from the alias/rules table.

The diff is computed in the main process against a fresh read of the file, never against the
cached `tracks` row, so a file changed out-of-band by another tool is detected rather than
clobbered.

### The write engine (W16-2)

Main-process only — the renderer never touches the filesystem (project invariant). Per-codec
writers behind one interface: an ID3v2 writer for mp3/aac and a Vorbis-comment writer for
flac/vorbis/opus, plus the two picture-block encodings for artwork. **Audio stream bytes are
never rewritten** — only the tag region.

**Library selection is a sub-decision of W16-2, not a given.** The constraint is the native-ABI
packaging surface CLAUDE.md warns about: sharp and node-web-audio-api already force a
platform-specific prebuilt-addon dance and a CI matrix. A pure-JS tag writer avoids adding a
third native addon and a third `verify:native` concern. `node-taglib-sharp` (pure-TS taglib
port, writes ID3 + Vorbis + FLAC + pictures) is the leading candidate for that reason; the
card confirms it round-trips all five codecs on both platforms before it is adopted. Note the
existing `music-metadata` parser is read-only and cannot be the writer.

The engine edits the tag **in place** — it opens the container with taglib, mutates only the
modelled setters, and re-serialises the tag taglib already parsed. Frames the model never
touches (artwork, custom/arbitrary frames, ReplayGain) therefore survive any scalar write by
construction, not by explicit copy. This is what makes custom-frame round-tripping a
test-hardening job (W16-13) rather than new engine logic.

### Atomic write + backup + rollback (W16-2 / W16-4)

The literal discharge of D7's "atomic-write handling" precondition:

- Write to a temp file in the same directory, `fsync`, then atomic `rename` over the original.
  Never mutate the original in place.
- Before the rename, capture the original tag block as a backup so a bad write is recoverable
  without a full-file copy of a large FLAC.
- After the rename, re-read and verify the tag reads back as intended; on mismatch or failure,
  roll back and report that file as failed. One file's failure never aborts the batch.
- Cross-platform: temp-and-rename respects the relative-path/root rules; no backslash literals,
  no platform branches.

### Embedded artwork & custom frames (W16-9 – W16-13)

W16-8's investigation settled three questions the scope left open. The *preservation* half is
already done — the W16-2 engine edits tags in place, so artwork and unknown frames survive any
scalar write, and the W16-3 corpus already gates `preserved:artwork` / `preserved:custom-frame`.
What remained is *writing* artwork, which unlike every text field has no app-side source layer.

**Decision A — artwork gets a persistent correction layer, like every other field.** A chosen
cover is stored app-side, not held transiently in the review session. This keeps the flush a
stateless projection of the correction layers (D28) and the R7 fresh-read discipline intact, and
it makes a set cover show *instantly everywhere* — Now Playing, the library grid — not only after
a flush+rescan. Rejected: a transient pick staged only inside the review session; it diverges
from D28, shows nothing until flushed, and is lost if never applied.

**Decision B — replace the front cover, preserve the rest.** A write replaces only the
front-cover picture (ID3 APIC type 3 / the front-cover `METADATA_BLOCK_PICTURE`); back covers,
booklet scans and artist images are left untouched, and a *remove* clears only the front cover.
Rejected: normalize-to-one, which silently destroys curated secondary art in a poweruser library.

**Decision C — the cover is set at album granularity.** Setting a cover on a multi-track
selection fans out to one per-track override row each; storage stays per-track (uniform with
`track_overrides` and W16-7's per-track reconciliation), and the editor's existing `mixed` state
covers compilations whose tracks disagree.

**Where the cover lives.** A new `artwork_overrides` table (migration 021 — 020 was taken by the
genre-alias table before this landed) carries a tri-state
per track, mirroring how a text override distinguishes *clear* from *absent*: no row → leave the
file's own cover; a row with an `image_hash` → set to that image; a row with `image_hash IS NULL`
→ clear the cover on flush. The full-resolution original bytes live in a content-addressed
override-originals store (a new user-data artifact, the same pattern as the thumbnail cache),
keyed by hash so a shared album cover dedupes and GC is a refcount over the hash. Library
cover-resolution coalesces `override.image_hash ?? tracks.artwork_hash` — this is what makes a set
cover visible before it is ever flushed, and it is the one read-path change the feature requires.

**Ingest** is main-process only (the renderer never touches the filesystem). A file-dialog path
(renderer asks main to open `dialog.showOpenDialog`; main reads, validates with sharp, stores,
returns a reference) is required; a drag/drop/paste path that ships a user-provided `Blob`'s bytes
one-way to main is a stretch. Bytes never enter a `PendingWrite` or a report — artwork crosses the
diff as an `ArtworkRef` (present + hash + mime, resolved to an `oscine://` thumbnail), never
inline, because a batch is thousands of tracks.

**Engine.** `WritableTags` gains an artwork intent (`unchanged` / `clear` / `set` with
bytes+mime), resolved fresh from the override store at apply time (same R7 discipline as text).
`applyWritableTags` replaces or removes only the front-cover picture, leaving all other pictures
in place. Verify-after-write (W16-4) extends to confirm the written cover bytes read back by hash
— R6 now covers a binary payload; the tag-block backup already captures pictures, so rollback is
free.

**W16-7 interaction — owned by W16-9, not a W16-7 follow-up.** W16-7's retire-on-match
reconciliation is already built, for `track_overrides` only. Because `artwork_overrides` does not
exist yet, W16-9 reaches into that completed pass and adds the artwork case: retire a satisfied
`artwork_overrides` row (the file's front cover matches the override image) and decrement the
originals-store refcount, or the override cache grows without bound (R8).

### Staged review UI (W16-6)

Pending writes accumulate and are surfaced as a review diff — old → new, per field, per track —
with per-row and per-field select/deselect. Apply runs the batch with live progress and a
per-file success/failure summary. This is a W4 panel-island surface and inherits the
virtualization invariant (the batch can be thousands of tracks). Artwork joins as one more
selectable field (W16-12): an old-thumbnail → new-thumbnail row with the same select/deselect.

### Re-scan reconciliation (W16-7)

The card that actually closes the operator's loop. After a successful flush the file tag equals
the correction, so the override has done its job. The card decides the override lifecycle:
retire the override once `file == override` (the index rebuilds identically from the now-correct
source), versus retaining it as an audit trail. Default lean: **retire on match**, because the
whole point of D28 is that the source no longer needs an override — a wiped, re-scanned library
must read clean with an empty `track_overrides`. Whatever is chosen is tested against a
scan → correct → flush → wipe → re-scan round trip. This pass is built for text overrides; **the
artwork case is added by W16-9**, which extends the same retirement to release `artwork_overrides`
rows and their originals-store refcount (see artwork above).

### Genre canonicalization engine (W16-5)

A library-wide mapping/alias table (`'hiphop'`, `'Hip-Hop/Rap'`, `'Rap'` → `'Hip-Hop'`) applied
across matches on the same casefold key `track_genres` already uses, so it unifies with W15's
chip surface rather than inventing a second taxonomy. **This lives in W16, not W15**, because
normalizing and flushing are one operator action — clean it, then commit it to source — and the
canonicalized value is an input to the diff. W15 owns the free-form user vocabulary; W16 owns the
rules that collapse the vocabulary and the flush that persists the result.

### The full tag surface (W16-14 – W16-18)

The 1.0 field set was never a considered limit. It is D7's schema-v1 `track_overrides` —
title/artist/album/track/disc, the columns the library materialises, because the layer's first
job was correcting what the operator *sees* — plus W16-1's genre and year. Once corrections reach
the file, "what the library displays" stops being the boundary, and its gaps show: a ripped
compilation needs an album-artist frame the operator cannot author, so it shatters into one album
per performer. The settled position (2026-09-24):

**Decision D — the editable surface is node-taglib-sharp's portable `Tag`.** Every field the
library's own writer models identically across the three tag families (ID3v2, Vorbis comments,
MP4) is editable — roughly forty, listed below. That boundary is chosen because it is the one the
flush can *verify*: a portable property reads back through the same accessor it was written
through, so verify-after-write stays a per-field equality on all five codecs. **A field enters the
registry only when the W16-3 corpus round-trips it green on all five codecs**; one that fails a
codec is a triage card and is offered nowhere until fixed, so the editor never grows per-codec
holes. Rejected: raw format-native frames (arbitrary Vorbis keys, ID3 `TXXX`, MP4 freeform atoms).
They have no cross-codec identity, so one "field" becomes three different writes with three
different verifications, and the corpus guarantee stops meaning anything. Custom frames stay what
they are today — round-tripped untouched, never edited.

**Decision E — two tiers: grouped fields are bespoke, everything else is generic.**

- *Grouped* — title, artist, **album artist**, album, track, disc, year, genre. These are the
  fields the library keys browse on, so an edit re-keys rows (`albums` is `UNIQUE(title,
  album_artist_id)`; the Artist facet is `COALESCE(album_artist_id, artist_id)`) and each needs
  hand-written apply/revert in the store. Album artist is the only new member: `track_overrides`
  gains `album_artist_name`, and setting it moves the track to the `(album, album artist)` album
  row — which is what folds a compilation back into one album.
- *Generic* — everything else. None of it affects browse, so it rides one path: a typed
  **field registry** in `src/shared` (key, label, group, kind — `text | int | bool | list` — the
  taglib property, read-only flag) drives the editor, IPC validation, the diff, the writer and
  verify, the way W8's settings registry drives the settings surface. Adding a field is one entry
  plus its corpus check. Overrides live in one key/value table, not a column per field.
- Generic fields are **read from the file on demand, through taglib**, never indexed at scan.
  The scan path and `tracks` stay untouched, the value the editor shows is in the same
  representation the writer writes and verify compares, and it is already how the diff works —
  against a fresh read, never a cached row (R7). Retirement reuses the post-flush
  `retireWrittenOverrides`: a verified write proves `file == override`, so the rescan pass never
  needs to read these fields.

**Decision F — read-only fields.** ReplayGain (track/album gain and peak) is shown, not edited:
the app computes and writes it through its own path, and a hand-typed gain is a loudness bug.
The **MusicBrainz ids are editable**, in an "Advanced" group rather than hidden — the disc lookup
and a tagger fill them, and an operator correcting a mismatched release must be able to fix
them. Excluded outright: `amazonId` and `musicIpId` (dead services), `dateTagged` (writer
bookkeeping), `performersRole` (a per-performer structure, not a field), and the derived
`first*`/`joined*` accessors. Pictures stay on the artwork path (Decisions A–C).

**Decision G — multi-value.** Fields the library does not group on (composers, the sort lists)
are written as native multi-value frames and edited as lists. **Artist and album artist stay
single-value**: the library holds one `artist_id` per track and one `album_artist_id` per album,
and multi-artist identity is a schema redesign, not a field. Genre keeps W16-3's single
`'; '`-joined convention, because that is the form the scanner reads back to the same set.

**Decision H — the compilation flag is just a tag.** `isCompilation` is editable and flushed,
and changes nothing about grouping. The album-artist fallback in the scanner is untouched; a
compilation groups correctly because it carries an album artist, not because it carries a flag.

**Revisit when.** An operator needs a format-native frame no portable property covers (that is
a per-codec editor and its own decision), or multi-artist identity is scheduled (Decision G
falls with it).

The generic registry, grouped by the editor's sections:

| Group | Fields |
|---|---|
| Credits | composers (list), conductor, remixed by |
| Numbering | track total, disc total |
| Release | subtitle, grouping, publisher, copyright, ISRC, compilation (bool) |
| Content | comment, description, lyrics, BPM (int), initial key |
| Sorting | title sort, artist sort (list), album-artist sort (list), album sort, composer sort (list) |
| Advanced | MusicBrainz artist / release-artist / release / release-group / track / disc id, release status, type, country |
| Read-only | ReplayGain track gain, track peak, album gain, album peak |

Lyrics is the raw embedded frame W17 reads as its tier-2 source. Editing it here is editing the
file's own tag; it does not put W17's fetched lyrics into files, which stays out of scope.

## Schema

Migration 017 (next free; W13 reached 016):

- **`track_overrides`** gains `genre TEXT` and `year INTEGER`. Existing columns unchanged.
- **Canonicalization** — a `genre_aliases` table mapping a casefolded alias to a canonical
  label (plus an `enabled`/scope column if per-root rules prove necessary; start global). The
  exact shape is W16-5's to finalise against the casefold key contract.
- No "pending writes" table is required — pending state is the computed diff over the existing
  correction layers, held in the renderer for the review session. A durable audit of *what was
  flushed and when* is a W16-7 option, not a v1 requirement.

Migration 021 (artwork, W16-9 — the artwork migration landed as 021, after 020 genre-aliases):

- **`artwork_overrides`** — a per-track tri-state cover override: no row → the file's own cover;
  `image_hash` set → set to that image; `image_hash IS NULL` → clear the cover on flush. Carries
  `mime` and `created_at`.
- **Override-originals store** — a new content-addressed user-data artifact holding
  full-resolution cover bytes keyed by hash (the flush writes these into the file; thumbnails
  will not do). Refcounted over `image_hash`; GC on override retire/discard.

The full tag surface (1.1) — numbered at landing; W17's pending lyrics migration must be
sequenced against it:

- **`track_overrides`** gains `album_artist_name TEXT` (W16-14). Existing columns unchanged.
- **`track_tag_overrides`** (W16-15) — `(track_id, field, value)`, primary key `(track_id,
  field)`, `ON DELETE CASCADE` from `tracks`. `value` is JSON: no row → the file's own value;
  a JSON value → set; JSON `null` → clear the frame on flush. `field` is a registry key; an
  unknown key is preserved, not dropped, so a branch switch does not destroy corrections.

## Risks

- **R6 — tag-write corruption (high, architectural, new).** Writing into a container is the one
  operation in Oscine that can destroy an operator's file. Mitigation is the whole atomic +
  backup + verify + rollback chain (W16-2/W16-4) and the test corpus (W16-3); it is why D7
  deferred this until the library layer matured. Nothing flushes until round-trip verification
  passes on all five codecs on both platforms. **Artwork (W16-11) brings a binary payload under
  the same chain — verify-after-write compares the written cover bytes by hash.**
- **R7 — out-of-band file drift (medium).** Another tool edits a file between scan and flush.
  Mitigated by diffing against a fresh file read (W16-1), not the cached row, and by
  verify-after-write.
- **R8 — artwork override-store growth (low, new).** The persistent artwork correction layer
  retains full-resolution originals; without a refcount GC tied to the override lifecycle
  (W16-9 extends W16-7's retire-on-match, plus discard), the originals store grows unbounded.
  Mitigation: a content-addressed store refcounted over `image_hash`, released the moment no
  override row references a hash.
- **R3 (existing) interaction.** A flush touches files the watcher watches; the resulting
  change events must be recognised as self-inflicted and not trigger a redundant rescan storm.

## Test corpus (W16-3) — a precondition, not a nicety

D7 names it explicitly. A synthesised mixed-format fixture with known-bad tags across all five
codecs, embedded artwork, and at least one custom frame, plus round-trip write → read → verify
tests. It follows the existing fixture-synthesis discipline (`probe:fixture`,
`seed:synthetic`): generated, not scavenged, so both platforms measure the same thing. The M-gate
philosophy applies — this is a gate, and anything it flags becomes a triage card rather than a
quiet fix folded into the flush path. **W16-13 extends it** with multiple pictures (front + back),
a binary custom frame and a multi-instance custom frame, and the matching `written:artwork` /
`preserved:back-cover` / `removed:artwork` / `preserved:custom-frame` checks — round-tripped
through both taglib and the app's `music-metadata` reader. **W16-16 extends it** with one
`written:<field>` check per registry field on all five codecs (set, clear, and a multi-value
case for list fields), and `written:album-artist` read back through `music-metadata` too, since
the scanner groups on it. A field's check going green is what admits it to the registry
(Decision D).

## Card map

- **W16-1** Diff model & schema (migration 017; `track_overrides` += genre, year; merge/precedence)
- **W16-2** Atomic tag-write engine (main; per-codec writers; library selection; temp+rename+fsync)
- **W16-3** Test corpus (mixed-format fixture, round-trip verify) — *D7 precondition*
- **W16-4** Backup & rollback (original-tag backup, verify-after-write, per-file failure isolation)
- **W16-5** Genre canonicalization engine (`genre_aliases`, casefold-unified with W15)
- **W16-6** Staged batch review UI (diff old→new, select/apply, per-file reporting)
- **W16-7** Re-scan reconciliation (override lifecycle; scan→correct→flush→wipe→rescan round trip)
- **W16-8** Artwork & custom frames — *epic; investigation done, split into W16-9 – W16-13*
- **W16-9** Artwork override layer (migration 021; tri-state `artwork_overrides`; content-addressed
  originals store; override-aware cover resolution; refcount GC; extends W16-7 retirement)
- **W16-10** Artwork ingest (main-process `dialog.showOpenDialog` + one-way `setFromBytes`; sharp
  validation; per-album fan-out)
- **W16-11** Engine picture write + byte-level verify (replace-front-cover-preserve-rest; artwork
  under the backup/rollback chain)
- **W16-12** Artwork model + review UI (`ArtworkDiff`, `WritebackField` += `artwork`; editor cover
  panel; review artwork row)
- **W16-13** Corpus hardening + custom-frame round-trip (multi-picture + binary/multi-instance
  frames; new gate checks)
- **W16-14** Album artist as a grouped field (`track_overrides.album_artist_name`; album re-key
  on apply/revert; diff, write, verify; editor field)
- **W16-15** Tag field registry + generic override store (`src/shared` registry;
  `track_tag_overrides`; IPC set/revert + validation; edit-state folding)
- **W16-16** Corpus extension — per-field round-trip on all five codecs; the registry admission
  gate
- **W16-17** Generic read + diff/write/verify from the registry (on-demand taglib read; flush and
  retirement)
- **W16-18** Editor + review UI for the full surface ("All fields" sections, list and bool
  inputs, read-only ReplayGain, review rows)

## Non-goals

- Automatic or continuous sync (D28 revisit trigger).
- Writing formats outside the v1 codec set.
- A second tag taxonomy divorced from genre (W15 already unified them).
- Editing format-native frames no portable `Tag` property covers (Decision D), or
  multi-value artist identity (Decision G).
- Rewriting audio stream bytes for any reason (transcode, re-gain-in-file, etc.).
- Re-encoding or downscaling the operator's chosen cover on write — the original bytes are
  preserved; ingest validates and caps, it does not transcode.
