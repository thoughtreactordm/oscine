---
title: Fermata — Listening & Scrobbling
status: 'specified, unbuilt'
owns: 'D17, D18, D19 · W10, W11 · migrations 012–015'
supersedes: nothing
amends: 'D11, §4, §8, §9, §11 of `fermata-design`'
created: '2026-08-03T14:29:21.109Z'
updated: '2026-08-03T14:29:21.109Z'
---

# Fermata — Listening & Scrobbling

## Why this document exists

`fermata-design` says two things that this feature area contradicts, and both need
answering out loud rather than quietly stepping past.

D14 **rejected last.fm**, on the ground that "its key must either ship extractably
inside an asar or be pasted by every user." §11 lists **"last.fm scrobbling"** as
explicitly out of scope for v1. Neither of D14's revisit triggers has fired.

The resolution is not that D14 was wrong. D14 was scoping *keyless, read-only
metadata sources for the artist nexus* — biographies, images, artist-to-artist
relations — where an API key buys nothing that MusicBrainz and Wikidata do not
give away. Scrobbling is a different transaction in every respect: it is a
**write**, it is **per-user authenticated**, and the operator signs into their own
Last.fm account before a single byte leaves the machine. "Pasted by every user"
is an objection to friction in a read path; in a write path the user is signing
in anyway. So this is a new decision (D19), not a reopened one, and §11's line
is struck rather than overruled.

The second contradiction is friendlier. D11's amendment ends: *"Revisit when: a
card makes `tracks.play_count` derived from `play_history` rather than a counter
in its own right."* That is exactly what the stats engine does. The trigger has
fired, and §4 of this document is the revisit.

## What is already there

The ground this builds on, verified in the tree rather than remembered:

- **`tracks` already carries `play_count INTEGER NOT NULL DEFAULT 0`,
  `last_played_at INTEGER` and `rating INTEGER`** (migration 001). All three are
  unwritten. `src/shared/history.ts` says so and says why: the trail's definition
  of a play includes skips, and "inflating them with skips to save a second event
  would make the number D11's export bundle carries a lie. They stay unwritten
  until a card owns them." **W10 is the card that owns them.**
- **`play_history` is a 500-row capped trail** (migration 009) that records every
  transport commit, skips included, cascades on track delete, and is excluded
  from D11's bundle. **Nothing in this document changes it.** It answers a
  different question — "what did the transport just do, so jump-back has
  somewhere to go" — and the two records coexist by design. See §3, D17.
- **`tracks.genre` is a free `TEXT` column** off the tag (migration 010), with
  `idx_tracks_genre_album`. There is no `genres` table and no normalization.
- **Settings have two scopes, `durable` and `view`** (`src/shared/settings/interface.ts`).
  There is no secret scope, and `safeStorage` appears nowhere in `src/`.
- **`NET_SCOPES = ['tunedeck']`** (`src/shared/net.ts`), alongside a
  `NetFailureKind` taxonomy and a `NetResult<T>` envelope that a scrobble client
  should speak rather than invent a second vocabulary for.
- **`src/main/library/related.ts`** exposes six related-content queries keyed off
  a seed track. This is where D18's relations parameter lands.
- The highest applied migration is **011**. This document claims **012–015**.

---

## The decisions

These three land in `fermata-design` §2 verbatim.

### D17 — Listening record: **an uncapped, snapshot-carrying listens log**

A play worth counting and a play worth remembering are different events, and
Fermata records both rather than compromising on one definition.

`play_history` stays exactly as it is: capped at 500, skips included, the
transport's short-term memory, excluded from D11. A new **`listens`** table is
the long-term one — uncapped, append-only, one row per play that crossed the
listened threshold, carrying the accumulated audible milliseconds. Every
statistic Fermata reports is a query over it, across any time range, and
`tracks.play_count` and `tracks.last_played_at` become maintained caches of it
rather than counters in their own right, regenerable at any time from the log.

