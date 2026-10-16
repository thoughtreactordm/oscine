---
title: Oscine — Field Notes
created: '2026-10-10T05:24:18.753Z'
updated: '2026-10-10T05:24:18.753Z'
---
Design authority for **W22 — Field Notes**, Oscine's year-in-review. The stream owns the
**D34** block and risk **R15**. Its anchor decision, **D34 — Field Notes composes, never
merges**, is stated in the workstream description and expanded below; the follow-on
decisions extend the block as `D34.n`. Read `[[fermata-design]]` for the invariants and
the frozen D1–D20, and `[[fermata-listening-and-scrobbling]]` for the `listens` log this
stream reads. Per the post-1.0 convention these decisions live here, not there.

## What this is

An animated, slide-by-slide retrospective of a calendar year of listening — the
"Wrapped" idea, built from the `listens` log (D17) rather than from a streaming service.
It is **saved** once generated, so it can be viewed again, and it can be built from more
than one device's listening: the host's own log plus any number of **listens exports**
taken on other installs.

The problem it solves is fragmentation. Each install owns its own `library.db` (D11), so
an operator who listens on Linux and on Windows has two partial years. Sync was
considered and rejected for this purpose (see *Alternatives*); what the year-in-review
actually needs is to *read* the other devices' listens once, not to own them.

## D34 — Field Notes composes, never merges

**Imported listens are inputs to a generation, never rows in the library.** Field Notes
reads the host's `listens` plus N imported exports, composes them in a scratch database,
aggregates, saves the resulting report, and discards everything else. Nothing imported
reaches `library.db`, the Stats dashboard, `tracks.play_count` or Discover.

This is consistent with D11, not an amendment to it. D11 rejected a shared or synced
library and endorsed explicit exchange; a listens export is explicit, and a read-only
composition merges nothing. Merging other machines' listens *into* the library remains
W10-13's job (D11's listens-bundle amendment) — **do not grow Field Notes' import into
that merge.** The two share a serialization (D34.1), not a code path.

## D34.1 — The listens export: `oscine.listens` v1

A gzipped JSON file, modelled on the settings profile (`src/shared/settings/profile.ts`):
`format: 'oscine.listens'`, `formatVersion: 1`.

- **Header** — a per-install ID, an editable device label (default hostname + platform),
  the device's IANA time zone, `exportedAt`, the covered range, and the row count. The
  install ID is new: a random UUID in a `durable`, `internal`, `portable: false` setting.
- **Rows** — the snapshot columns only: `startedAt` (UTC ms), `msListened`, `durationMs`,
  `title`, `artistName`, `albumTitle`, `albumArtistName`, and the listen's genres as
  `{ key, name }` pairs. **No `track_id`** — it is a local integer and means nothing on
  another install. The snapshots are what make a listen self-describing (D17), which is
  the whole reason this design is cheap.
- **Always the whole log**, never a year. "Artists first heard this year" needs every
  prior year to answer, and the log is small (~100 bytes a listen).
- **The serialization is the listens section of the eventual D11 bundle** (W10-13), so a
  file exported for Field Notes is already the right input if merged stats are ever
  wanted. Adding optional fields later is backward compatible within v1.
- **Import treats the file as untrusted input.** Strict structural validation, string
  length and file size caps, and a clear refusal of a `formatVersion` newer than the
  reader knows. The renderer never reads the file — it is chosen through a main-process
  dialog and parsed in main.

Exporting is an action in the Stats view: "Export listening history…".

## D34.2 — Imports are not remembered

Generation is one atomic action: pick a year, optionally add export files, generate. The
files are read, used and forgotten. Nothing stores their paths or contents. The only
thing that persists is the report (D34.5), which records *which* sources it was built
from but not their listens.

## D34.3 — A scratch composer with the library attached read-only

Generation opens a **separate connection** whose `main` database is in memory and holds
only `listens` and `listen_genres`, then **`ATTACH`es `library.db` read-only**
(`mode=ro`) as `lib`.

