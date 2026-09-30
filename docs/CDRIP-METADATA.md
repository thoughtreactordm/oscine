# Rip metadata (W18-2)

`manualDiscProposal(toc)` is synchronous and needs no drive or network service. W18-5/6 can show
and edit it immediately; completion of `createDiscLookup({ client, cache }).lookup(toc)` is never
required to enter metadata. Lookup returns MusicBrainz candidates, otherwise one CD-TEXT proposal,
otherwise one blank manual proposal with the audio track numbers. It does not choose a release or
write library metadata. A later lookup must not overwrite operator edits.

Inject the application's existing consent-gated `NetClient` and `CacheService`. Requests use the
`cdrip` scope. The future pane/session owner must cancel that scope on close/cancel using the existing
network cancellation API and ignore replies from an abandoned session. Lookup failures, including
cancellation, return local proposals; they do not throw network errors. Invalid TOCs are rejected.
MusicBrainz replies use `musicbrainz.disc`, keyed by disc ID, with 30-day positive and 7-day negative
TTLs. Fresh cached answers work offline; stale positive answers follow the existing stale-if-error
policy. Release selection belongs to the future rip session, not this cache.

The same native `readToc` operation now optionally returns `cdText`, a format-5 byte response.
Missing, unsupported or failed CD-TEXT reads leave the TOC available. Media removal/change still
invalidates the read. Audio-sector reads do not repeat the optional metadata request. The parser
checks pack CRCs and continuity, handles title/performer continuations and tab repetition, and
accepts ASCII or explicitly declared ISO-8859-1. Unsupported double-byte/character-set blocks are
skipped instead of decoded speculatively.

## Correction to the card's enhanced-CD requirement

The original card says to hash data tracks. That conflicts with
[MusicBrainz's published algorithm](https://musicbrainz.org/doc/Disc_ID_Calculation): an enhanced CD
uses the contiguous audio tracks and the first trailing data track's LBA minus 11,400 as the audio
lead-out, then adds the 150-frame bias. The implementation follows MusicBrainz so lookup works.
The original physical TOC, including data tracks, remains intact. This is independently tested
against the documentation's published enhanced-CD ID `BPnh1KU.hea1C.KMYWLGZkHJr0w-`.

## Fixture provenance and verification

`tests/main/cdrip/fixtures/disc-ids.json` records published TOCs and source URLs, including one-track,
99-track and enhanced discs. Fixture TOCs use MusicBrainz's biased offsets; test helpers convert to
native LBA. `musicbrainz-disc.json` is the unmodified JSON payload (pretty-printed) fetched on
2026-09-09 UTC from:

https://musicbrainz.org/ws/2/discid/49HHV7Eb8UKF3aQiNmu1GR8vKTY-?inc=recordings+artist-credits+release-groups&fmt=json

Multiple-candidate tests derive explicitly synthetic variants from that payload. CD-TEXT tests use
synthetic CRC-bearing packs and exercise the real native MMC implementation with a scripted
transport. Physical CD-TEXT discs and Windows drive behavior still require the W18-9 hardware pass.