Each row **snapshots** what it played — title, artist, album, album artist,
duration, and its normalized genres in a child table — and holds `track_id` as a
nullable `ON DELETE SET NULL` reference rather than a cascading one. This is the
load-bearing detail. Migration 009's own note records that "a file *moved*
between roots or folders reads as a delete plus an insert," and it accepts losing
a trail row to that because a trail row is worth 500 rows of session history. It
is not an acceptable price for years of listening: reorganising a folder would
silently destroy the thing that cannot be rebuilt, and the operator would find
out a year later. The snapshot also makes the log honest about the past — it
reports the artist as it was tagged when you listened, not as you have since
corrected it.

*Rejected*: counters on `tracks` alone (no storage cost and no new table, but
no time dimension at all — "top artists this year" is unanswerable, which is the
whole premise); extending `play_history` by lifting its cap (one table instead of
two, but it would mean either scrobble-inflating the trail with skips or
skip-starving the stats, and the cap is what lets the trail be read whole in one
request); cascading deletes to match the trail (smaller rows, consistent with
"the library is folders on disk" — and it loses everything the first time roots
are reorganised).

*Accepted cost*: rows. One per listen, unbounded, plus one to three genre rows
each. A hundred listens a day for ten years is roughly 365k rows — small for
SQLite, and stated outright rather than discovered.

*Revisit when*: the log grows large enough that an unindexed dashboard range
query misses frame budget, at which point materialized rollups are the answer and
the log stays the source.

### D18 — Favorites: **a table of truth, a playlist as its face**

Favoriting is a boolean fact about a track. `track_favorites` is that fact, keyed
by `track_id`, one row or none. The pinned, undeletable **"My Favorites"** entry
at the top of the playlist rail is a *view* over it and not its storage.

The operator sees exactly the playlist they asked for. What they do not get is a
playlist's semantics where a playlist's semantics are wrong: D12 makes the same
track legal twice in a playlist, and a track cannot be favorited twice. Nor does
every visible row in a virtualized 100k-track list have to resolve a
playlist-membership join to decide whether to draw a filled heart.

Favorites are **local and authoritative**. Last.fm's loved tracks are never read
in, and connecting an account never retroactively pushes what is already there
(see D19).

*Rejected*: a real `playlists` row behind a `kind` column (inherits W5's
virtualized contents pane, reorder and m3u8 export for free — and inherits D12's
duplicate rule, which then has to be specially suppressed for exactly one
playlist, and makes the per-row heart a join); reusing `tracks.rating` above a
threshold (zero migration, already in D11's bundle — and permanently forecloses
shipping stars and hearts as independent gestures).

*Accepted cost*: the rail's pinned entry is not an ordinary playlist, so anything
W5 adds to playlists — reorder, m3u8 export, crossfade-per-playlist — either
grows a second implementation for this one entry or does not apply to it. Export
is the one that will be asked for first.

*Revisit when*: a second system-owned collection appears (Recently Added, Most
Played), at which point the pinned-view mechanism wants to be a general one
rather than a special case with a hardcoded name.

### D19 — Scrobbling: **shipped app key, per-user session, provider-abstracted**

Fermata registers its own Last.fm API account and the `api_key` and shared secret
ship in the bundle, extractable from the asar. A durable setting lets an operator
paste their own pair to override.

This is D14's objection met rather than dodged. The two credentials do different
jobs: the app key says *which application is asking*, and it can scrobble for
nobody on its own. The user is identified by a **session key** obtained once per
install through Last.fm's desktop flow — `auth.getToken`, then the system browser
at `last.fm/api/auth/`, where the operator signs into their own account and
grants Fermata access, then `auth.getSession`. The session key never expires, is
per-install, and is the credential actually worth protecting; it lives in
Electron's `safeStorage` and never in the settings table, never in the D11
bundle, and never crosses IPC after it is written. An extracted app key buys an
attacker the ability to write a scrobbler that calls itself Fermata. It buys them
no account.

**Scrobbling sits outside D14's consent gate (W7-6), deliberately.** Completing a
sign-in where you type your own password into your own account's login page is
stronger and more specific consent than a checkbox naming a service, and until it
completes nothing outbound happens at all. This is the opposite of the Podcast
Discover debt, where a tab open reaches Apple before the operator agreed to
anything. Stated here so it reads as a position rather than an oversight.

