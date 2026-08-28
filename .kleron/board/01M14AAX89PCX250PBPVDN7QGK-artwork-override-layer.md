---
taskId: 01M14AAX89PCX250PBPVDN7QGK
title: Artwork override layer
status: done
priority: low
labels:
  - phase-3
  - main
  - schema
  - library
workstream: W16
workstreamId: W16-9
dependsOn:
  - 01M12VEX19HRHTZDD2BQWT1Q0C
  - 01M12VGDC5BYX59D9WKH9TAWDY
order: 15
created: '2026-08-28T13:53:18.088Z'
updated: '2026-08-28T19:48:16.373Z'
---
Design authority: wiki `oscine-tag-writeback` → "Embedded artwork & custom frames" (Decision A) + "Schema → Migration 020". First slice of the W16-8 artwork split.

Artwork, unlike every text field, has **no app-side source layer** feeding `proposed`. This card builds it so the flush stays a stateless projection of the correction layers (D28) and a set cover shows instantly, before any flush.

**Migration 020 — `artwork_overrides`** (per-track, tri-state, mirroring how a text override distinguishes *clear* from *absent*):
- no row → leave the file's own cover;
- row with `image_hash` set → set to that image;
- row with `image_hash IS NULL` → clear the cover on flush.
- Columns: `track_id INTEGER PRIMARY KEY REFERENCES tracks`, `image_hash TEXT` (nullable), `mime TEXT`, `created_at`.

**Override-originals store** — a new content-addressed user-data artifact (same pattern as `ARTWORK_CACHE_ARTIFACT`) holding **full-resolution** cover bytes keyed by hash (the flush writes these into the file — thumbnails will not do). Dedupes a shared album cover; GC is a **refcount over `image_hash`**, released when no override row references a hash.

**Override-aware cover resolution** — wherever the library resolves `artwork_hash` for the `oscine://` thumbnail path, coalesce `override.image_hash ?? tracks.artwork_hash`. This is the one read-path change, and it is what makes a set cover visible everywhere (Now Playing, library grid) before it is flushed.

**Reconciliation hook — this card owns it (W16-7 is already built for text only).** W16-7's retire-on-match pass knows only about `track_overrides`. Because `artwork_overrides` does not exist yet, this card must **extend the existing, completed reconciliation path** to also retire a satisfied artwork override (front cover on disk == override image) and release its originals-store refcount. This is not a W16-7 follow-up; it lands here. (R8: without it the originals store grows unbounded.)

Acceptance: the schema migrates; a per-track override can be set / cleared / absent; the originals store round-trips full-res bytes by hash and refcount-GCs an unreferenced hash; a track with an override resolves its cover to the override image through the existing `oscine://` path; the W16-7 reconciliation pass retires an artwork override once the file's front cover matches it and releases the refcount, verified by a set-cover → flush → wipe → re-scan round trip that ends with `artwork_overrides` empty.
