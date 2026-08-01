---
title: Fermata — Design Document
created: '2026-07-26T04:53:06.799Z'
updated: '2026-07-26T04:53:06.799Z'
---
# Fermata — Design Document

Status: **approved, v1 scope frozen** · Owner: Michael · Repo: `C:\Users\Michael\Projects\fermata`

## 1. What this is

A desktop music player for local files: poweruser library control with a modern, themeable interface. The reference points are Foobar2000/fooyin for capability and Spotify for polish. No streaming-service integration, ever — the library is folders on disk.

Primary user is Michael. Secondary audience is anyone who wants a stylish, customizable, poweruser-focused local player.

**v1 is done when**: a library of pointed-at folders can be browsed and sorted by Artist/Album/Song, arbitrary multi-selections can be added to playlists, and MP3/FLAC/OGG all play correctly with gapless, crossfade and loudness normalization.

## 2. Decisions

Each row is settled. "Revisit when" is the trigger that would legitimately reopen it — absent that trigger, the decision stands.

### D1 — Shell and audio: **Electron + Web Audio API**

Chromium decodes MP3, FLAC, Vorbis and Opus identically on every target OS, and the Web Audio graph supplies crossfade, gain and future EQ without an audio engine being written from scratch.

*Rejected*: Tauri + Rust engine (bit-perfect output, but the entire DSP chain becomes Rust work); Tauri + Web Audio (system webviews have patchy Ogg/FLAC support — unacceptable for a format-first player); Tauri hybrid with Rust decode feeding an AudioWorklet (correct on paper, but the streaming seam is where the time goes).

*Accepted cost*: ~150MB bundle, higher RAM, and **no bit-perfect / exclusive-mode output** — Chromium always resamples to one device rate. This is a real concession to the audiophile end of the target audience and should be stated plainly in any README.

*Revisit when*: exclusive-mode output becomes a blocking user requirement.

### D2 — Playback pipeline: **`decodeAudioData` + prefetch next**

Decode current and next track fully into `AudioBuffer`s, schedule with sample-accurate start times. Gapless, crossfade and instant seek all follow almost for free; the engine is small enough to reason about completely.

*Rejected*: WebCodecs → AudioWorklet ring buffer (correct long-term, but WebCodecs supplies a decoder and no demuxer — FLAC/Ogg/MP3 container parsing is a workstream of its own); `<audio>` + MediaElementSource (not sample-accurate, so gapless is unreliable); stream-with-buffered-edges hybrid (two code paths meeting exactly where users listen for glitches).

*Accepted cost*: memory. See **R1**.

*Revisit when*: R1's guard starts firing on ordinary listening rather than edge-case files.

### D3 — Renderer: **Vite + Vue 3 + Nuxt UI standalone**

Component library and design system without SSR machinery inside a desktop shell. `vue-router` and Pinia wired explicitly — a small one-time cost. See **R4**.

### D4 — Layout: **fixed three-pane, panels as islands**

Sources / track list / now-playing, with configurable columns and theming. Every pane is self-contained and makes no assumptions about its neighbours, so a docking system can land later without a rewrite.

*Rejected*: dockable panels in v1 (a project of its own, delaying first playback badly); theming-only (abandons the poweruser pitch); full skinning/scripting (a platform, not a feature — v3 at the earliest).

### D5 — Queue model: **playlist tabs + play-next queue**

Foobar's named playlist tabs as the backbone, with a transient "up next" queue layered on. Full semantics in §5 — this is the part most likely to grow bugs, so it is specified rather than discovered.

### D6 — Library scan: **incremental at startup + live watcher**

Index on add, mtime-based incremental rescan at launch, filesystem watcher for live changes. See **R3** for the Linux degradation path.

### D7 — Tag authority: **DB overrides now, write-back later**

Tags are parsed on scan; corrections live in `track_overrides` and never touch files in v1. Zero corruption risk while the library layer is young. Write-back is roadmapped as an explicit opt-in once there is a test corpus and atomic-write handling.

*Accepted cost*: edits are invisible to other applications until write-back ships.

### D8 — Search: **FTS5 instant search + sortable columns**