Targets are behind a **`ScrobbleTarget`** interface in `src/shared`, with Last.fm
as the first implementation and ListenBrainz as the second. ListenBrainz needs no
app key at all — a user token and nothing else — so it is both the cheapest
second target and a real test of whether the abstraction leaks Last.fm's
signature scheme.

*Rejected*: shipping the key with no override (one fewer setting, and if the key
is ever rate-limited or revoked every install breaks at once with no recourse);
requiring every operator to register their own API account (D14's objection fully
honoured, and it puts `last.fm/api/account/create` in front of a feature users
expect to be one click).

*Accepted cost*: a secret in the bundle that a determined reader can extract, and
a second credential store (`safeStorage`) alongside the settings table.

*Revisit when*: Last.fm revokes or rate-limits the shipped key, or a third target
appears whose auth model the `ScrobbleTarget` interface cannot express without a
special case.

---

## Amendments to existing decisions

### D11 — the listens log is carried; the trail still is not

**Landed in `fermata-design` by W10-13, 2026-08-03.** The design document is the
authority; what follows is the text that went in and stays here as the record of
where it came from.

D11's amendment set its own revisit trigger and D17 fires it. The amendment to
add:

> *Amended (W10)*: `tracks.play_count` and `tracks.last_played_at` are now
> maintained caches of the `listens` log (D17), so the bundle **carries the log**.
> The amendment above anticipated this: carrying a derived value while dropping
> its source is the incoherent option. The log is also mergeable in the way the
> trail is not. A trail is a bounded window whose merge discards rows by accident
> of ordering rather than by age; a listens log is an unbounded set of timestamped
> events, and two machines' events genuinely interleave into a chronology that did
> happen — you listened on the laptop at nine and the desktop at three. Import is
> `INSERT OR IGNORE` against `UNIQUE(started_at, title, artist_name)`, and
> `play_count` is recomputed from the merged log afterwards rather than added.
> `play_history` remains excluded, unchanged and for its original reason.

`track_favorites` joins the bundle on the same footing as ratings — a statement
about a track, resolving by recency. The `scrobble_queue` does **not**: it is
machine-local outbound state, and importing another machine's pending scrobbles
would submit them twice under whichever account this machine is signed into.
`track_genres` does not either — it is derived from `tracks.genre` and rebuilt on
scan.

### §11 — the out-of-scope line is struck

Remove `last.fm scrobbling` from the §11 list. Add a sentence after the
paragraph that follows it:

> Scrobbling left this list under D19, which distinguishes a per-user
> authenticated write from D14's keyless read-only metadata sources. A
> Wrapped-style retrospective (W10-14) remains out of scope and is specified
> separately from the listening dashboard, which is not one.

### §8 — two rows appended

| Tag | Stream | Depends on |
|---|---|---|
| W10 | Listening — listens log, favorites, stats engine, dashboard | W2, W3, W4, W5 |
| W11 | Scrobbling — provider contract, Last.fm auth, outbox, Loved push | W10, W7 |

### §9 — a milestone after M7

> **M8 — "What you listened to"** · The listens log and its threshold rule,
> favorites end to end, genre normalization, the stats engine and its Tunedeck
> panes, the Listening dashboard, and Last.fm scrobbling with an offline outbox.
> Sequenced after M7 because W11 is cheap to build second: D14's main-process
> fetch layer, its failure taxonomy and its cancel-by-scope machinery already
> exist by then, and a scrobble client that reuses them is a client rather than an
> HTTP stack.
> *Exit*: a track played past threshold appears in the dashboard and on the
> operator's Last.fm profile; the same track played with the network unplugged
> appears in the dashboard immediately and on the profile when the network
> returns; a root reorganised on disk loses no listening history.

---

## Data model

The four migrations below are listed in the order they were specified, which is
no longer their version order. The scrobble outbox landed first, as **012**: it
has no foreign keys and depends on none of the other three, and `migrate`
refuses a registry with a hole in it, so giving it 015 would have meant building
W11-2 against a schema that could not be applied. Nothing was released, so the
numbers were still free to move.

### Migration 013 — genre normalization

`tracks.genre` is whatever the tagger wrote. On a real library that means `Rock`,
`rock` and `Rock; Alternative` are three distinct genres, which makes genre stats
close to noise. A derived join table fixes it without asking the operator
anything.

