---
taskId: 01M1FJ24A6GBCQ31HBZYTRAT1P
title: 'Rip: the Tools pane — disc detection, release match, track selection, progress'
status: backlog
priority: medium
labels:
  - cdrip
  - ui
  - tools
  - renderer
workstream: W18
workstreamId: W18-7
dependsOn:
  - 01M1FJ0P2N21SZFS5S8890MFHD
  - 01M1FJ1A7514VX99VMCYXJ7PHC
order: 21
created: '2026-09-01T22:39:57.766Z'
updated: '2026-09-01T22:39:57.766Z'
---
## Intent

The operator-facing half: the second entry in the Tools rail, and the pane that takes a disc from
"inserted" to "ripping" with the metadata confirmed on the way.

## The rail seam

`src/renderer/stores/tools.ts` says it outright — adding a tool is an entry in `TOOLS` and a branch
in `ToolsView`. So:

```ts
export const CD_RIP_TOOL = 'cd-rip'

export const TOOLS: readonly ToolDescriptor[] = [
  { id: TAG_WRITEBACK_TOOL, label: 'Tag write-back', icon: 'i-tabler-file-pencil' },
  { id: CD_RIP_TOOL, label: 'Rip CD', icon: 'i-tabler-disc' }
]
```

Nothing else about the Tools tab changes. This card is the proof that W16-6's "built to hold more
without a second rail or route" claim was true; if it needs more than the two edits, fix the seam
rather than working around it.

## Detection

There is no portable media-insertion event. Poll `READ TOC` every ~2 s **only while the pane is
visible**, plus a manual Refresh button. Do not add a background optical poll — it spins drives up,
costs battery, and buys an event nobody is waiting for when the pane is closed.

States the pane must render, each distinctly: no drive present, drive present with no disc, disc
present but not audio (a data-only disc — say so rather than showing an empty track list), reading
TOC, ready.

## Flow

1. **Disc summary** — track count and total duration from the TOC. This is available offline and
   instantly, before any lookup, and it is what tells the operator the app actually sees the disc.
2. **Metadata match.** With consent on, W18-2's candidates render as a picker: release title,
   artist, year, country/format and track count so pressings are distinguishable. **Nothing is
   auto-applied** — the operator confirms, matching R5's stance on identity. With consent off or a
   404, go straight to the editable table with the "Unknown" placeholders and say why in one quiet
   line, not an error banner. An unmatched disc is a normal outcome.
3. **Track table** — per-track include checkbox, editable title and artist, track number. Use
   `TriCheck` from `panels/tools/` for the all/none/some header rather than a second implementation.
4. **Destination** — root picker plus the naming template field, with a **live preview of the first
   track's resulting path**. The preview is what makes the template comprehensible; a template field
   without one is a guessing game. Surface W18-4's `validateRipDestination` failures inline and
   disable Rip while invalid.
5. **Progress** — per-track and overall, current phase, and a Cancel that responds immediately.
6. **Report** — per-track outcomes, `verify-failed` visually distinct from `failed` (the file
   exists but is suspect, which is a different action for the operator), and a link to reveal the
   ripped album in the library.

## Theming

CSS custom properties from `src/renderer/theme/` only. No hardcoded colour, including for the
verify-failed and failed states — those want semantic tokens, and if the right token does not exist,
add it to the token layer rather than reaching for a hex value in a component.

## Files

- `src/renderer/stores/tools.ts` — the rail entry
- `src/renderer/views/ToolsView.vue` — the branch
- `src/renderer/panels/tools/CdRipPane.vue`, `DiscTrackTable.vue`, `ReleaseMatchPicker.vue`
- `src/renderer/stores/cdRip.ts` — the pane's state, IPC subscription, poll lifecycle

## Tests

`tests/renderer/`, against a mocked IPC surface:

- Each detection state renders its own affordance, and the poll **stops when the pane unmounts** —
  a leaked 2 s interval is the likely defect here.
- Consent off skips the picker and lands on the editable table with placeholders.
- Multiple candidates require an explicit choice; none is pre-selected.
- The path preview updates with the template and reflects sanitization (type a `/` into the album
  field, see it sanitized in the preview).
- Rip is disabled while the destination is invalid, with the reason shown.
- Cancel dispatches immediately during a running rip.
- Every list that can reach 99 rows is virtualized — the track table is small in practice but the
  invariant has no exception clause.

## Out of scope

No eject button. No drive-speed control. No editing of tracks already in the library — that is the
metadata editor's job. No cover-art picker at rip time; artwork arrives through the ordinary
library path once the files are indexed.
