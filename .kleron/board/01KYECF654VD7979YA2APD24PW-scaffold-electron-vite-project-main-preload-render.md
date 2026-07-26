---
taskId: 01KYECF654VD7979YA2APD24PW
title: Scaffold electron-vite project (main / preload / renderer)
status: todo
priority: high
labels:
  - M1
workstream: W1
workstreamId: W1-2
dependsOn:
  - 01KYECERTAKPWTX3HFEDNPY8YR
effort: medium
order: 1
created: '2026-07-26T04:55:54.276Z'
updated: '2026-07-26T04:55:54.276Z'
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