```sql
CREATE TABLE track_genres (
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre_key TEXT    NOT NULL,   -- casefolded, trimmed: the grouping identity
  genre     TEXT    NOT NULL,   -- canonical display spelling for that key
  PRIMARY KEY (track_id, genre_key)
) WITHOUT ROWID;

CREATE INDEX idx_track_genres_key ON track_genres(genre_key, track_id);
```

Derived, never authored. Rebuilt from `tracks.genre` whenever a track is upserted,
which means an operator-facing Rescan fills it in for the whole library with no
new gesture — the same property migration 010 relies on.

The splitter separates on `;`, `/` and `,`, trims, collapses internal whitespace,
and casefolds for `genre_key`. `genre` is the first spelling seen for a key,
which is arbitrary but stable and beats inventing a title-caser that gets
`R&B`, `EDM` and `hip-hop` wrong in three different ways.

`WITHOUT ROWID` because the primary key *is* the row — there is nothing else in
it to point at.

*Accepted cost*: `/` is a real separator and also a real character inside a genre
name. `Rock/Pop` splits into two; so does the handful of genres legitimately
spelled that way. Splitting is right far more often than not, and an operator
alias map — recorded as a debt below, not scoped anywhere yet — is where the
rest would be fixed.

### Migration 014 — the listens log

```sql
CREATE TABLE listens (
  id                INTEGER PRIMARY KEY,
  -- SET NULL, not CASCADE: see D17. A moved folder must not erase history.
  track_id          INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  started_at        INTEGER NOT NULL,  -- UTC ms, the transport-commit moment
  ms_listened       INTEGER NOT NULL,  -- accumulated audible ms; see §"The listen event"
  duration_ms       INTEGER,           -- snapshot of the track's duration then
  title             TEXT    NOT NULL,  -- snapshots below, override-resolved at listen time
  artist_name       TEXT,
  album_title       TEXT,
  album_artist_name TEXT
);

-- Every dashboard query is a range over started_at; every "top N" is a group
-- within that range. This index is the range scan.
CREATE INDEX idx_listens_started ON listens(started_at);

-- The child side of the SET NULL reference. SQLite indexes the parent of a
-- reference and never the child, so without this every track deletion during a
-- scan is a full scan of the largest table in the database.
CREATE INDEX idx_listens_track ON listens(track_id, started_at);

-- Makes D11 import idempotent: INSERT OR IGNORE and merging twice is merging once.
CREATE UNIQUE INDEX idx_listens_identity ON listens(started_at, title, artist_name);

CREATE TABLE listen_genres (
  listen_id INTEGER NOT NULL REFERENCES listens(id) ON DELETE CASCADE,
  genre_key TEXT    NOT NULL,
  genre     TEXT    NOT NULL,
  PRIMARY KEY (listen_id, genre_key)
) WITHOUT ROWID;

CREATE INDEX idx_listen_genres_key ON listen_genres(genre_key, listen_id);
```

`listen_genres` is written at listen time by copying the track's `track_genres`
rows, not resolved by join at query time. It has to be: the whole point of D17's
snapshot is that genre stats survive the track's deletion, and it also means "top
genres of 2026" is one indexed query rather than a range scan that splits strings
on 365k rows.

Note the identity index treats `NULL` artist as distinct from `NULL` artist —
SQLite's `UNIQUE` does not collapse nulls — so an untagged track's listens dedupe
on nothing during import. Untagged tracks are the case where duplicate stats
matter least, and the alternative is a sentinel string that then leaks into every
group-by.

**No rollup indexes on `artist_name`, `album_title` or `title`.** They are
deliberately absent, not overlooked: the dashboard's shape is *range first, group
second*, `idx_listens_started` serves the range, and a sort over one range's worth
of rows is cheap. They are the first thing to add when a query is measured slow,
and adding them before then would be three indexes on the fastest-growing table
in the database on a guess.

### Migration 015 — favorites

```sql
CREATE TABLE track_favorites (
  track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  favorited_at INTEGER NOT NULL       -- UTC ms; the rail's default order
);

CREATE INDEX idx_track_favorites_at ON track_favorites(favorited_at);
```

