---
taskId: 01KYECF654VD7979YA2APD24PW
title: Scaffold electron-vite project (main / preload / renderer)
status: in-review
priority: high
labels:
  - M1
workstream: W1
workstreamId: W1-2
dependsOn:
  - 01KYECERTAKPWTX3HFEDNPY8YR
effort: medium
order: 0
created: '2026-07-26T04:55:54.276Z'
updated: '2026-07-26T05:36:57.803Z'
---
Stand up the real project skeleton per design doc section 7. Blocked on the R4 spike — if that came back negative, this card changes to Nuxt SPA mode first.

## Scope

- electron-vite with TypeScript across all three targets: `src/main`, `src/preload`, `src/renderer`.
- Vue 3 in the renderer, plus Nuxt UI via whatever path the spike validated. Wire `vue-router` and Pinia explicitly — D3 accepted this as a deliberate one-time cost.
- Create the directory skeleton from design section 7, including empty `src/shared` and `src/renderer/audio`. The shape is load-bearing; later cards assume it.
- BrowserWindow with `contextIsolation: true`, `nodeIntegration: false`, `sandbox` on. Do not relax these later to make something work — that is what `src/shared` and the preload bridge exist to avoid.
- `.gitignore`, `package.json` metadata, and a README stating what Fermata is plus the D1 bit-perfect caveat.

## Acceptance

- `npm run dev` opens a window rendering a Nuxt UI component, with HMR working on renderer edits.
- `npm run build` produces a loadable production bundle.
- Renderer devtools show no context-isolation or CSP warnings.
- Runs on Windows and Linux. Do not defer the Linux check — D10 makes both first-class, and platform assumptions are cheapest to remove on day one.

## Notes

No app functionality here. The next three cards depend on this existing and being boring.

---

# Outcome — done, with one acceptance criterion explicitly deferred

Commit `2264615`. Directory skeleton matches design section 7 exactly.

## Acceptance results

| Criterion | Result |
|---|---|
| `npm run dev` opens a window with a Nuxt UI component | Pass |
| HMR on renderer edits | Pass — `hmr update /panels/LibraryView.vue` on a live edit |
| `npm run build` produces a loadable production bundle | Pass — typecheck + all three targets |
| No context-isolation or CSP warnings | Pass — console completely empty |
| Runs on Windows | Pass |
| Runs on Linux | **Deferred to W6-1** — see below |

## Verification method

Rather than eyeballing devtools, the built bundle was loaded in Electron 43 by a harness that
attaches console/`did-fail-load`/`preload-error`/`render-process-gone` listeners before the app's
real main process takes over, forces the session offline, and cancels-and-logs every `http(s)`
request. Measured in the renderer:

- `window.require` and `window.process` both `undefined`; `nodeReachable: false`
- `window.fermata` present and typed
- 140 CSS rules applied; app mounted; Nuxt UI components rendered
- `--ui-primary` resolved to the D9 token value
- Icons rendered with real path geometry and **zero network egress**
- **`messages: []`** — not one console warning or error

The harness lives outside the repo. W6-1 may want to adopt it as a smoke test.

## Deviation from the spike: Vite 7, not Vite 8

`electron-vite@4.0.1` peers `vite@^5 || ^6 || ^7` and refuses Vite 8, which the spike used. The
supported combination was taken (Vite 7.3.6) and **all three spike findings were re-verified against
it** — they hold. Worth knowing that electron-vite trails Vite by a major version when planning
upgrades.

## Decisions made here worth knowing about

- **Preload is pinned to CommonJS output.** Electron rejects an ESM preload while `sandbox` is
  enabled, and sandbox stays on. `package.json` deliberately has no `"type": "module"`.
- **CSP is built per mode.** Dev needs `connect-src ws://localhost:*` for HMR; production must not
  carry it, so the policy is injected by a small Vite plugin rather than hardcoded in the HTML.
- **`frame-src` replaces `frame-ancestors`.** Chromium *ignores* `frame-ancestors` from a `<meta>`
  tag and logs an error for it — which failed the "no CSP warnings" criterion on the first run. A
  top-level BrowserWindow cannot be framed anyway, so blocking frames we might embed is the useful
  direction.
- **`.gitattributes` normalises to LF.** Staging produced CRLF warnings on every file. D10 makes
  Linux first-class, and line-ending drift between the two checkouts is exactly the class of
  platform assumption that is cheap to remove on day one.
- **Generated `components.d.ts` / `auto-imports.d.ts` are committed.** They contain only relative
  paths, so they are portable, and committing them means a fresh clone typechecks without a build
  first — which keeps W6-1's CI free of a build-before-typecheck ordering dependency.
- **Hardening beyond the card:** `webviewTag: false`, `navigateOnDragDrop: false`, a
  `will-navigate` guard pinned to the single allowed origin, a `setWindowOpenHandler` that routes
  real external links to the system browser and denies everything else, a permission handler that
  denies by default, and a single-instance lock — the last because a second instance would open a
  second connection to the same SQLite file in W2-1.

## The deferred Linux check — flagged, not silently skipped

The card says not to defer this. It was deferred anyway, as an explicit decision by the user when
the gap was raised: this is a Windows machine, and the available WSL2 route was declined in favour
of W6-1's CI matrix.

Concretely: **nothing in M1 has been executed on Linux.** The scaffold is written
platform-neutrally, but that is an intention, not evidence.

This is now load-bearing on two other cards:

- **W6-1** must get `ubuntu-latest` green. It notes no git remote exists yet — still true, confirmed
  here — so CI is unverifiable until one is added.
- **W6-2** already states that if Linux is unavailable it moves to Blocked rather than closing M1.
  That remains the backstop.

If W6-1 slips, this gap survives into M1 exit, which is precisely the drift D10 exists to prevent.
