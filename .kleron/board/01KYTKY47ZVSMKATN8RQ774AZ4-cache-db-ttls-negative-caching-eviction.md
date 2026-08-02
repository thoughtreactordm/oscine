---
taskId: 01KYTKY47ZVSMKATN8RQ774AZ4
title: 'cache.db — TTLs, negative caching, eviction'
status: in-review
priority: high
labels:
  - M7
  - phase-2
  - main
workstream: W7
workstreamId: W7-8
dependsOn:
  - 01KYTKXXN4164BPB9712CRNT6T
order: 13
created: '2026-07-30T22:57:17.054Z'
updated: '2026-08-02T20:33:55.610Z'
---
## Scope

- A second SQLite database beside the library, with its own migration runner. Not new tables in the library DB — the separation is what makes it deletable.
- Per-entity TTLs, cached negative results, a size cap and an eviction policy.
- Explicitly excluded from **D11**'s export bundle.

## Acceptance

- A warm artist renders completely with the network physically unplugged.
- An artist that returns 404 is queried once and not re-queried until its negative TTL expires — the specific failure this prevents is re-burning rate limit on every play of an unmatchable artist.
- Deleting `cache.db` while the app is closed loses nothing but speed; the app recreates it.
- The export bundle provably does not contain it, with a test.
- TTLs are configurable and their defaults are justified in the card.

## Notes

**D14**. Follows the precedent set by the artwork thumbnail cache: derived data lives outside the library tables and is disposable by design.

---

## Built — `b7167b8`

`src/main/cache/` is a second SQLite database beside the library, and almost
every decision in it is downstream of one fact: there is nothing in `cache.db`
that is not also on a server.

### The separation is the feature, not the tidiness

A sibling file rather than four more tables in `library.db`, and the difference
is what becomes *possible*. A separate file can be deleted by an operator who
wants their machine to forget, rebuilt by the app after a downgrade, excluded
from a backup by name, and absent at startup without anything going wrong. None
of those can be said about a table, and every one of them is either an
acceptance criterion here or something W7-9 will lean on.

### The recovery policy is where the two databases part company

`db/index.ts` and `cache/open.ts` do the same job with opposite instincts. The
library refuses to open a schema it does not understand, because continuing
would write rows an older build cannot read; a corrupt library is a visible
error and nothing is ever deleted. The cache does the reverse — a schema from
the future, a file that is not a database, anything at all that throws — and
replaces the file. An operator who rolls Fermata back loses a few days of
lookups rather than losing their app.

`openCacheDatabase` catches every error rather than the two we can name
(`SchemaTooNewError`, `SQLITE_CORRUPT`), because enumerating them means the
third one — a truncated file, a driver upgrade that rejects something older —
reaching the caller as a startup crash over a cache. Above it, `openCacheService`
degrades to `createNullCacheService()` when even that fails: reads miss, writes
vanish, `through` fetches. That the application is *fully correct* against the
null cache is what "deleting `cache.db` loses nothing but speed" looks like
stated as code rather than as prose.

The delete takes `-wal` and `-shm` with it. An orphaned write-ahead log is
replayed into a freshly created database of the same name, which resurrects
exactly what the delete was for.

### `through()` carries the rules so the call sites do not

W7-7 left a note saying this layer sits *between* the client and its callers
rather than inside it. The client knows how to make one request correctly; it
has no business knowing that a 404 for an artist name is worth remembering for a
week. Three rules live in one function, and W7-9's four endpoints inherit them
instead of restating them four times.

**A fresh entry answers without asking** — including when consent is off. D14's
rule is that nothing is *fetched* without the operator agreeing, and reading a
row we already have opens no socket and sends nothing. So the deck stays
populated when lookups are switched off, and `clear()` is the control for an
operator who wants the data gone rather than merely frozen. *This is a judgement
call worth a second opinion:* the other reading of a privacy toggle is that off
means off, including for what is already on disk.

**Only `not-found` is cached negatively**, and the narrowness is the point.
`not-found` means the service answered and had nothing, which is a fact about
the world. `offline`, `timeout`, `unavailable` and `rate-limited` mean we failed
to ask, and caching those would turn a flaky minute into a week of pretending an
artist does not exist. `rejected` and `malformed` are bugs in our own request or
parser, and persisting them across restarts is how a bug becomes
unreproducible.

**A stale positive beats a failure.** When the TTL has lapsed and the refetch
cannot be made, the choice is between last month's biography and a blank pane.
Stale *negatives* are excluded: reporting "the service has nothing for this
artist" when the truth is "we could not reach the service" is a lie the operator
would act on, by going and correcting a tag that was never wrong.

### Eviction has a low-water mark, and that is not a detail

Two deletes. Expired rows go first because they are free — on a cache left alone
for a month that single statement is usually the whole eviction — and only what
remains is evicted by least-recent use, via one `DELETE` over a window function's
running total.

The second delete frees down to `evictToBytes`, not to the cap. A cache trimmed
to exactly its limit is over the limit again on the very next write, which turns
eviction from an occasional cost into an LRU sort of the whole table on every
artist the operator plays — the failure mode that makes a naive cap slower than
no cache at all. Tested directly: 101 writes into a 100-row cap leave 90 rows,
and the next five writes add five rows without evicting anything.

`used_at` is its own column because a refetch is not a use, and `expires_at`
never moves on a read — a cache that renewed its own TTL every time it was read
would serve an artist played daily an answer from 2026 forever. Reads update
recency at a granularity of one minute, so re-opening the same deck does not
cost a transaction per pane switch.

`auto_vacuum = INCREMENTAL`, set before the first migration because SQLite only
accepts it on an empty database, and `incremental_vacuum` after an eviction.
Without it the cap bounds what the cache *contains* while the file it lives in
only ever grows — technically a cap, and not the one anybody meant.