- SQLite resolves an unqualified table name against `main` before attached databases,
  so in the scratch connection `listens` is the scratch copy and `tracks` (and
  `track_overrides`) fall through to the real library. `StatsStore`
  (`src/main/stats/store.ts`) takes a `Database` in its constructor, groups by snapshot,
  and touches `tracks` only through a `LEFT JOIN` for the artwork link — so it should run
  against the scratch connection unchanged. **The first card verifies this**, and also
  that a read-only attach behaves under the library's WAL mode while the app holds its
  own connection.
- The host's listens are copied in first, then each import with `INSERT OR IGNORE`
  against the existing `UNIQUE(started_at, title, artist_name)`. **The host wins a
  collision.** That one index makes re-imports, overlapping exports of one device, and
  an accidental import of the host's own export all idempotent.
- A `device_id` column on the scratch `listens` records provenance for the per-device
  breakdown.
- Imported listens are **linked to local tracks by snapshot match** —
  `(title, artist_name, album_title)` — inside the scratch copy only. That gives imported
  groups artwork and format data from the host's files, which for a dual-boot operator
  are the very same files. The link is a scratch-only write; it never touches `lib`.
- **Writes to the library are impossible by construction**, not by discipline: the only
  path to it is a read-only attachment. A test asserts it.

The scratch connection lives for one generation and is closed when the report is saved.

## D34.4 — One report per calendar year, generated anytime

The unit is a calendar year. A report can be generated at any point; a year still in
progress is labelled **so far** and can be regenerated later. Regenerating a year
**replaces** its report after confirmation, and the confirmation names the device imports
the existing report included — because imports are not remembered (D34.2), regenerating
without them silently drops those devices.

Arbitrary ranges were rejected for v1: they fuzz the storage key, the copy, and what
"new this year" means.

## D34.5 — The report is a frozen, versioned snapshot of aggregates

What is saved is the **aggregate set**, not the composed listens. Because a report can
never be regenerated from the same inputs, three things follow, and together they are R15:

- **Store more than the first UX needs.** Top 50 tracks, albums, artists and genres; a
  monthly and weekly series; an hour × weekday heatmap; the longest daily streak; the
  biggest day; artists and albums first heard in the year; the most-repeated track in a
  single day; the per-device split; and the format split (codec, bit depth, sample rate)
  over listens linked to a local track. Oscine is format-first, and a year in formats is
  a slide no streaming service can show.
- **Versioned with pure upgraders.** The report carries a `schemaVersion`; reading an old
  one runs it through pure, unit-tested upgrade functions to the current shape. **The
  viewer must render every version ever written** — this is a permanent obligation, not
  a migration window.
- **Snapshot identities, not artwork keys.** Entries are stored by name (title / artist /
  album / album artist). Artwork is resolved **at view time** by matching against the
  current library, falling back to a generated placeholder. Track ids and artwork cache
  hashes drift with rescans and moves; names do not.

The report also records its **sources** — each device's label, row count and covered
range — so the UX can show "Built from: Desktop (Linux), Desktop (Windows)" and the
regenerate warning (D34.4) can name what would be lost.

## D34.6 — Stored in a `recaps` table, carried by the D11 bundle

One row per year in `library.db`: year, `generated_at`, `schema_version`, a `partial`
flag, and the report as JSON. A migration adds it, so it carries the usual cross-branch
`user_version` skew.

`tests/main/bundle/tables.test.ts` requires every table to be classified in
`src/main/bundle/tables.ts`. **`recaps` is carried**: a report is self-contained, holds
nothing machine-specific (artwork is resolved at view time, D34.5), and — unlike
`cache.db` — is not derived data that can be rebuilt, because its inputs are gone.

## D34.7 — Rankings are by minutes listened

Every top list ranks by summed `ms_listened`, with listen count as the tiebreak. A
listen only exists once it crossed the threshold (D17), so skips are already out; ranking
by time keeps long tracks from being penalised and short repeats from dominating.

## D34.8 — Time buckets use the host's time zone

Hour-of-day, weekday, daily-streak and day boundaries are computed in the **host's**
current time zone. Each export's time zone is recorded (D34.1) but informational only, so
one misconfigured device cannot shift every bucket.

