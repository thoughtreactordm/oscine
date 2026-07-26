---
taskId: 01KYECERTAKPWTX3HFEDNPY8YR
title: 'Spike: verify Nuxt UI standalone with Vite + Vue 3'
status: todo
priority: high
labels:
  - M1
  - R4
  - spike
workstream: W1
workstreamId: W1-1
effort: medium
order: 0
created: '2026-07-26T04:55:40.618Z'
updated: '2026-07-26T04:55:40.618Z'
---
Resolves **R4** in the design doc. D3 assumes current Nuxt UI supports a plain Vue 3 + Vite app via its Vite plugin, without Nuxt itself. That assumption is **unverified** and everything in W4 sits on top of it, so it gets checked before the real scaffold commits to it.

## Scope

- Check the current Nuxt UI docs for the supported standalone/Vue install path — do not work from memory, the package has changed shape across major versions.
- Build a throwaway Vite + Vue 3 + TypeScript app outside the repo. Install Nuxt UI per the documented standalone path.
- Render several components that Fermata will actually lean on: a data table or list, a button, a modal, an icon, and something using the color/appearance tokens.
- Confirm dark mode and the color-token layer work without Nuxt's app config, since D9's theming is built directly on those tokens.
- Confirm it builds for production and the output loads from a `file://` origin — Electron's renderer does not serve over HTTP, and this is the most likely place a Nuxt-shaped assumption breaks.

## Acceptance

- A written verdict recorded on this card: standalone works cleanly, works with caveats, or does not work.
- If caveats: the exact workarounds, and whether they are stable enough to build on.
- If it does not work: say so plainly and stop. The documented fallback is Nuxt in SPA mode, which changes packaging but not architecture — that becomes a design doc amendment before any scaffold work starts.

## Notes

Timebox this. It answers one yes/no question. If the answer is not clear within a short session, that ambiguity is itself the finding and the fallback becomes more attractive.
