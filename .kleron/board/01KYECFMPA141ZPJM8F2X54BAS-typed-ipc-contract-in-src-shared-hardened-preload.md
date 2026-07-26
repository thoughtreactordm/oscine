---
taskId: 01KYECFMPA141ZPJM8F2X54BAS
title: Typed IPC contract in src/shared + hardened preload bridge
status: in-review
priority: high
labels:
  - M1
workstream: W1
workstreamId: W1-3
dependsOn:
  - 01KYECF654VD7979YA2APD24PW
effort: high
order: 0
created: '2026-07-26T04:56:09.162Z'
updated: '2026-07-26T05:46:24.956Z'
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

---

# Outcome — done

Commits `ac234e4` and `4e08350`.

## DECISION: custom protocol, `fermata://track/<id>`

The card's preferred option was taken. Reasoning, for the record:

Both candidates resolve through a track id, so both close the arbitrary-file-read hole. The
difference is what the renderer *learns*. A `file://` URL still discloses the user's filesystem
layout — every album folder, every drive letter, the username in the home path — to the layer with
the largest attack surface and the most third-party code in it. The custom protocol discloses
nothing: the renderer holds an opaque integer.

It is also the cheaper option to keep correct over time. With `file://` URLs, the invariant "never
build a URL from a renderer-supplied string" has to be re-established by every reviewer of every
future card. With the custom protocol, the renderer has nothing to build a path *from*.

Implementation notes:

- `Track` in `src/shared/library.ts` carries **no path, relPath or filename field at all**. The
  absence is load-bearing and commented as such, so nobody adds one for convenience later.
- The handler accepts only `/^[1-9][0-9]*$/` as the path segment. There is no traversal surface
  because there is no string to traverse with.
- `LibraryRoot.path` *is* exposed, deliberately. The Sources panel must show users which folder
  they picked, and a path the user chose themselves is not a disclosure. `ScanProgress.currentFile`
  is basename-only for the same reason inverted — it is a status line, not a location.
- Registered with `stream: true` so large FLACs are not buffered whole, and served via `net.fetch`,
  which handles Range requests for seeking.

## Two defects found by testing, both of which changed the design

Neither would have been caught by reading the code, and both would have surfaced much later
disguised as something else.

### 1. Errors do not survive `contextBridge` as errors

The first implementation threw a `FermataError` from the preload. Measured from the renderer, it
arrives as a **bare `Error`**: `name` is `"Error"`, and `code` is `undefined`. The subclass and every
custom property are stripped crossing into the main world.

Callers would have been left string-matching messages to tell "no such track" from "disk
unreadable" — the exact fragility the typed contract exists to prevent.

Fix: data crosses intact even though errors do not, so the bridge now returns the `IpcResult`
envelope, and `src/renderer/ipc.ts` rebuilds a real `FermataError` on the renderer side where the
class is native. Renderer code imports from `src/renderer/ipc.ts` rather than touching
`window.fermata`, and can branch on `err.code`.

### 2. The `fermata://` scheme needs `corsEnabled: true`

Initially set to `false`, reasoning that only our own renderer would ever fetch it. Every fetch was
then refused *before reaching the handler*:

> Access to fetch at 'fermata://track/1' from origin 'file://' has been blocked by CORS policy

The `file://` document has an opaque origin, so the request is cross-origin regardless of intent.
This would have surfaced in W3-1 as playback silently failing, with the cause several layers from
the symptom. `corsEnabled: true` fixes it. This is not a real widening — `fermata:` is not
network-reachable, and the renderer is the only document that exists.

## Acceptance results — measured, not asserted

Exercised from inside the real renderer against the built bundle:

| Check | Result |
|---|---|
| Every M1 channel callable, fully typed, no `any` | Pass |
| Error codes arrive intact | Pass — `not-found`, `invalid-request`, `internal` all correct |
| `sort: "title; DROP TABLE tracks"` | Rejected, `invalid-request` |
| `limit: 99999` | Rejected, `invalid-request` |
| `getTrackFileUrl(-1)`, `scanRoot("not-a-number")` | Rejected, `invalid-request` |
| `fermata://track/1` (unknown id) | 404 |
| `fermata://track/..%2F..%2Fwindows%2Fwin.ini` | 400 |
| `fermata://file/1` (wrong host) | 404 |
| Generic passthrough on `window.fermata` | None — only `versions` and `library` |
| `window.require` / `window.process` | Absent |
| Console output | Empty |

**Changing a response type breaks both sides** — verified by actually doing it. Changing
`library.listRoots` from `LibraryRoot[]` to `LibraryRoot` produced, from one line:

```
src/main/ipc/index.ts(16,37): error TS2322: Type 'Promise<LibraryRoot[]>' is not assignable...
src/renderer/panels/LibraryView.vue(18,5): error TS2322: Type 'LibraryRoot' is not assignable...
```

**No filesystem reachable from the renderer** — no node-builtin or `electron` import anywhere in
`src/renderer` or `src/shared`; zero occurrences of `ipcRenderer`, `contextBridge`, `node:fs`,
`node:path`, `__dirname` or `process.cwd` in the built renderer bundle.

## Deliberate additions beyond the listed scope

Each is small, and each exists to stop a later card from widening the boundary badly under pressure:

- **`IpcEventContract`, with `library.scanProgress`.** W2-2 must report scan progress, and a one-way
  channel genuinely needs a different shape — no response, and subscription requires listener
  cleanup. Establishing the safe pattern now is cheaper than W2-2 inventing one.
- **Sender validation.** Handlers reject any sender whose frame URL does not match the one allowed
  renderer URL, and reject subframes outright. Compared as a **prefix, not by origin**, because
  every `file://` URL reports its origin as the string `"null"` — an origin check would have
  accepted any local file. The same bug was fixed in `will-navigate`.
- **`assertEveryChannelHandled()` at startup**, plus a compile-time check that `IPC_CHANNELS` covers
  the contract. A missing handler fails at boot rather than as an inscrutable rejection the first
  time a user clicks something, possibly milestones later.
- **`PendingLibraryService`.** Lets the boundary land complete before W2-1 has a database. It
  answers *honestly* rather than plausibly: `listRoots` and `listTracks` return empty because with
  no database there genuinely are none, while `addRoot` and `scanRoot` fail loudly rather than
  returning fabricated data that would make W4 look like it works. W2-1 swaps the implementation and
  nothing else moves.

## Note for W2-1

`assertListTracksQuery` validates `sort` and `direction` against closed allowlists **because W2-1
interpolates them into an `ORDER BY` clause.** A TypeScript union is erased at runtime and protects
nothing. Do not remove that check, and do not add a sort column to `TRACK_SORT_COLUMNS` without
confirming it is a real column name.

## Not pushed

No git remote exists on this repository, so the branch is committed locally only. This is the same
gap W6-1 records; it also means W6-1's CI matrix stays unverifiable until a remote is added.