`ON DELETE CASCADE` here, unlike `listens`, and the difference is the point.
A favorite is a statement about a track you can play. One you cannot is not a
favorite you can act on; it is a broken row in a pinned playlist. Losing it to a
folder move is a mild annoyance the operator fixes with one click, where losing
listening history is unrecoverable. D11 carries favorites across machines, which
is where the real durability lives.

### Migration 012 — the scrobble outbox (W11)

```sql
CREATE TABLE scrobble_queue (
  id                INTEGER PRIMARY KEY,
  target            TEXT    NOT NULL,  -- 'lastfm' | 'listenbrainz'
  kind              TEXT    NOT NULL,  -- 'scrobble' | 'love' | 'unlove'
  -- Provenance only, no foreign key. The queue must still be able to send
  -- after the track is gone from the library, which is exactly when the
  -- network came back after a rescan.
  listen_id         INTEGER,
  track_id          INTEGER,
  -- Snapshots of what will actually be transmitted.
  artist_name       TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  album_title       TEXT,
  album_artist_name TEXT,
  duration_s        INTEGER,
  timestamp         INTEGER NOT NULL,  -- UTC seconds — Last.fm's field, not ms
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);

CREATE INDEX idx_scrobble_queue_ready ON scrobble_queue(target, next_attempt_at);
```

Rows are deleted on accepted submission, so the table's steady state is empty and
its size is a direct readout of how long the network has been away — which is
what W11-7's status pane displays.

`artist_name` and `title` are `NOT NULL` because Last.fm rejects a scrobble
missing either. A track with no artist tag is **never enqueued**; it still gets a
`listens` row, because Fermata's own stats have no such requirement and silently
dropping it would put the two records permanently out of step for no reason the
operator could see.

---

## The listen event

One rule, one moment, one row — feeding the log and the outbox from the same
commit, so that Fermata's numbers and the operator's Last.fm profile cannot
disagree and then need explaining.

**The threshold** is Last.fm's, adopted wholesale: the track is longer than 30
seconds, **and** accumulated audible time has reached either half its duration or
four minutes, whichever comes first. Twenty years of tuning against real
listening is not worth re-deriving.

**Accumulated audible time** is what the accumulator counts, and it is stricter
than elapsed wall-clock in the two ways that matter. Paused time does not count.
Seeked-over regions do not count — which is not merely honest bookkeeping, it is
Last.fm's own rule that a track must not be scrobbled by scrubbing through it.
A region played twice counts twice, and a 40-minute track abandoned halfway
records the twenty minutes that actually happened rather than forty that did not.
The accumulator lives beside the playback controller in the renderer, where the
position already is.

**The commit moment is departure, not threshold-crossing** — track end, skip,
stop, or transport moving on. One write with a final `ms_listened`, rather than a
write at threshold plus an update at the end. `started_at` is stamped at the
transport-commit moment regardless, because that is the timestamp Last.fm wants
and it is also the truth.

The `before-quit` handler flushes an in-flight listen that has already crossed
threshold. A hard kill loses it, and that is the accepted cost of one write:
recording an in-flight listen durably would mean a heartbeat writing to SQLite
every few seconds for the entire life of the app, to protect against a case that
costs one row.

**Relationship to the existing trail.** `play_history` is written at
transport-commit, unconditionally, skips included — unchanged. `listens` is
written at departure, conditionally. A skipped track produces a trail row and no
listen. Repeat-one produces one of each per pass, with distinct `started_at`
values; Last.fm accepts consecutive duplicate scrobbles that differ in timestamp.

**What else the commit does**, in the same transaction as the `listens` insert:

- copies `track_genres` → `listen_genres`
- increments `tracks.play_count` and sets `tracks.last_played_at`
- enqueues one `scrobble_queue` row per connected target, if the track has an
  artist name (W11)

`play_count` is a **maintained cache, not an independent counter** — that is the
distinction D11's revisit trigger turns on. `stats.rebuildCounters` recomputes
both columns from the log by full aggregation, and is run after a D11 import,
after a listens-affecting migration, and on demand. If the counter and the log
ever disagree, the log wins, without argument.

