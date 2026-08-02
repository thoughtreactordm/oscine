---
taskId: 01KYTKX6KVWZ5K9055BCMFSFBY
title: Play history trail — store and pane
status: in-review
priority: medium
labels:
  - M5
  - phase-1
  - library
workstream: W7
workstreamId: W7-4
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 9
created: '2026-07-30T22:56:46.714Z'
updated: '2026-08-02T16:17:25.798Z'
---
## Scope

- A main-process play-history store that does not exist yet: append-only, with a stated cap or time window.
- Schema migration for the table, plus IPC to read recent plays.
- A reverse-chronological deck pane with jump-back.

## Acceptance

- Migration adds the table cleanly; history survives restart.
- Jump-back replays from the trail without corrupting queue state — checked against the §5 rules, since this is a new way to change what plays next.
- The cap or eviction policy is stated in the card and covered by a test, not left implicit.
- Whether history belongs in **D11**'s export bundle is decided explicitly and recorded in the design doc. It is genuinely arguable both ways; what is not acceptable is deciding it by omission.

## Notes

Makes the deck a session view rather than a track inspector. The D11 question is the real content of this card — the pane itself is easy.

---

## Built — `56e029b`

The card said the D11 question was the real content and the pane was easy. Both
held. Two decisions are stated first, because everything else follows from them.

### D11: the trail is **excluded** from the export bundle

Recorded as a dated amendment under D11 in the design doc, with its revisit
trigger.

The argument that settles it is what the three things D11 already carries have
in common. Playlists, ratings and play counts are all statements **about
tracks**, and they are aggregates: two machines' play counts add, two machines'
ratings resolve by recency, a playlist is a set that merges or stays separate.
A trail is a statement about **a session on one machine at one time**. Merging
two of them interleaves listening that never happened into one false
chronology, and whichever rows then fall past the cap are discarded by an
accident of the merge order rather than by age on either machine. There is no
merge rule that is right, so there is no import.

Same *shape* as D14 excluding `cache.db`, but not the same reason, and the
difference is worth keeping straight: the cache is derived and deletable
without loss. The trail is neither. It is simply not portable.

*Revisit when*: a card makes `tracks.play_count` derived from `play_history`
rather than a counter in its own right. At that point the trail becomes the
source of something the bundle already carries, and carrying the derived value
while dropping its source would be the incoherent option.

Nothing asserts this yet, because the export bundle is W6 and does not exist.
When it lands, the test W7-8 already carries for `cache.db` is the shape.

### A play is recorded when the transport commits to a track — skips included

The other arguable one. A trail answers two questions, and they pull in
opposite directions: "what have I been listening to" wants a threshold, and
"what *was* that thing I just skipped past" wants none. Jump-back exists for
the second, so a listened-threshold would omit the single row an operator is
most likely to go looking for. The trail is a record of what the transport did.

The consequence is stated rather than smuggled: **this card deliberately does
not write `tracks.play_count` or `tracks.last_played_at`.** Those two columns
have been sitting in schema v1 unwritten since M1 and they want the *other*
definition. Driving them from this event to save a second write would inflate
them with skips — and that number is one D11's bundle actually carries. They
stay unwritten until a card owns them.

### Jump-back is a detour, and §5 needed no amendment

The card asked for this to be checked against all seven rules. It was, and the
finding is that jump-back is rule 1's first arm and nothing more. Recorded as a
dated note in §5 so nobody re-litigates it.

The row goes to the head of the **user tier** and plays out of turn. Rule 1
does the rest: a user entry is a detour, so the resume position stays and
playback returns to the interrupted row when the replayed track ends. Rule 2
holds because a detour moves neither `playingPlaylistId` nor the anchor. Rule 3
is not engaged — it governs playing *from a playlist*, and this plays from the
trail. The session tier survives for a mechanical reason worth stating:
staleness is measured against the anchor, and a user entry carries no order
index of its own, so there is nothing to invalidate.

The reading **not** taken was "re-enter the scope this played from, at the
position it played at". More literal, and worse three ways: it would set
`playingPlaylistId`, rebuild the order and replace the session tier, so a jump
back to something heard twenty minutes ago would silently discard a queue the
operator spent ten minutes building; it needs a scope stored per row, which
goes stale the moment a playlist is edited and needs reconciling when one is
deleted; and it is not what anyone who just wanted to hear a thing again was
asking for. `play_history` therefore stores no scope — three columns, and that
is the reason.

