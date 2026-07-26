---
taskId: 01KYECERTAKPWTX3HFEDNPY8YR
title: 'Spike: verify Nuxt UI standalone with Vite + Vue 3'
status: in-review
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
updated: '2026-07-26T05:25:38.057Z'
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

---

# VERDICT: works, with three caveats — all configuration-level and stable

**R4 is closed. D3 stands. No design doc amendment needed, and the Nuxt SPA fallback is not required.**

Nuxt UI ships a first-class, documented Vue distribution. It is not a community workaround or a
compatibility shim, so it is safe to build W4 on top of.

## Versions verified against

| Package | Version |
|---|---|
| `@nuxt/ui` | 4.10.0 |
| `tailwindcss` | 4.3.3 |
| `vue` | 3.5.40 |
| `vue-router` | 5.2.0 |
| `vite` | 8.1.5 |
| `electron` | 43.2.0 |

## Method

Throwaway `vite@latest --template vue-ts` app outside the repo, Nuxt UI installed via the documented
Vue path (`@nuxt/ui/vite` plugin + `@nuxt/ui/vue-plugin`). Rendered `UTable`, `UButton` (solid /
outline / ghost), `UModal`, `UIcon`, `UCard`, plus a custom `--ui-primary` token override. Then
loaded the **production** bundle in real Electron 43 from a real `file://` origin, under the exact
hardened `webPreferences` the design doc mandates (`contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`).

## What was confirmed working under `file://`

- Page loads; no `did-fail-load`, no render-process crash, no module/CORS errors. ES modules load
  from `file://` in Electron without incident — this was the single largest suspected failure mode
  and it did not materialise.
- `UTable` rendered all 3 data rows; 5 `UButton`s rendered; `UModal` and `UCard` present.
- Stylesheets applied — 135 CSS rules live in the document.
- **Dark mode works without Nuxt app config.** Nuxt UI's Vue plugin picked up the OS colour-scheme
  preference on its own (`hadDarkOnLoad: true`), and toggling `.dark` on `<html>` flipped the
  surface colour (`rgb(255,255,255)` → `oklch(0.208 0.042 265.755)`).
- **D9's token layer works.** A custom `--ui-primary` override defined in plain CSS resolved to
  different computed values in light vs dark (`oklch(0.627 0.265 304)` vs `oklch(0.714 0.203 305)`).
  D9's theming can be built directly on these tokens with no Nuxt machinery.

## Caveat 1 — `base: './'` is mandatory

Vite defaults to `base: '/'`, which emits absolute `/assets/…` URLs. Those resolve to filesystem
root under `file://` and 404. Set `base: './'` so the built `index.html` references `./assets/…`.

Stable: this is standard, long-documented Vite configuration.

## Caveat 2 — hash history, not web history

The Nuxt UI Vue docs show `createWebHistory()`. Under `file://` there is no server to resolve
`/some/path`, so deep links and reloads break. Use `createWebHashHistory()`.

Stable: a documented first-class vue-router mode, and the standard choice for packaged Electron.

## Caveat 3 — icons must be explicitly bundled, or the app phones home

This is the one worth knowing about, and it is invisible on a developer machine with internet.

By default the Iconify runtime resolves icons by **fetching `https://api.iconify.design` at
runtime**. Verified directly: the built bundle contained the full Iconify HTTP-fetch machinery and
the API hostname, but *not* the icon geometry. The icons appeared to work — because the test machine
was online.

For an offline-first local music player that is two separate defects: icons silently vanish with no
network, and the app makes an unsolicited third-party request on every cold start disclosing which
icons the UI uses.

Note that installing `@iconify-json/lucide` **alone does not fix this** — that was tested and the
geometry still was not inlined.

The fix is the `icon.clientBundle` option, added to the Vite plugin in Nuxt UI **v4.10.0** — the
version in use:

```ts
// vite.config.ts
import ui from '@nuxt/ui/vite'

ui({
  icon: {
    clientBundle: {
      scan: true   // or: icons: ['lucide:music', …] to list explicitly
    }
  }
})
```

Also install the collection package for each icon set referenced (`@iconify-json/lucide` for the
default set).

**Verified rather than assumed.** After enabling it, the Lucide `music` path geometry
(`M9 18V5l12-2v13`) was found inlined in the built JS. The bundle was then re-loaded in Electron
with `session.enableNetworkEmulation({ offline: true })` *and* a `webRequest` handler cancelling and
logging every `http(s)` request. The icon rendered with complete path geometry and **zero network
egress attempts were logged**.

Cost: ~12 kB added to a 439 kB bundle for the icons actually used. `scan: true` is the right default;
switch to an explicit `icons: [...]` list only if scanning ever misses a dynamically-named icon.

Stable enough to build on — it is a first-party, purpose-built option, not a workaround.

## One item deliberately carried into W1-2

Electron logged its standard *"no Content-Security-Policy set"* warning. Electron notes this warning
disappears once packaged, but W1-2's acceptance criteria explicitly require no CSP warnings, so the
scaffold sets a real CSP rather than relying on that. Carried forward, not dropped.

## Implications for W1-2

Three settings the scaffold must carry, none of which are discoverable after the fact:

1. `base: './'` in the renderer build config
2. `createWebHashHistory()` in the router
3. `icon.clientBundle.scan: true` + `@iconify-json/lucide` installed

The throwaway spike app lives outside the repo and is not committed.