Substring search over title/artist/album, click-to-sort columns, shift/ctrl multi-select. A Foobar-style query language with saved smart playlists is the natural v2 headline; it competes directly with the audio engine for v1 time.

### D9 — Theming: **token layer + curated themes**

Every component is built against CSS custom-property tokens over Nuxt UI, shipping several tuned themes and an accent picker. Themeable by construction, with no editor exposed yet — which keeps the token names private until they have settled. Sharable theme files would make those names a public API.

### D10 — Platforms: **Windows and Linux**

Both first-class. No Apple signing/notarization tax. Linux packaging via AppImage + deb. Path, filesystem and shell handling stays platform-neutral from the first commit, enforced by CI running on both.

### D11 — Cross-machine: **independent library, explicit export/import**

Each machine scans its own roots and owns its own SQLite database. An explicit export/import bundle carries playlists, ratings and play counts between them.

*Rejected*: a synced portable library — SQLite over Dropbox/Syncthing corrupts when two machines touch it, and a music player sits open for hours.

*Note*: track paths are stored **relative to a named root** regardless (§4). That is cheap insurance and makes the export bundle portable across differing folder layouts.

### D12 — Playlists: **SQLite rows + m3u8 export**

Real ordering semantics, stable per-entry ids, cheap dedup, and the same track may legitimately appear twice. m3u8 export for interop; import is backlog.

### D13 — First milestone: **thin end-to-end slice**

Every layer touched, none finished. Integration risk surfaces immediately; the specific audio risk is deliberately deferred to M2, which is why D2's implementation sits behind an interface from the start (§6).

### D14 — External metadata: **opt-in, drawer-scoped, main-process only**

The Tunedeck's artist nexus is the first outbound network request Fermata makes. Three rules bound it. Nothing is fetched until the operator opens the deck and accepts a one-time prompt naming the services. Fetching happens in the main process only — the renderer never opens a socket, for the same reason it never opens a file. And the deck is fully functional with networking declined: every local pane works, so offline is a tested state rather than an error path.

Sources are MusicBrainz (artist identity, artist-to-artist relations, outbound link relations including Bandcamp) and Wikidata → Wikipedia (biography, images). Both are keyless, so no secret ships in the bundle. Resolved MBIDs land on the `artists` row via a migration; everything else lands in a `cache.db` beside the library — separate from it, carrying per-entity TTLs and negative entries, and excluded from D11's export bundle because it is derived data that is deletable without loss.

*Rejected*: last.fm (best information per request, and the only source of taste-similarity, but its key must either ship extractably inside an asar or be pasted by every user); Discogs (same key problem, plus caching restrictions in its terms); Bandsintown and Songkick (partner approval is outside our control, so upcoming-show listings are not scoped at all).

*Revisit when*: a keyless source stops serving biographies, or R5's correction rate stays high enough that similarity data would materially improve the related panes.

**This does not reopen D1.** No audio ever arrives over the network. The library is still folders on disk.

**Podcast Discover sits inside D14's second rule and outside its first.** Every catalogue request — search, charts, lookup — issues from main, and Discover's thumbnails are proxied through the `fermata:` protocol rather than loaded from Apple's CDN, so the renderer opens no socket and no remote origin appears in `img-src`. But they are not behind a consent prompt: opening the Discover tab reaches Apple before the operator has agreed to anything. That is recorded debt against W7-6, which owns the prompt for every outbound source; podcasts are simply the first surface that shipped ahead of it. Subscribing to a feed and refreshing it are a different case — the operator named that host by pasting its URL — but a catalogue browsed on tab open is not.

### D15 — Tunedeck: **panel island hosted in a drawer**

An extended control and information surface opened from NowPlaying: up-next queue, format and signal readout, play history, related-in-library, and the D14 artist nexus. Its content is an ordinary D4 panel island and `UDrawer` is merely its first host. It opens from the right, is resizable, and pushes content rather than covering it — so it stays usable while browsing, which is the only thing that makes the related panes worth having, and so the eventual docking system promotes it to a pane instead of rebuilding it.

*Rejected*: a bottom overlay (better for wide carousels, but it buries the track list and is a dead end for docking); a modal covering the content (simplest, and useless for browsing alongside).

### D16 — Podcasts: **a separate domain, downloaded before played**