`track.updateNowPlaying` fires at the *transport-commit* moment instead, not at
departure — it is a "currently playing" notification with a short server-side
expiry, and sending it at the end of a track would be sending it about the past.
It is fire-and-forget: never queued, never retried, and a failure is not surfaced.

---

## Favorites

**Storage** is `track_favorites`, one row or none. The IPC surface is
`favorites.toggle`, `favorites.isFavorite` for a batch of track ids, and
`favorites.list` paged like every other list.

**In lists.** `Track` grows a boolean, resolved in the same query that builds a
page, so the heart on a virtualized row costs nothing extra. TrackList gets a
heart column, off by default in the column chooser; NowPlaying's existing
placeholder becomes real.

**The rail entry.** "My Favorites" is pinned above the playlist tabs, cannot be
renamed, reordered or deleted, and renders through `PlaylistContents.vue` against
a source that reads `track_favorites` instead of `playlist_entries` —
`trackListSource.ts` already models exactly this indirection. Default order is
`favorited_at` descending. Reorder is disabled, because there is no authored
position to drag against; that is the honest face of D18's accepted cost.

**In the Tunedeck.** A "Favorite Songs" pane under Artist, listing that artist's
favorited tracks. It is a local pane and works with networking declined, which
keeps D14's third rule intact.

**As a relations parameter.** `related.ts`'s six queries grow an optional
`favoritesOnly` filter and an optional favorite-weighting in their ordering, so
"more from this artist" can prefer tracks you have hearted. Separately, when
W7's artist nexus resolves similar artists from MusicBrainz, each is annotated
with how many favorites you hold for it — which is the "favorites for a similar
artist" signal, computed locally against a remote list, with no favorite ever
leaving the machine.

**Loved sync is one-way and forward-only.** See D19 and W11-6: hearting a track
pushes `track.love`; un-hearting pushes `track.unlove`; connecting an account
pushes **nothing** that was already favorited; Last.fm's loved tracks are never
read in. A retroactive bulk push on connect would be thousands of writes to
someone else's account on the strength of a single click, and the operator who
wanted it can ask for it explicitly later.

---

## The stats engine

Every statistic is one shape: **filter `listens` by a time range, group by a
dimension, order by count or by summed `ms_listened`.** Four dimensions —
track, album, artist, genre — where the first three group on the snapshot columns
and genre groups through `listen_genres`.

Grouping on the snapshot rather than joining to `artists`/`albums` is what makes
a deleted track's history still count, and it is also what makes the numbers
stable: correcting a tag next year does not silently rewrite what last year said.
The cost is that a genuine tag *fix* — the same artist misspelled two ways —
leaves two rows in the top-artists list. Rollups query the snapshot; a
re-attribution pass over historical rows is a debt, recorded below.

Two totals sit beside the four dimensions: **listens** (rows) and **time**
(summed `ms_listened`). Time is the more honest of the two for a library that
mixes three-minute songs with hour-long mixes, and both are shown rather than one
being chosen.

**The IPC contract** is a single `stats.query` taking `{ range, dimension, limit,
offset }` and returning ranked rows with both totals, plus `stats.summary` for
the dashboard's headline numbers and `stats.overTime` for a bucketed series. One
query shape, four dimensions, rather than four near-identical channels.

**The dashboard** is a new Sources destination, and it is a **dashboard, not a
retrospective**: a time-range selector (7 days / 30 days / 90 days / this year /
all time), headline totals, top tracks/albums/artists/genres as ranked lists that
click through to the library, and listening over time. It answers "what have I
been listening to" at any moment, rather than performing a year for you once in
December. The Wrapped-style retrospective is a separate, later, deliberately
unspecified card (W10-14) — its interesting problems are presentation and
narrative, and folding them into a dashboard would produce something that is
neither.

**In the Tunedeck**, the same engine scoped to what is playing: play count and
time for this track, this album, this artist; first played and last played.

---

## Scrobbling

### The provider contract

`ScrobbleTarget` in `src/shared`, speaking `NetResult<T>` and `NetFailureKind`
from `src/shared/net.ts` rather than a second failure vocabulary:

