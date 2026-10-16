---
taskId: 01M4J4C0NAQMNZMB8RX5520GRT
title: 'Generation flow UI — year picker, add exports, regenerate warning'
status: backlog
priority: medium
labels:
  - D34.2
  - D34.4
  - renderer
workstream: W22
workstreamId: W22-6
dependsOn:
  - 01M4J4BDWAMGQGVQYWFBDEK1B2
order: 32
created: '2026-10-10T05:25:30.408Z'
updated: '2026-10-10T05:25:30.408Z'
---
Spec: wiki `oscine-field-notes` → D34.2, D34.4.

The "new Field Notes" flow, opened from the Stats shelf (W22-7).

- **Year picker** — years that have host listens, newest first; the current year is marked "so far".
- **Add device exports** — "Add export…" goes through the main-process dialog (`recap.generate` owns file choice; the renderer never sees a path's contents). Show each added export's device label, range and row count as main reports them, with remove. Zero imports is the normal case and must feel complete, not like a missing step.
- **Regenerate warning** — if the year already has a report, show what `recap.existing(year)` returns before generating, naming the devices it was built from: regenerating without re-adding them drops them (imports are not remembered).
- **Progress and cancel** from the long-job channel; on success, open the viewer on the new report.
- Validation failures from main (wrong format, newer version, corrupt file) show per file with the reason; one bad file does not block the rest.

Strings say "Field Notes"; nothing else does (D34.9). Colour via tokens only.

**Done when:** a report can be generated from the UI with and without imports, the regenerate warning names the right devices, and a bad file is reported without aborting the flow. Dev verification is the operator's own `npm run dev`; there is no web preview for Electron.
