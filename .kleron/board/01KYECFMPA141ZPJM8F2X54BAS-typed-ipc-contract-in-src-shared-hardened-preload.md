---
taskId: 01KYECFMPA141ZPJM8F2X54BAS
title: Typed IPC contract in src/shared + hardened preload bridge
status: todo
priority: high
labels:
  - M1
workstream: W1
workstreamId: W1-3
dependsOn:
  - 01KYECF654VD7979YA2APD24PW
effort: high
order: 2
created: '2026-07-26T04:56:09.162Z'
updated: '2026-07-26T04:56:09.162Z'
---
The seam between main and renderer, defined once in `src/shared` so the two sides cannot drift (design section 6). Worth more care than its size suggests — every later W2/W3/W4 card crosses this boundary, and widening it under deadline pressure is how context isolation gets quietly disabled.

## Scope

- Define channel names, request and response types for the M1 surface: `library.addRoot`, `library.listRoots`, `library.scanRoot`, `library.listTracks`, `library.getTrackFileUrl`.
- A single source of truth mapping channel to request/response type, so a handler with the wrong shape fails at compile time rather than at runtime.
- `contextBridge.exposeInMainWorld` publishing a narrow typed API. Expose named operations only — never a generic `invoke(channel, ...args)` passthrough, which hands the renderer the whole main process.
- Typed handler registration on the main side, with errors serialized deliberately rather than leaking stack traces or absolute paths into the renderer.
- Renderer-side type declarations so `window.fermata` is fully typed.

## The file access question

The renderer needs to hand a URL to `decodeAudioData`, but D-section-6 forbids it touching the filesystem. Decide here and record the reasoning on this card:

- A custom protocol handler registered in main that resolves a track id to bytes, keeping paths entirely main-side. Preferred — the renderer never learns a real path.
- Or main returning a `file://` URL for a validated track id.

Whichever is chosen, resolution goes **through a track id**, never a renderer-supplied path. A renderer-supplied path is an arbitrary-file-read primitive.

## Acceptance

- Renderer can call every M1 channel with full type inference and no `any`.
- Changing a response type in `src/shared` breaks compilation on both sides.
- No filesystem, `path`, or `fs` import is reachable from renderer code.
