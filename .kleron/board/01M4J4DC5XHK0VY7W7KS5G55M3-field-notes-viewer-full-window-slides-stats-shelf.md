---
taskId: 01M4J4DC5XHK0VY7W7KS5G55M3
title: 'Field Notes viewer — full-window slides, Stats shelf, palette entry'
status: backlog
priority: medium
labels:
  - D34.5
  - D34.10
  - renderer
workstream: W22
workstreamId: W22-7
dependsOn:
  - 01M4J4BDWAMGQGVQYWFBDEK1B2
  - 01M4J4BMT3XYEQ48QKV2VN5054
order: 33
created: '2026-10-10T05:26:14.972Z'
updated: '2026-10-10T05:26:14.972Z'
---
Spec: wiki `oscine-field-notes` → D34.5, D34.10.

**Viewer** — a panel island that renders `buildSlides(report)` (W22-5) full-window. ←/→ and Space step, Esc closes, a progress indicator shows position. The viewer renders the model's strings; it makes no decisions about which slides exist.
- Colour only through the theme token layer; motion only through the duration tokens, so the reduced-motion clamp applies. Swapping themes must touch no viewer code.
- **Artwork resolved at view time** by matching snapshot identities (album artist + album, artist) against the current library through IPC, with a generated, token-coloured placeholder when nothing matches. No network.

**Stats shelf** — a "Field Notes" section in the Stats view listing saved reports (`recap.list`): open, regenerate (into W22-6's flow), delete with confirm, and "New Field Notes".

**Command Palette** — an entry that opens the shelf or the most recent report, through the W13 search/action surface.

**Done when:** a saved report opens from the shelf and the palette, steps through with the keyboard, renders under at least two themes and with reduced motion on, and an imported-only album without a local match shows the placeholder. Dev verification is the operator's own `npm run dev`; there is no web preview for Electron.