Because it is composed from `enqueueNext` + `playQueued`, the "does not corrupt
queue state" criterion is mostly inherited from verbs W5-5 and W7-2 already
tested, rather than being a fourth implementation of the same clamp.

**One hole this exposed and closed.** `playQueued` returns early when nothing
is playing — the finding W7-2 filed and left alone. History *survives restart*
and the transport does not, so the very first gesture after a launch is a
jump-back with `position` null, which would have silently done nothing. That is
the one branch: with nothing playing there is no detour to take and no position
to resume, so `replay` starts a one-track order instead. Driven live from a
cold start, because it is exactly the case a unit test is easy to write around.

### The cap: 500 rows, evicted from the bottom on write

A **row cap rather than a time window**. A window's storage is unbounded — a
fortnight is a hundred plays for one operator and four thousand for another —
while a cap states the disk cost outright. Five hundred plays is roughly
thirty-three hours of listening, which is a session view rather than an
archive, and it is small enough that the trail is read whole in one request:
there is **no page two, because the cap is the page**. That is also why
`history.list` takes a bare `limit` and returns a bare array rather than the
`{ rows, total }` shape every other windowed channel uses.

Eviction is a rowid range — `DELETE FROM play_history WHERE id <= inserted -
cap` — rather than `NOT IN (SELECT … LIMIT cap)`. Exact here for one reason:
nothing is ever deleted from the top, so ids stay monotonic and "older" and
"lower id" are the same statement. Under the cap the bound goes negative and it
is an index seek matching nothing.

The trail is **ordered by `id`, never by `played_at`**. A system clock can go
backwards — an NTP correction, a laptop waking in another timezone — and a row
id cannot. The two disagree only when the clock was wrong, and the id is the
one still right about the sequence. `played_at` is displayed and nothing else,
which is why it carries no index.

`ON DELETE CASCADE`, because a trail row that cannot be played is not worth
keeping. Quiet in practice — an incremental rescan upserts on `(root_id,
rel_path)` and deletes only when a file is genuinely gone — but a file *moved*
between folders reads as a delete plus an insert, so its history goes with it.
The accepted cost of not denormalising a title into every row.

### `playstart`, and why it is not `trackchange`

The trail needed "a track began playing" and the scheduler only published "the
audible track is now this, at this position". They are not the same event:
`retarget` republishes `trackchange` for a track that is *already playing* when
a shuffle toggle permutes the order underneath it, so counting plays off it
would count a shuffle as a listen. `playstart` is emitted from the two — and
only two — places a play actually starts: the move inside `#goTo` and the
boundary in `#onNaturalEnd`.

Repeat-one comes back through the boundary and **is** a second play, so it
fires again rather than being deduplicated by track id. The pane collapses
consecutive replays into one counted row; the scheduler does not pretend the
pass did not happen. That split is what keeps the store append-only while the
surface stays readable.

The controller takes it as an `onPlayStarted` sink rather than reaching for the
store, for the reason everything else there is injected: the trail is a
main-process table behind IPC, and a controller that could reach it could not
be driven under the node test config. Voided, never awaited — nothing about a
track change may wait on a database write, and the store's `record` cannot
reject.

### Surface

`shared/history.ts` is the contract and carries both decisions above in prose.
Main: `history/{store,service}.ts`, its own service on the same connection
following `library/playlists`, borrowing `TRACK_PROJECTION` rather than
restating those columns. Migration 009. Three channels. Renderer:
`stores/playHistory.ts`, `tunedeck/playTrail.ts` (headless rows) and
`TrailPane.vue`. Registry: one line in `tunedeck/panes.ts` — `Tunedeck.vue`
untouched for the third card running, which is what the W7-1 seam was for.

`INSERT … SELECT ? WHERE EXISTS` rather than letting the foreign key decide: a
rescan removing a file out from under an audible track is a race, and
`foreign_keys = ON` would surface it as a thrown constraint error over a track
that is still playing. It is a `changes` of zero, which is what it actually is.

The trail is loaded once per app run, on pane mount rather than at store
creation — the deck is shut on most launches and this is five hundred display
rows. No push event from main: every row main writes is one this renderer asked
for. A second window would need the broadcast, and inventing the channel now
would be inventing the reconciliation too.

