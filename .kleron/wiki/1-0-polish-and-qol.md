---
title: 1.0 Polish and QoL
created: '2026-08-25T20:26:08.122Z'
updated: '2026-08-25T21:01:13.821Z'
---
# 1.0 Polish and QoL

The grab-bag of cross-cutting refinement that turns the milestone build into a 1.0.
This page is the design authority for workstream **W14 Polish**; every card below
references a numbered item here. Decisions marked **(settled)** were resolved in
conversation on 2026-08-25 and should not be reopened without a reason.

## Podcasts QoL

**P1 — Multi-state episode action button.** Collapse the separate Download and Play
buttons on the show page into one button that cycles by download state:
`Download` (idle) -> `Cancel` (downloading, with progress) -> `Play` (ready). The
existing per-episode trash affordance (`deleteDownload`) and the bulk "Remove
downloads" button stay as-is — removal is not a state of this button. Touches
`PodcastShowPane.vue`.

**P2 — Podcasts tabbed left-nav.** Retire `PodcastTabBar` the same way Curate did;
navigation moves into the left rail. **(settled)** Swap the two existing side-rail
sections so **Subscriptions** sits on top and **Recent** below it, then add the
**Discover** link into the Subscriptions section and keep it pinned there, so the
default Discover page stays reachable in rail context.

**P3 — Auto-refresh on visit.** Refresh a podcast's episode list automatically when
its show page is opened (respecting a sane min-interval so re-visits don't hammer the
feed).

**P4 — Auto-download Latest (keep last N).** Per-pod toggle to auto-download new
episodes. **(settled)** Retain the newest **N** downloaded episodes per pod, N
configurable per pod (default 3); pulling a newer one prunes the oldest auto-download
beyond N, but never a manually-kept episode. Toggle lives on the show page **and** as
a control on the Subscriptions rail item.

## General Polish — Navigation & Now Playing

**G1 — Rename Listening -> Stats; separate concerns in the tab nav.** Rename the
Listening view to **Stats**, and move **Stats** and **Settings** to the right side of
the tab nav, visually separated from the primary navigation tabs.

**G2 — Now Playing tab lifecycle.** Hide the Now Playing nav tab when nothing is
playing. **(settled)** When the active queue ends naturally (playing through, not
paused/stopped) while Now Playing is showing, navigate back to the **last-visited
view** (Library or Curate, whichever the user came from — tracked).

**G3 — Now Playing bar 3-dot menu.** Wire the long-standing placeholder menu with
song-scoped options: Add to Playlist, View Artist, View Album.

**G4 — Now Playing Auto-show (idle).** New Interface setting: after **N** minutes of
no in-app interaction while music plays in the background, navigate to Now Playing.
Selectable intervals in minutes: 5, 10, 15, 30, 60. **(settled)** Default off.

## General Polish — Settings & Shortcuts

**G5 — Interface toggles.** Two new Interface settings: (a) toggle the top-bar
Command Palette search affordance; (b) disable the Tab navigation bar in favour of
keyboard shortcuts + the Command Palette. **(settled)** First-run defaults ship
everything visible — palette affordance ON, tab bar ON, G4 auto-show OFF; these are
opt-in power-user toggles.

**G6 — Keyboard shortcuts (fixed default set).** **(settled)** Ship a curated,
non-rebindable set for 1.0; rebinding is deferred post-1.0 (the homeless
keyboard-shortcut subsystem noted in W8/W13 finds its first home here — D27 seam).
Cover: playback (play/pause, next/prev, seek, volume), navigation to tabs, open
Command Palette, focus search. Document the set in Help -> (a shortcuts reference).

## General Polish — Chrome & Consistency

**G7 — Title menu: View + Help.** The native title menu today has only Library and
Playback with thin options. Add top-level **View** and **Help**:
- **View** — navigation to the default tabbed-nav items, plus Tunedeck and Quick Menu.
- **Help** —
  - **About**: modal with the app icon + typemark, current version, and the byline
    "Created with love by Michael DeLally".
  - Links to how-to / documentation (placeholder targets fine for now).
  - **Open Source**: modal detailing the major OSS packages Oscine leans on.
    **(settled)** Hand-curate the notable stack (name + license + link): Electron,
    Vue 3, Nuxt UI, better-sqlite3, node-web-audio-api, sharp, Tabler Icons, etc. —
    not an auto-generated dependency dump.

**G8 — Context-menu pass.** More surfaces become right-clickable with contextual
controls. **(settled)** 1.0 scope is **track rows** (Library / playlist / queue) and
**album & artist cards** (Curate): Play, Add to Queue, Add to Playlist, View
Artist/Album, Track Info. (Podcast episodes and rail items are out of this pass.)

**G9 — Copy de-slop + em-dash removal.** Editorial pass over in-app copy; remove em
dashes and tighten slop.

**G10 — Tooltip consistency pass.** Prefer `UTooltip` for UI consistency where
tooltips are currently native HTML `title` attributes; keep a semantic fallback where
it matters.

## Bugs

**B1 — Stats vertical scroll trapped over stat cards.** On the Stats (formerly
Listening) view, the page won't scroll vertically while the mouse hovers any of the
four large top-50 stat cards. Wheel events over the cards should still scroll the
page.
