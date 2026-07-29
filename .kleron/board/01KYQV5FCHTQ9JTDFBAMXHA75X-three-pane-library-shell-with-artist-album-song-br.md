---
taskId: 01KYQV5FCHTQ9JTDFBAMXHA75X
title: Three-pane library shell with Artist/Album/Song browsing and search
status: done
priority: high
labels:
  - M3
  - UI
  - library-browser
  - search
  - virtualized
workstream: W4
workstreamId: W4-3
dependsOn:
  - 01KYQV3V8PD4GETWCWTJ6AP5D2
effort: high
order: 3
created: '2026-07-29T21:05:54.577Z'
updated: '2026-07-29T21:54:33.000Z'
---
Replace the M1 placeholder shell with M3's real library browser. Reconcile the design's two descriptions directly: the fixed islands remain Sources / TrackList / NowPlaying (D4), while Sources contains the Artist and Album facets and TrackList is the Song result. That delivers Artist/Album/Song browsing without coupling the islands.

This UI work is not blocked by W6-4's pending Windows evidence for M2.

## Scope

- Build a fixed desktop three-region shell from self-contained `Sources`, existing `TrackList` and existing `NowPlaying` islands. The shell owns layout and wiring only.
- In `Sources`, provide virtualized Artist and Album facets with counts, All Artists/All Albums choices, keyboard navigation and explicit empty/loading/error states.
- Artist selection filters albums and songs; album selection filters songs. Changing an upstream facet clears only invalid downstream state.
- Add instant search over title/artist/album using W2-5's FTS-backed query. Debounce input, show pending state without blanking good results, and discard out-of-order responses.
- Preserve sort and scroll state sensibly per browse context; filtering must never allow a stale page from the previous query into the new list.
- Extend the captured list play order to include the active browse/search filters, so next/previous traverse the songs the user is actually looking at rather than the whole database.
- Provide artwork slots and missing-art placeholders using semantic tokens. Consume W2's opaque cached-art URL when available, but do not make initial shell work depend on the artwork card.
- Keep every unbounded list virtualized and every color routed through the token layer. Use accessible labels, focus order and selected-state semantics.

## Explicitly not in scope

Docking/resizable pane architecture, playlist tabs, queue UI, saved searches, tag editing, theme editor, mobile layout, or exposing filesystem paths.

## Acceptance

- An Artist → Album → Song browse produces correct, paged results and All choices unwind filters predictably.
- Search includes true title/artist/album infix matches and remains correct through rapid typing and filter changes.
- Artist, album and song DOM counts stay flat while traversing the 100k fixture.
- Double-click playback plus next/previous remains inside the active filtered/search result in stable sort order.
- Focus can traverse all three islands; facet and track selection are screen-reader identifiable.
- No hardcoded component colors and no island imports or reaches into a neighbouring island's store/component internals.
- Search/browse interaction timings and renderer frame work are exposed to W6's M3 exit probe.
