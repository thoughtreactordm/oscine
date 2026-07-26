---
taskId: 01KYECFW1NMMVWQR2VT7PBQ4VM
title: 'Tooling baseline: lint, format, Vitest, CI matrix'
status: todo
priority: medium
labels:
  - M1
workstream: W6
workstreamId: W6-1
dependsOn:
  - 01KYECF654VD7979YA2APD24PW
effort: medium
order: 3
created: '2026-07-26T04:56:16.692Z'
updated: '2026-07-26T04:56:16.692Z'
---
Quality gates in place before there is much code to retrofit them onto.

## Scope

- ESLint + Prettier across main, preload, renderer and shared, with Vue SFC support.
- Vitest configured for unit tests, able to import from `src/shared` and `src/main` without an Electron runtime.
- GitHub Actions workflow: matrix over `windows-latest` and `ubuntu-latest`, running lint, typecheck, test and build.
- A lint rule or CI check that catches Windows-only path handling — string concatenation with backslashes, or `\\` literals in path construction. D10 makes Linux first-class and this class of bug is invisible until you switch machines. Cheap now, tedious later.

## Acceptance

- All four commands pass locally and green on both CI runners.
- A deliberately broken path-handling line fails CI, proving the check works rather than merely existing.

## Notes

No repository remote exists yet. If none is configured when this is picked up, commit the workflow file anyway and note on the card that CI is unverified until a remote is added — do not silently skip it.