Podcasts are subscriptions to remote feeds; the library is folders on disk. Rather than bend either into the other, podcasts are a parallel domain — their own tables, their own IPC surface, their own view — and an episode is never a row in `tracks`. It does not appear in a Library facet, is not in an FTS index built for music, and does not inherit an album's ReplayGain.

They share exactly two things with the library, in both cases because sharing is safer than duplicating: the `fermata:` protocol that serves bytes to the renderer, where episodes get their own hostname and their own id space, and the artwork thumbnail cache with its single worker.

Episodes are downloaded to a machine-local podcasts directory and played from disk — never streamed. That is what keeps D1's "no audio ever arrives over the network" true rather than narrowly true: the decode path, R1's memory guard and the gapless machinery all see an ordinary local file, and a dropped connection cannot become a dropout. `rel_path` is relative to the podcasts directory under the same rule that governs `tracks`.

*Rejected*: episodes as `tracks` rows behind a flag (one list to virtualize and one search index, but every music query grows an `is_podcast = 0` and D11's export bundle has to decide whether a subscription is library data); streaming enclosures directly (no disk cost, but it makes the network a playback dependency and puts an untrusted, redirect-happy URL in front of the decoder).

*Accepted cost*: disk. `keep_last` bounds it per show; there is no global cap yet.

*Revisit when*: an operator wants podcasts inside a unified search, or the podcasts directory becomes the largest thing Fermata writes.

## 3. Risks

### R1 — Decode memory ceiling *(high, architectural)*

`decodeAudioData` yields float32 PCM: `duration_s × sample_rate × channels × 4` bytes. A five-minute stereo 44.1kHz track is ~105MB; current+next prefetch approaches 200MB; a twenty-minute DJ mix is ~400MB alone.

**Mitigation — must ship with D2, not after**: estimate decoded size *before* decoding. Above a per-track cap (default 250MB) fall back to `<audio>` streaming for that track and accept a hard transition. Enforce a total decoded budget (default 600MB) across current+prefetch. Both configurable. Without this rule a long-track collection is a crash.

### R2 — Gapless and crossfade are mutually exclusive *(medium, spec)*

They cannot both apply to one track boundary. **Policy**: a boundary reads exactly one crossfade duration, defaulting to 0; zero means gapless (next source scheduled at exactly `startTime + duration`), non-zero means crossfade (scheduled at `end − crossfade` with equal-power ramps on both sources). Tracks in R1's streaming fallback get a hard transition regardless.

*Amended 2026-08-01 (W8-5)*: the duration was `playlists.crossfade_ms`, a column on the playlist row. It is now `audio.crossfadeMs` in the settings registry, resolved through W8's cascade — descriptor default, then the global row, then a per-entity override on the album or playlist. Only the mechanism moved; the exclusivity rule is unchanged and is now structural rather than checked. There is one number per boundary and the scheduler branches on whether it is zero, so no combination of levels can express "both", which is what a second column beside a global setting always could.

### R3 — inotify watch limits on Linux *(medium, platform)*

A 100k-file library can exhaust the default user watch limit; the watcher fails with `ENOSPC`. **Mitigation**: watch directories rather than files, catch `ENOSPC` explicitly, degrade to startup-scan-only, and surface a visible notice explaining the `fs.inotify.max_user_watches` fix. Failing silently is the outcome to avoid.

### R4 — Nuxt UI standalone integration *(low, unverified)*

D3 assumes current Nuxt UI supports plain Vue via its Vite plugin. **This is unverified against current docs** and is the first task in W1. If it does not hold cleanly, the fallback is Nuxt in SPA mode, which changes packaging but not architecture.

### R5 — Artist identity resolution *(medium, correctness)*

A tag string is not an identity. "Nirvana" matches eleven MusicBrainz artists; punctuation, non-Latin names, leading articles and featured-artist strings all break naive lookup. A wrong match renders a confident, wrong biography, which is worse than rendering nothing.

**Mitigation**: search by name, accept only above a score threshold, and store the resolved MBID on the `artists` row so the match is made once per artist rather than once per play. Every deck header carries a visible "not this artist?" affordance opening a disambiguation picker; the operator's choice is authoritative and persists, exactly as D7 treats tag corrections. **Unresolved is a first-class state** — the deck's local panes are unaffected by it — and negative results are cached so an unmatchable artist is not re-queried forever.

*Secondary*: MusicBrainz permits roughly one request per second and requires an identifying User-Agent. A shuffle-heavy session must not be able to saturate that. This is the second reason D14 scopes fetching to an open drawer, and the reason the cache carries negative entries rather than only successes.

## 4. Data model — schema v1

Paths are stored relative to a root so roots can be remapped per machine (D11). `rel_path` is POSIX-normalised on write and rejoined per-platform on read — the single most important detail for Windows/Linux portability.

```sql
CREATE TABLE roots (
  id           INTEGER PRIMARY KEY,
  label        TEXT    NOT NULL,
  path         TEXT    NOT NULL UNIQUE,  -- absolute, machine-local
  added_at     INTEGER NOT NULL,
  last_scan_at INTEGER
);

CREATE TABLE artists (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  sort_name TEXT
);

CREATE TABLE albums (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  album_artist_id INTEGER REFERENCES artists(id),
  year            INTEGER,
  artwork_hash    TEXT,                  -- key into on-disk thumbnail cache
  UNIQUE(title, album_artist_id)
);

CREATE TABLE tracks (
  id             INTEGER PRIMARY KEY,
  root_id        INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path       TEXT    NOT NULL,       -- POSIX-normalised, relative to root
  mtime          INTEGER NOT NULL,       -- incremental rescan key
  size           INTEGER NOT NULL,
  duration_ms    INTEGER,
  codec          TEXT,                   -- flac | mp3 | vorbis | opus | aac
  sample_rate    INTEGER,
  channels       INTEGER,
  bit_depth      INTEGER,
  title          TEXT,
  artist_id      INTEGER REFERENCES artists(id),
  album_id       INTEGER REFERENCES albums(id),
  track_no       INTEGER,
  disc_no        INTEGER,
  rg_track_gain  REAL,                   -- dB
  rg_track_peak  REAL,
  rg_album_gain  REAL,
  rg_album_peak  REAL,
  rg_source      TEXT,                   -- 'tag' | 'computed' | NULL
  play_count     INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER,
  rating         INTEGER,
  UNIQUE(root_id, rel_path)
);

-- D7: corrections live here and never touch the file on disk.
CREATE TABLE track_overrides (
  track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  title       TEXT,
  artist_name TEXT,
  album_title TEXT,
  track_no    INTEGER,
  disc_no     INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE playlists (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  position     INTEGER NOT NULL,         -- tab order
  crossfade_ms INTEGER NOT NULL DEFAULT 0,  -- R2 policy; dropped in migration 007
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE playlist_entries (
  id          INTEGER PRIMARY KEY,       -- stable across reordering
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    REAL    NOT NULL           -- fractional: O(1) insert between
);

CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, artist, album,
  content='', tokenize='unicode61 remove_diacritics 2'
);
```

Two deliberate choices: `playlist_entries.id` is stable and separate from `track_id` because the same track may appear twice in a playlist; `position` is a REAL so inserting between two entries never rewrites the rest of the list.

### Settings and the cascade (migrations 006–007, W8)

One row per key per scope. `value` is JSON because the registry decides what a key holds; `version` is the descriptor version it was *written* under, which is what lets a read run the upgrade chain rather than guess.

```sql
CREATE TABLE settings (
  key         TEXT    NOT NULL,
  scope_kind  TEXT    NOT NULL,          -- 'global' | track | album | artist | playlist | podcast
  scope_id    INTEGER,                   -- NULL exactly when scope_kind is 'global'
  value       TEXT    NOT NULL,          -- JSON
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (key, scope_kind, scope_id)
);

CREATE UNIQUE INDEX settings_identity ON settings(key, scope_kind, COALESCE(scope_id, -1));
CREATE INDEX settings_scope ON settings(scope_kind, scope_id);
```

The extra unique index is not redundant. SQLite does not imply NOT NULL on PRIMARY KEY columns of a rowid table and a unique index treats two NULLs as distinct, so the declared key permits two global rows for the same value; folding the null into a sentinel is what makes the constraint real.

`scope_kind`/`scope_id` are the cascade. Resolution walks most-specific-first — entity row, then global row, then the descriptor default — and returns the value **with the level that supplied it**, because a control cannot draw the inherited/overridden distinction without knowing. A level this build cannot read falls through to the next rather than to the default: a damaged per-playlist value should leave the playlist on the global, not reset it past a perfectly good row. An override equal to what it would inherit stays an override, since it was set precisely so a later change to the global would not move it.

**Migration 007 dropped `playlists.crossfade_ms`**, carrying its non-zero values across as `audio.crossfadeMs` rows at `playlist` scope. Zeros did not move: the column was `NOT NULL DEFAULT 0`, so a zero in it cannot be told from a playlist nobody ever touched, and writing overrides for all of them would pin every playlist in the library against a later change to the global. No table outside `settings` carries a settings column.

### Podcasts (migration 005, D16)

A second domain rather than an extension of the first: no foreign key crosses into `tracks`, `artists` or `albums`, and nothing here is indexed by `tracks_fts`.

```sql
CREATE TABLE podcasts (
  id              INTEGER PRIMARY KEY,
  feed_url        TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  author          TEXT,
  description     TEXT,
  site_url        TEXT,
  artwork_url     TEXT,                  -- remote, for refresh comparison
  artwork_hash    TEXT,                  -- key into the same thumbnail cache
  subscribed_at   INTEGER NOT NULL,
  last_fetched_at INTEGER,
  last_error      TEXT,                  -- cleared on a successful refresh
  keep_last       INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE episodes (
  id              INTEGER PRIMARY KEY,
  podcast_id      INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  description     TEXT,
  pub_date        INTEGER,
  duration_ms     INTEGER,
  enclosure_url   TEXT    NOT NULL,
  enclosure_type  TEXT,
  enclosure_size  INTEGER,
  rel_path        TEXT,                  -- relative to the podcasts directory
  downloaded_at   INTEGER,               -- NULL until the file is on disk
  file_size       INTEGER,
  download_error  TEXT,
  played          INTEGER NOT NULL DEFAULT 0,
  progress_ms     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(podcast_id, guid)
);

CREATE INDEX episodes_pub_date ON episodes(pub_date DESC);
CREATE INDEX episodes_podcast_pub ON episodes(podcast_id, pub_date DESC);
```

`guid` is the feed's own identity for an episode, so a re-published item updates in place instead of duplicating. There is deliberately no download-status column: `rel_path` non-NULL means ready and `download_error` means failed, so the persisted state cannot disagree with the filesystem across a crash. Only *downloading* is in-memory, which is correct — a download does not survive a restart, and a status column claiming it did would be a lie the next launch has to clean up.

## 5. Queue semantics (D5)

State: `viewedPlaylistId` and `playingPlaylistId` are **separate** — browsing a different tab must not disturb playback. The up-next queue is an ordered list of track ids in two tiers: a **user tier**, put there by hand, and a **session tier**, materialized from the scope a play session started in. The user tier always sits above the session tier.

1. Next track = shift from the up-next queue if non-empty; otherwise the next entry after the current one in the playing playlist. A user entry is a *detour* and leaves the resume position where it was; a session entry *is* an order row and carries the resume position to its own.
2. Queueing a track never changes `playingPlaylistId` or the current position. Only the user tier is "queueing" — filling the session tier is part of starting playback, which moves both by definition.
3. Playing a track from any playlist sets `playingPlaylistId` to that playlist. **The user tier survives** — it is not cleared. The session tier is replaced, because it describes the session that just ended.
4. The queue holds track ids, so deleting a playlist that a queued track came from does not remove it from the queue. Deleting the *playing* playlist stops playback.
5. The queue is transient in v1: not persisted across restarts. Playlists are persisted.
6. Shuffle reorders traversal of the playing playlist only. It never reorders the user tier. It *refills* the session tier, which is the whole of what it means for that tier to describe what is actually going to play.
7. Repeat-one overrides everything. Repeat-all wraps the playing playlist; the queue still takes priority.

Each of these seven rules gets a test. That is M4's exit criterion.

### Amendment — 2026-07-31: the session tier

Rules 1, 2, 3 and 6 were amended on the operator's decision, which is the revisit trigger D5 did not anticipate. The original text made the queue purely explicit: it held only what the operator put in it, and rule 3's "the queue survives" was unconditional.

What that missed is that **a scope is already a queue and the operator cannot see it.** Selecting three artists and playing a song has always traversed only those three artists' tracks — `createListPlayOrder` carries the browse filters into every `at()` and into `count()` — but the traversal is lazy and query-backed, so nothing in the UI could show it. The up-next surface rendered an empty list while several hundred tracks were genuinely lined up behind the current one. "Prime the queue with what I have scoped in" is the request to make that visible, and materializing the scope is the reading chosen over projecting the order tail.

Two consequences fall out and neither is optional:

- **Two tiers, not one.** Wiping the queue on every play session would destroy exactly what rule 3 was written to protect: queue five tracks, click a library row, lose them. Splitting the tiers keeps rule 3's guarantee whole and narrows it to the tier it was ever about. It is also what keeps "Add to queue" meaningful — an append against a loaded 300-track session means "in four hours" unless the user tier sits above it.
- **A session entry moves the anchor.** `SlotPosition.index` is the position traversal *resumes* at, and a queue entry inherits it unchanged, because a queued track is a detour from the row it interrupted. That is right for a user entry and wrong for a session entry: a session tier holding the scope's rows 1..N against an anchor still at 0 replays the scope from row 1 the moment it drains. Session entries therefore carry their own order index. This is what makes a capped session tier correct rather than merely truncated — draining the cap resumes at the row after the last one materialized.

*Revisit when*: the session tier's cap is reached often enough to be noticed, or the Tunedeck's up-next pane (W7-2) wants to render the untruncated scope. Projecting the order tail through a paged `PlayOrder.slice()` is the alternative that was not taken and remains available; it needs no cap, because it materializes nothing.

## 6. Process architecture

**Main (Node, privileged)** — SQLite via better-sqlite3, scanner, watcher, metadata via `music-metadata`, artwork cache, background job queue, playlist CRUD and m3u8 export.

**Renderer (Chromium)** — all UI, and the Web Audio graph. Audio *must* live here; Web Audio has no main-process equivalent.

**Preload** — a narrow typed `contextBridge` surface. Context isolation on, `nodeIntegration` off. The renderer never touches the filesystem directly; every library operation crosses IPC.

**`src/shared`** — the IPC contract and its types, imported by both sides so they cannot drift.

**`renderer/audio/AudioEngine`** — an interface, with the D2 `decodeAudioData` implementation behind it. This is the islands principle applied to the riskiest component: when R1 forces the issue, a WebCodecs pipeline replaces the implementation without the UI noticing. The interface goes in at M1, not M2.

## 7. Repo structure

```
fermata/
├─ docs/                      # mirror of this document
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ src/
│  ├─ main/
│  │  ├─ db/                  # better-sqlite3, schema + migrations
│  │  ├─ library/             # scanner, watcher, metadata, artwork cache
│  │  ├─ jobs/                # background queue: scan, ReplayGain
│  │  ├─ playlists/           # CRUD + m3u8 export
│  │  ├─ podcasts/            # feeds, downloads, catalogue (D16)
│  │  └─ ipc/                 # typed channel handlers
│  ├─ preload/
│  ├─ shared/                 # IPC contract + types
│  └─ renderer/
│     ├─ audio/               # AudioEngine iface, scheduler, crossfade, gain
│     ├─ panels/              # islands: Sources, TrackList, NowPlaying
│     ├─ stores/              # Pinia
│     └─ theme/               # token layer
└─ tests/
```

## 8. Workstreams

| Tag | Stream | Depends on |
|---|---|---|
| W1 | Foundation — scaffolding, Nuxt UI, IPC contract, CI | — |
| W2 | Library — schema, scanner, watcher, metadata, artwork | W1 |
| W3 | Audio — engine, gapless, crossfade, ReplayGain | W1 |
| W4 | UI — panel islands, virtualized list, sort/multiselect, tokens | W1 |
| W5 | Playlists & Queue — tabs, play-next, m3u8 export | W2, W4 |
| W6 | Packaging & Ops — builder, CI matrix, export/import | W1 |
| W7 | Tunedeck — deck panes, artist nexus, metadata cache | W4, W5 |
| W8 | Settings — declarative registry, durable + view stores, cascade, onboarding | W1, W4 |
| W9 | Podcasts — subscriptions, downloads, Discover (D16) | W2, W4 |

## 9. Milestones

**M1 — "It plays"** *(thin end-to-end slice)* · Scaffold boots with HMR; schema v1 + migration runner; add-folder → scan → tracks in DB; one flat virtualized sortable list; double-click plays; transport and volume. No gapless, no crossfade, no watcher.
*Exit*: a real mixed MP3/FLAC/OGG folder browses and plays, on Windows **and** Linux.

**M2 — "It plays properly"** *(risk milestone)* · `AudioEngine` decode-ahead scheduler, gapless, crossfade with curve and duration, R1's memory guard and streaming fallback, ReplayGain read/apply plus compute-when-missing background job.
*Exit*: gapless verified by a sample-accurate boundary test rather than by ear; a twenty-minute track stays inside the memory budget.

**M3 — "It's a library"** · Three-pane Artist/Album/Song browsing, multi-select, FTS5 search, watcher with R3's degradation path, artwork cache.
*Exit*: a synthetic 100k-track library browses and searches within frame budget.

**M4 — "Playlists & queue"** · Tabs, play-next overlay, m3u8 export.
*Exit*: all seven §5 rules have passing tests.

**M5 — "Stylish"** · Token layer formalized, curated themes, accent picker, now-playing polish, Tunedeck phase 1 — the local deck only (D15's drawer host, up-next editor, format and signal readout, play history, related-in-library). No network.
*Exit*: swapping a theme touches zero component code; the deck ships without the app having made a single outbound request.

**M6 — "Shippable"** · NSIS + AppImage/deb, CI matrix, library export/import bundle.
*Exit*: install from artifact on clean Windows and clean Linux; both play music.

**M7 — "Tunedeck"** *(first network milestone)* · D14's opt-in consent gate and main-process fetch layer, `cache.db`, MusicBrainz identity resolution with R5's correction UI, Wikipedia biography, artist relations intersected against the library, outbound links, artist images through the artwork cache.
*Exit*: with networking declined the deck loses no local function; with it accepted, a cold artist resolves once and a warm one renders fully with the network unplugged.

**Podcasts (W9, D16) are not on this ladder.** They landed as a self-contained vertical alongside M3–M5 rather than as a milestone of their own, which is why the schema, the view and Discover all arrived at once. The one thing that ladder ordering would have caught is recorded on the D14 note above and owed to W7-6: Discover reaches the network before the consent gate that M7 builds exists.

## 10. Conventions and assumptions

- **Build**: electron-vite for dev/HMR, electron-builder for packaging.
- **Scale target**: 100k tracks. Every list virtualized from the first commit — never retrofitted.
- **ReplayGain**: read existing `REPLAYGAIN_*` tags first; compute only when absent, via a background job with progress, cancel and resume.
- **Artwork**: extracted on scan to a content-hashed thumbnail cache, with `folder.jpg` fallback. D14's artist images reuse it rather than adding a second blob store.
- **External metadata**: a separate `cache.db` with per-entity TTLs and cached negative results. Never part of the D11 export bundle — deleting it costs nothing but a refetch.
- **Testing**: Vitest for units (scheduling math, query building, scanner, path round-tripping); Playwright for Electron smoke tests.
- **CI**: GitHub Actions matrix on `windows-latest` and `ubuntu-latest` — lint, test, build artifacts.
- **Commits**: Conventional Commits, one logical change each.

## 11. Explicitly out of scope for v1

Streaming-service integration · dockable/scriptable layouts · query language and smart playlists · tag write-back · EQ and DSP chain · noise reduction · visualizers · mobile or remote control · last.fm scrobbling · the Tunedeck artist nexus, which is M7 · upcoming-show listings, which have no source we can obtain (D14).

These are deferrals, not rejections — except upcoming shows, which is a rejection until a listings API exists that does not require partner approval. Query language, tag write-back and the EQ chain are the strongest v2 candidates.
