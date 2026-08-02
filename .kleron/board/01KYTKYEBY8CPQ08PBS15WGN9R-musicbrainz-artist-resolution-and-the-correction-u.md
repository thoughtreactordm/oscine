---
taskId: 01KYTKYEBY8CPQ08PBS15WGN9R
title: MusicBrainz artist resolution and the correction UI (R5)
status: in-review
priority: high
labels:
  - M7
  - phase-2
  - risk
workstream: W7
workstreamId: W7-9
dependsOn:
  - 01KYTKY47ZVSMKATN8RQ774AZ4
order: 14
created: '2026-07-30T22:57:27.421Z'
updated: '2026-08-02T21:07:07.910Z'
---
## Scope

- Implements **R5**. Search MusicBrainz by artist name, accept a match only above a score threshold.
- Migration adding an MBID column to the `artists` row, so a match is made once per artist rather than once per play.
- The "not this artist?" affordance in the deck header, opening a disambiguation picker. The operator's choice is authoritative and persists — the same shape as **D7**'s treatment of tag corrections.

## Acceptance

- Correct resolution across a fixture set chosen to be hard, not easy: an ambiguous name (the "Nirvana" case), one with punctuation, one non-Latin, one carrying a featured-artist string, and one that genuinely does not exist in MusicBrainz.
- Unresolved renders as a first-class state with every local pane intact.
- An operator correction survives restart and is never silently overwritten by a later automatic match.
- The threshold value is documented with the reasoning behind it.

## Notes

**R5** is the correctness risk of this entire workstream. A confident, wrong biography is worse than no biography — which is why the threshold must be tuned against the whole fixture set rather than against whichever artist happened to be playing during development.

---

## What shipped — `e9a018b`

### The decision rule, and why a threshold alone is not it

R5's mitigation reads "accept only above a score threshold", and taken literally it
does not survive its own worked example. Eleven MusicBrainz artists are called exactly
"Nirvana". Every one is an exact string match, every one scores 100 on any
name-similarity measure worth having, and MusicBrainz's own relevance score is 100 for
all of them. No threshold accepts the right Nirvana and rejects the other ten — it can
only accept whichever came first, which is the wrong biography with extra steps.

Acceptance is therefore two tests, in this order:

1. **Threshold** — `ARTIST_MATCH_THRESHOLD = 80`. Is anything here plausibly this artist?
2. **Margin** — `ARTIST_MATCH_MARGIN = 10`. Is one of them clearly ahead of the next?

Scores are `0.75 × ourNameComparison + 0.25 × MusicBrainz's relevance`
(`NAME_WEIGHT`). The name is evidence that can be inspected and tested; the search
score encodes index-side popularity we cannot reproduce, and it is exactly the signal
that would rank the famous Nirvana above the right one. A quarter lets it order
candidates our comparison ties without letting it decide one.

Why 80, spelled out: an exact name match (100) needs only 20 from MusicBrainz to clear
the bar, so a genuine hit is never rejected on ranking alone; a three-quarters-right
name (75) needs 95, which is the case where our normalisation mangled something and
MusicBrainz is certain anyway; below a name score of about 73 nothing clears the bar at
all, whatever the service says. Why 10: two candidates with identical names differ by at
most a quarter of the spread between their search scores, and MusicBrainz gives exact
matches equal scores — so identically named candidates always land within ten of each
other and the pair is declared ambiguous. That is the Nirvana rule as arithmetic.

The tiebreaker that would actually settle Nirvana is corroboration against the local
library's releases. It costs one request per candidate against a one-request-per-second
service — eleven seconds to answer a question the operator answers in one click — so it
is not done, and the place it would land is commented in `score.ts`. D14's revisit
trigger already covers it.

### What the live probe changed

Fixtures said an absent artist comes back as an empty array. Against the real service it
does not: query a name nobody has and MusicBrainz returns whatever shares a word,
scoring in the sixties. The first cut folded that into `ambiguous`, which made the deck
say "several artists go by this name" over a list containing a Dave Brubeck record —
R5's confident wrong claim, relocated from the biography to the header. `decide` now
splits by *which* test failed: nothing plausible at all is `none` → `no-match`, plausible
but not separable is `ambiguous`. The candidates are still handed to the picker either
way, because a badly misspelled tag can put the right artist third where the operator
can see it and we cannot. Both shapes are now fixtures (`ABSENT`, `EMPTY`).