### `payload IS NULL` is the negative entry

One table, not four. A NULL payload records that the service answered and had
nothing, and there is no ambiguity with a document that happens to be null,
because payloads are JSON text and JSON's null serialises to the three
characters `null`. A separate `outcome` column would be a second source of truth
for the same fact. Negative entries are charged `CACHE_ROW_OVERHEAD_BYTES`
against the cap so a library full of unmatchable tags cannot accumulate an
unbounded number of free rows under a byte limit that never trips.

### TTL defaults, and why they are not settings keys

The shape of the table: MusicBrainz identity data is edited slowly and gets
thirty days; Wikipedia prose is edited constantly and gets fourteen; every
negative gets seven.

| Entity | Fresh | Negative |
|---|---|---|
| `musicbrainz.artist-search` | 30d | 7d |
| `musicbrainz.artist` | 30d | 7d |
| `wikidata.entity` | 14d | 7d |
| `wikipedia.extract` | 14d | 7d |

The load-bearing number is the seven-day negative on `artist-search`. An
unmatchable artist — a mistyped tag, a bandcamp one-off, "Various Artists" — is
queried on *every play* without it, which over a shuffle session is precisely
the sustained one-per-second traffic **R5** says gets a client banned. Seven days
makes that one request a week, and is short enough that an artist added to
MusicBrainz on Monday is found by the following Monday. The two thirty-day
positives are for documents whose edits are curated rather than a feed, and
which the deck reads on every play of every track by the artist; fourteen days
is the shortest positive TTL and goes to the Wikipedia extract, the most visible
and most frequently edited text we fetch.

`CACHE_ENTITIES` is a closed union for `NET_SCOPES`' reason: a new entity is a
TTL decision, and a free string would let one be cached with an unconsidered
lifetime. Adding a member is a compile error until it has a row in the table.

Sixty-four mebibytes, against a library database that is itself tens of megabytes
at the 100k-track target — a derived cache that can outgrow the thing it
decorates is a bug. D14 sends artist *images* to the existing thumbnail cache
rather than storing blobs here, so every row is a few kilobytes of JSON and the
cap holds several thousand artists.

**Configurable, but not a settings key.** The policy is an argument to
`createCacheService` — which is what the tests drive and what a settings key
would drive if one is ever justified. Eight duration fields in Settings › Network
would be a config file leaking into the UI; the two questions an operator
actually has about a cache are "how much disk is this costing" and "forget what
you know about this artist", and those are a number to display and a button to
press. `stats()` and `clear()` exist for whoever builds them.

### D11 exclusion, in the form available before the exporter exists

`db/artifacts.ts` declares every file Fermata writes into `userData` and which
side of D11 it is on, once, and `location.ts` derives its filenames from it — so
a path cannot exist without a declaration, because there is nowhere else for the
name to come from. `EXPORT_EXCLUDED_ARTIFACTS` is what the exporter reads.

The reason it is a list rather than a comment in an exporter that has not been
written: a derived database sitting in the same directory as the library is
exactly the file a future "back up my Fermata data" feature picks up by globbing
`*.db`, and the failure would be silent — shipping an operator's browsing
history to another machine inside something advertised as a playlist bundle.

## Acceptance

- **A warm artist renders completely with the network unplugged.** `through` on a
  fresh key never calls its fetch function at all — asserted, rather than
  asserting that an unused socket produced nothing.
- **A 404 artist is queried once.** A hundred simulated plays across a week
  produce exactly one call; the request after the seven-day negative TTL lapses
  produces the second. A stale negative plus an `offline` refetch reports
  `offline`, not `not-found`.
- **Deleting `cache.db` while the app is closed loses nothing but speed.** Unit
  test, and confirmed in a scratch instance: seeded a row, deleted the file and
  its sidecars with the app stopped, relaunched — `[cache] … migrated v0 to v1`,
  library untouched at `v10, up to date`, integrity check clean, zero rows. The
  rollback path was confirmed the same way by setting `user_version = 99`:
  `discarded and rebuilt at v1: Database schema version 99 is newer than this
  build supports (1)`. Real `cache.db` verified at `auto_vacuum = 2`,
  `journal_mode = wal`, one table and one index.
- **The export bundle provably does not contain it.** `separation.test.ts`
  asserts the declaration (`cache.db` is `derived` and in
  `EXPORT_EXCLUDED_ARTIFACTS`; `library.db` is neither) and the structural
  properties that make an exporter's mistake impossible rather than merely
  unlikely: the two registries share no table or index name, the cache schema
  carries no foreign key, the two version counters are independent, and no file
  under `src/main` contains an `ATTACH`. The file-level assertion — "this bundle
  does not contain this file" — is the one thing that cannot be written today
  and lands with the bundle.
- **TTLs are configurable and justified.** Table above; each entry argued in
  place in `policy.ts`; injected via `CachePolicy`.

55 tests. Full gate green on Linux.

## Notes for what comes next

- W7-9 takes `cache` and `net` and calls `cache.through(entity, key, () =>
  client.getJson(...))`. It should not need to touch `store.ts` or write a TTL.
- The four `CACHE_ENTITIES` are named for the *shape of the document*, not the
  URL. If W7-9's endpoints turn out to answer with something else, the union is
  where that is corrected, and the TTL argument moves with it.
- Serving cached entries while consent is off is the one D14-adjacent judgement
  in here. If it should be "off means off", the change is three lines in
  `through` — but the deck then blanks for an operator who simply stopped
  wanting new lookups.
- Nothing crosses IPC. A `cache.clear()` action and a size readout are the
  natural W8 surface, and `stats()` is already the right shape for it.