A **Clear** button, because a record of what someone listened to is theirs to
drop, and nothing else in the app reads the table — which is also half the
argument for it being out of D11's bundle.

### Tests — 40 new, 1,702 pass

- `tests/main/history/playHistory.test.ts` (13) — real migration list, real
  SQLite file, not `:memory:`, because two claims are about the database
  outliving its process. Cascade deleting the *row* rather than merely hiding
  it, the null for an absent track, append-not-collapse, ordering by id against
  a clock that went backwards, the cap evicting from the table, the
  under-cap no-op, clamping, and the trail read back through a second
  connection after a close.
- `tests/renderer/panels/playTrail.test.ts` (16) — the collapse (consecutive
  yes, non-consecutive no), the run keeping its newest entry, the four label
  bands, the future-stamp clamp, and that only the head can be marked playing.
- `tests/renderer/playback/scheduler.test.ts` (+4) — `playstart` once per
  start, again at a boundary, **silent under `retarget`** while `trackchange`
  republishes, and twice under repeat-one.
- `tests/renderer/playback/controller.test.ts` (+11) — jump-back against every
  piece of state it could have moved, resume at the interrupted row, the
  cold-start fallback, replaying the audible track without stranding an entry;
  and the sink reporting skips, replays, and *nothing* for a shuffle toggle.

`tests/main/db/schema.test.ts` and the two settings migration tests hardcoded
the head schema version in five places. Replaced with `MIGRATIONS.length` —
`migrate` already refuses a non-contiguous registry, so the length *is* the
head, and the literal only bought four files to edit per migration. The ordered
list of migration names is the assertion worth having and it kept the new entry.

### What only the app could tell us

Scratch second instance, throwaway user-data dir, the `probe:fixture` library —
the operator's app and library untouched.

- **Migration**: `v0 to v9 (… theme-keys, play-history)` on first open.
- **Recording**: play, then three fast skips. All four in the trail, newest
  first, head marked **PLAYING** — and the three skipped tracks are there,
  which is the decision above working rather than a threshold quietly eating
  them.
- **Jump-back from a playlist**, driven by the real `dblclick` rather than the
  store method. Playing `Probe MP3` from playlist 1 at index 3, session tier
  `[OGG, OPUS]`. After: `Probe FLAC` playing, `playingPlaylistId` still 1,
  `orderIndex` still 3, session tier identical, user tier identical. `next()`
  then resumed at index **4**, `Probe OGG` — the row after the one interrupted.
  That is rule 1's second arm, live.
- **Cold-start jump-back** after a real restart with nothing playing: one-track
  order at index 0, plays, records, head becomes PLAYING.
- **Restart**: five rows back with their original ids and the `×3` collapse
  re-derived. Nothing marked playing, because nothing is (rule 5, next door).
- **Repeat-one across two real 20-second boundaries**: three rows in the store,
  one row on screen reading **`×3 PLAYING`**.
- **Cap and virtualization together**: 620 plays through the real channel in
  513 ms left **exactly 500** rows, ids 133–632, boundary exactly
  `newest − 499` — checked against the database, not the store. 22 `<li>` at
  scroll 0, 5,000 and the end of an 18,000 px scroll height.
- **Clear**: 6 rows to 0 in store and database, 6 tracks still in the library,
  empty state rendered.

Two false alarms worth recording so the next person does not chase them. The
probe clips are **20 seconds**, not the 3 assumed, so the first repeat-one run
looked like repeat-one was broken when it simply had not come round yet. And an
early jump-back measurement showed the user tier losing a row — the clip had
ended between two CDP calls and advanced into the queue, which is §5 working.
Both measurements were redone paused.

Every colour is a token (`primary`, `text-muted`, `text-dimmed`, `bg-elevated`,
`border-default`); no literal.

`lint`, `format:check`, `typecheck`, `test`, `build` all green.

### Not done here

- **No keyboard jump-back beyond Enter on a focused row**, matching the up-next
  pane.
- **No grouping by day.** Relative labels coarsen to `d` and stop; a trail
  bounded at 500 plays rarely spans enough days for separators to earn a row.
- **The D11 exclusion is not asserted**, because there is no export bundle to
  assert against yet. It is a design-doc decision waiting on W6.
- **`play_count` / `last_played_at` remain unwritten**, deliberately — see
  above. Probably worth a card.
- Verified on Linux only.