### Schema

Migration 011 adds `artists.mbid` and `artists.mbid_source`, plus a partial index
`idx_artists_mbid ... WHERE mbid IS NOT NULL` that W7-11 will read backwards through.

`mbid_source` is the column the acceptance turns on. NULL is undecided, `'auto'` may be
revised, `'manual'` never is. The guard lives in the statement —
`UPDATE artists SET mbid = ?, mbid_source = 'auto' WHERE id = ? AND (mbid_source IS NULL
OR mbid_source = 'auto')` — rather than in a service method, so no present or future
caller can go around it, and a correction made while a search is in flight wins the race
without a lock. `mbid NULL` with source `'manual'` is the operator answering "none of
these", which is a decision and is durable.

No `checked_at` column: whether we have looked is `cache.db`'s business, and with no
timestamp here, deleting the cache means "look again" — which is W7-8's property
restated rather than contradicted.

### Layers

- `src/shared/artist.ts` — `ArtistResolution`, four statuses (`resolved` / `ambiguous` /
  `no-match` / `unavailable`), `ArtistCandidate`, `isMbid`.
- `src/main/musicbrainz/` — `artistName` (query construction, Lucene escaping, compare
  key, cache key), `search` (the request and defensive parsing), `score` (similarity,
  the threshold and the margin), `store` (the two columns), `service` (the orchestration).
- Four channels: `artist.resolve`, `artist.searchCandidates`, `artist.setMbid`,
  `artist.clearMbid`. `resolve` searches **only** when the row carries no decision —
  that is the card's "once per artist, not once per play" as behaviour rather than as
  schema. `searchCandidates` is what the picker calls, so a settled artist costs no
  request until somebody disagrees with it.
- Renderer: `stores/artistIdentity.ts`, `ArtistIdentityHeader.vue`, `ArtistPicker.vue`,
  and `artistIdentity.ts` for the wording (pure, so the claims are testable without a
  DOM — and what the deck *claims* is what R5 is a risk about).

### Where the affordance lives

`TunedeckTab` gained an optional `header` component: a strip above the accordion,
outside every group, drawn only by the Artist tab. R5 asks for a *visible* "not this
artist?" affordance, and one behind a chevron is not visible — a wrong identity has to
be correctable while the panes below it are asserting things about the wrong artist. Per
tab rather than on the deck's own header, because the deck header is chrome shared with
Track, Related and Playing. The button is present in every state including `resolved`:
an affordance that only appears once the deck already knows it is unsure is missing in
exactly the case it exists for.

### Verification in the running app

Scratch instance, throwaway user-data directory, live MusicBrainz:

| tag | outcome |
|---|---|
| `Nirvana` | `ambiguous`, 12 candidates, top three at 100/95/93 |
| `Ryuichi Sakamoto` | `resolved` → `a7f7df4a-…`, matched through the alias on `坂本龍一` |
| `Godspeed You Black Emperor` | `resolved` → `3648db01-…`, across the dropped `!` |
| `Zzyzx Tapedeck Quartet` | `no-match` — near misses returned, none above the bar |

Then: picked the 60s UK Nirvana in the picker → stored `manual`; restarted the app with
`cache.db` **deleted** and `network.externalLookups` **off** → all three resolved artists
still resolved from their rows, the unresolved one reported `declined`, and the local
catalog pane was intact throughout. That is the offline half and the persistence half in
one run.

Header text, read out of the live DOM:
`Nirvana | Your choice. Kept until you change it. | IN YOUR LIBRARY | …`

### Gate

`lint`, `format:check`, `typecheck`, `test` (1950 passing, 123 files) and `build` all
green. New tests: `tests/main/musicbrainz/{artistName,resolution,service}.test.ts` and
`fixtures.ts`, `tests/renderer/panels/artistIdentity.test.ts`, plus artist-identity
cases in `tests/main/ipc/validate.test.ts` and the new columns in
`tests/main/db/schema.test.ts`.

### Left for W7-14

The offline/declined/unresolved states are exercised here per-artist, but the M7 exit
proof — every pane, every state, one pass — is that card's. Nothing about artist images
or biography text is in this commit; those are W7-10 and W7-13, and both now have an
MBID to start from.
