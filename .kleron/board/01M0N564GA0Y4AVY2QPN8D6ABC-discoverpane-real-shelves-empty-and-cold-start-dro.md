---
taskId: 01M0N564GA0Y4AVY2QPN8D6ABC
title: 'DiscoverPane — real shelves, empty and cold-start, drop the Placeholder badge'
status: done
priority: high
labels:
  - ui
  - curate
  - D20
workstream: W12
workstreamId: W12-4
dependsOn:
  - 01M0N55P8K3JVM7YXCSKZ5P27V
order: 6
created: '2026-08-22T16:34:42.314Z'
updated: '2026-08-24T17:56:51.579Z'
---
Spec: wiki `fermata-discover-1-0` → UI.

Replace the skeletons. The Placeholder badge comes off when `discover.shelves` is a real result — one shelf counts, cold-start `unplayed` counts. Empty library (zero tracks) is a designed empty state, not fake vinyls.

**Do not compute recipes in the renderer.** Fetch `discover.shelves`, render what comes back. Dynamic titles replace the placeholder `h3`; hints stay the static recipe lines. Per-shelf horizontal scroller stays; ten cards are not virtualized (the cap is the reason).

Token layer only. Panels remain islands — no import of the dashboard, the Tunedeck, or Library facets. Artwork through the existing `oscine:` thumbnail path. No artwork is the same token-coloured vinyl the placeholder already draws.

Cold start: do not render empty-headed `for-you` / `revisit` / `artists` skeletons. Omit, as compose already omitted.

Play, queue, and save-as-playlist are W12-5. This card is the wall.

**Done when:** a library with listens shows real covers and *whys* on the four (and extras if W12-3 is in); a library with zero listens shows `unplayed` only; a library with zero tracks shows the empty state and no badge.