- `authorize()` — begins whatever flow the target uses, resolves to a stored credential
- `nowPlaying(payload)` — fire-and-forget
- `submit(batch)` — up to the target's batch limit; returns per-item accept/reject
- `love(payload)` / `unlove(payload)`
- `capabilities` — batch size, whether love is supported, whether duration is required

Per-item results, not a single verdict for the batch: Last.fm accepts a batch
containing rejects, and treating a partial success as a whole failure would
retry the accepted ones forever.

`NET_SCOPES` grows `'scrobble'`, so an in-flight drain is cancellable by the
same machinery that cancels the Tunedeck's fetches.

### Last.fm specifics

Auth is the desktop flow — `auth.getToken`, system browser to
`last.fm/api/auth/?api_key=…&token=…`, `auth.getSession`. The returned session
key goes to `safeStorage` and never crosses IPC again; the renderer is told the
username and a connected boolean, nothing more.

Every call is `POST` to `ws.audioscrobbler.com/2.0/`, signed `api_sig =
md5(concat of sorted key+value pairs + shared secret)`. Batches are up to **50**
scrobbles, with array-indexed parameters. `timestamp` is UTC **seconds**.

The error taxonomy maps onto `NetFailureKind`: code 9 (invalid session) is a
terminal auth failure that disconnects the account and surfaces a re-authorize
prompt rather than retrying; code 29 (rate limit) and the 5xx family are
retryable with backoff; a malformed-payload rejection is terminal *for that row*
and drops it with `last_error` recorded, because retrying a payload the server
will never accept is an outbox that never drains.

### The outbox

Persist first, submit second — always, even when online. A scrobble that exists
only in flight is a scrobble lost to a closed laptop lid, and a music player is
mostly used on laptops.

The drain worker wakes on enqueue, on network return, on app start, and on a
timer; takes up to 50 ready rows for one target; submits; deletes what was
accepted; and applies exponential backoff with jitter to `next_attempt_at` for
what was not. Ordering is by `timestamp` ascending, so a long offline stretch
replays in the order it happened.

---

## Settings

New `durable` keys: `lastfm.enabled`, `lastfm.apiKey` and `lastfm.apiSecret`
(both empty by default, meaning "use the shipped pair"), `lastfm.loveOnFavorite`,
`listenbrainz.enabled`. New `view` keys: the dashboard's selected range and
dimension.

**The session key is not a setting.** It is in `safeStorage`, for the reason
D19 gives, and because a `durable` key is by definition a candidate for D11's
export bundle — which is precisely where a credential must never be.

---

## Testing

- The threshold rule, table-driven: sub-30s tracks, exactly-half, the four-minute
  cap on a long track, pause-and-resume, seek-forward, seek-backward-and-replay.
- Departure commit: end, skip, stop, and quit-while-playing each produce the
  right number of rows with the right `ms_listened`.
- Trail-versus-log divergence: a skipped track appears in `play_history` and not
  in `listens`; repeat-one produces one of each per pass.
- `ON DELETE SET NULL` under a simulated root move: delete plus insert leaves the
  listens intact and stats unchanged.
- `rebuildCounters` reproduces `play_count` exactly, over a generated log.
- The genre splitter, table-driven, including `R&B`, `Hip-Hop/Rap` and empty tags.
- D11 round trip: export, import into a database that already holds an
  overlapping log, assert no duplicates and a correct recomputed `play_count`.
- The outbox against a stubbed target: partial-accept batches, code 9, code 29,
  backoff progression, ordering after a long offline stretch.
- The Last.fm signature, against a known-good vector.

---

## Recorded debts

1. **No historical re-attribution.** Fixing a misspelled artist tag does not
   fix the listens already recorded under the misspelling, so the top-artists
   list keeps both. A merge tool is the answer and is not scoped here.
2. **A hard kill loses an in-flight listen.** Accepted for the one-write design;
   see "The listen event".
3. **`/` splits genres that legitimately contain it.** Accepted for migration
   013; an operator alias map is the fix and is not scoped here.
4. **The pinned Favorites entry inherits nothing from W5.** m3u8 export of
   favorites will be asked for and does not exist.
5. **No rollup indexes.** Deliberate; see migration 014. Revisit on measurement,
   not on suspicion.
6. **Genre display spelling is first-seen-wins.** Stable and arbitrary.
