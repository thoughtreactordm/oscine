---
taskId: 01KYWWYMJXQ2472MV9SV4QYJ1Q
title: 'Reset, revert, and the changed-from-default filter'
status: todo
priority: medium
labels: []
workstream: W8
workstreamId: W8-7
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 34
created: '2026-07-31T20:13:19.835Z'
updated: '2026-07-31T20:13:19.835Z'
---
The pair that makes a large settings surface diagnosable, and the reason "apply immediately with no Cancel" is safe.

Cheap to build, because the registry already knows every default and the store already knows every stored value. Expensive to omit, because without it an operator who has broken their playback has no way to find which of two hundred knobs did it — and neither does a bug report.

## Revert

- **Per setting** — a control appears on any row whose value differs from its default. Reverting deletes the stored row rather than writing the default, so the setting resumes tracking the default if that default later changes.
- **Per section** — reverts every key in a category.
- **All** — behind a confirmation, since it is the one destructive action in the settings surface.

Reverting a cascading key at an entity level restores inheritance rather than the global default; reverting at global level restores the descriptor default. W8-5's provenance is what distinguishes these, and the distinction must be visible in the button's label.

## Changed-from-default

A filter toggle in the settings view showing only keys whose resolved value differs from their descriptor default, across every category at once — the operator's whole delta on one screen. Pairs with W8-13: this is what an exported profile should look like before it is exported.

An `advanced` key that has been changed shows in this filter even when advanced disclosure is collapsed. Hiding a knob the operator has actually turned is exactly the failure mode this filter exists to prevent.

## Done when

- Revert at each of the three granularities is tested, including the delete-row-not-write-default behaviour and the cascade case.
- The filter is tested against a store containing changed, unchanged, unknown-key and advanced-and-changed values.
- Reset-all is confirmed before it fires and is a single undo-less action — say so plainly in the dialog.