`started_at` is UTC, so a listen is stamped correctly whenever the device's *underlying*
clock is right. The failure mode is a device left on the wrong zone with its wall-clock
moved to compensate — its UTC is then off by the zone difference, and its listens land
hours away. That is an operator configuration issue, not something this stream corrects.

## D34.9 — "Field Notes" is a UI string; the code says `recap`

The product name appears only in UI copy. Tables, IPC channels, modules, types and
settings use the generic `recap` (`recaps` table, `recap.*` channels,
`src/main/recap/`). The Fermata → Oscine rename cost ~300 files; a feature name is not
going to be threaded through the schema.

The name: a birder's field notes are the record kept of what was heard and where — a
saved, re-readable notebook, which is what a report is. "Migration" was rejected
outright because it collides with database migrations.

## D34.10 — Presentation: a pure slide model and a full-window viewer

- **A pure slide model** maps a report to an ordered list of slides. It is `@renderer`-
  free and DOM-free so Vitest covers it, on the `equalizerModel` pattern. Slides whose
  data is empty (no imports → no device split; no linked listens → no formats) are
  omitted by the model, not hidden by the view.
- **The viewer** is a full-window sequence: ←/→ and Space to step, Esc to close. It is a
  panel island. Colour goes through the theme token layer and motion through the
  duration tokens, so the reduced-motion clamp applies without extra code.
- **Entry points**: a shelf of saved reports in the Stats view, and a Command Palette
  entry. The generation flow (year picker, add exports, generate) starts from the shelf.

## R15 — Report permanence

**Medium, maintenance.** A saved report cannot be regenerated from the same inputs, so
every report schema version is permanent and the viewer is bound to all of them. Failure
modes: an upgrader that loses a field, a slide that assumes data an old report never
stored, or a "cleanup" that drops support for v1. Mitigations ship with the mechanism:
upgraders are pure and each has a fixture test from a real saved report of its version;
the slide model omits slides it lacks data for rather than erroring; and the aggregate
set is deliberately generous at v1 so new slides can usually be built from old reports.

## Alternatives

- **Sync (folder transport or E2E-encrypted relay).** Designed in outline and set aside.
  It needs stable cross-machine playlist ids, change timestamps on ratings, tombstones
  for deletes, and root-label mapping before it can do anything, and the problem actually
  in hand — a fragmented year — needs none of that. Settings drift is tolerable and the
  W8 settings profile covers it manually. A hosted account service was rejected outright:
  password reset, a user database and a server holding readable listening data, all
  against a local-first app.
- **Merging imports into the library, then reading Stats.** That is W10-13, it changes
  the operator's numbers permanently, and it is not what a year-in-review needs.
- **Remembering imports so reports can be regenerated.** Rejected by the operator: the
  report is what is kept, and storing other devices' logs is merging by another name.

## Deferred

- **Soundtrack.** Playing a snippet of each slide's top track is the biggest wow-factor
  item and deferred to v2: it must go through the `AudioEngine` without breaking the seven
  queue rules or clobbering the operator's queue, and that deserves its own design.
- **Share a slide as an image.** Capture and export work; not v1.
- **Ranges other than a calendar year.** See D34.4.

## Does NOT

Does NOT write imported listens to `library.db` or alter `tracks.play_count`, the Stats
dashboard or Discover. Does NOT remember import files. Does NOT open a socket — artwork
comes from the local library or a placeholder. Does NOT enqueue scrobbles. Does NOT
reopen D11, D14 or D17. Does NOT implement W10-13's merge.

## Cards

| Card | Scope |
|---|---|
| W22-1 | Listens export: install ID, `oscine.listens` v1 format + validator, export IPC, Stats action |
| W22-2 | Scratch composer: WAL/read-only spike, host copy, import, link, provenance, no-write test |
| W22-3 | Report schema v1 + upgrader scaffold, aggregate set, host-zone bucketing |
| W22-4 | `recaps` storage: migration, bundle classification, list/get/generate/delete IPC |
| W22-5 | Pure slide model |
| W22-6 | Generation flow UI: year picker, add exports, regenerate warning |
| W22-7 | Slide viewer, Stats shelf, Command Palette entry |
