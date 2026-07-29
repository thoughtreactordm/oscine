# Fermata — Project Instructions

## What this is

A format-first local music player for large libraries: Electron shell, Vue 3 renderer, SQLite
library in the main process, Web Audio playback in the renderer. Poweruser library control with a
themeable modern interface. No streaming integration — the library is folders on disk.

Current milestone: **M1 "It plays"** — thin end-to-end slice, every layer touched, none finished.

## Design authority

The design document is the Kleron wiki page `fermata-design` (`.kleron/wiki/fermata-design.md`),
committed to this repo. It records thirteen settled decisions (D1–D13) with rationale and explicit
"revisit when" triggers, four named risks (R1–R4), schema v1, and the seven queue-semantics rules.

Read it before proposing architectural change. Do not reopen a D-number without checking that its
revisit trigger has actually fired. `docs/DESIGN.md` is a pointer to it, not a second copy — keep it
that way.

## Board

Workstreams and cards live in `.kleron/`. Six streams: W1 Foundation, W2 Library, W3 Audio, W4 UI,
W5 Playlists & Queue, W6 Packaging & Ops.

## Commands

| Task | Command |
|---|---|
| Dev | `npm run dev` (electron-vite, HMR) · `npm run dev:raw` for unfiltered Chromium stderr |
| Test | `npm test` (Vitest) · `npm run test:watch` |
| Typecheck | `npm run typecheck` (`tsc` for node, `vue-tsc` for web) |
| Build | `npm run build` (typechecks first) |
| Native ABI check | `npm run verify:native` |
| Seed test library | `npm run seed:synthetic` |

**There is no `lint` script, deliberately.** `typecheck` is the pre-push gate. The global pre-push
hook will report lint as missing; that is expected, not a broken setup.

## Context discipline

This repo's wiki and board tools return more than they appear to. Budget accordingly:

- `kleron_wiki_list` returns the **full body of every document**, not a listing. The design doc alone
  is ~8k tokens. Use `kleron_wiki_search` to locate, then `kleron_wiki_read` by name.
- `kleron_kanban_list_cards` filtered by `workstream` or `status`, never `kleron_kanban_get_board`.
- Route read-and-digest work — scanning `src/main/library/`, reading test output, summarizing a long
  card — through `kleron_delegate` with the files preloaded, then `kleron_delegate_await`. Do not
  read large files into the main context to summarize them, and do not spawn a full subagent for it.
- Reserve direct reading for work that needs judgement: writing code, tracing a bug across layers,
  weighing a design decision.

## Conventions

- **`src/shared` is the only cross-process contract.** IPC channel names and their types live there
  and are imported by main, preload and renderer, so the two sides cannot drift. New IPC surface
  starts in `src/shared/ipc.ts`, not in a handler.
- **Panels are islands.** `src/renderer/panels/` components make no assumptions about their
  neighbours — that is what lets a docking system land later without a rewrite.
- **Theming goes through the token layer** (`src/renderer/theme/`), CSS custom properties over Nuxt
  UI. Never hardcode a colour in a component. Exit criterion for M5 is that swapping a theme touches
  zero component code.
- **Tests** mirror the process split: `tests/main/` and `tests/renderer/`.
- Conventional Commits, one logical change per commit.

## Invariants

These are the rules whose violation causes damage rather than mess.

- **Paths are stored relative to a named root**, POSIX-normalised on write and rejoined
  per-platform on read. This is the single most important detail for Windows/Linux portability and
  it makes the D11 export bundle work. Never store an absolute path in `tracks`.
- **The renderer never touches the filesystem.** Context isolation on, `nodeIntegration` off, narrow
  typed `contextBridge` surface. Every library operation crosses IPC.
- **Audio lives in the renderer.** Web Audio has no main-process equivalent. It stays behind the
  `AudioEngine` interface (`src/renderer/audio/`) so R1 can replace the implementation without the
  UI noticing — the interface is not optional scaffolding.
- **R1's memory guard ships with the decode path, not after it.** Estimate decoded size before
  decoding; fall back to `<audio>` streaming above the per-track cap; enforce the total budget across
  current+prefetch. Without it, a long-track library is a crash.
- **Gapless and crossfade are mutually exclusive per boundary.** `crossfade_ms == 0` means gapless;
  non-zero means crossfade. Never both.
- **Every list is virtualized from its first commit.** The scale target is 100k tracks; virtualization
  is never retrofitted.
- **v1 never writes tags to disk** (D7). Corrections live in `track_overrides`.
- Both Windows and Linux are first-class. No platform-specific path or shell handling.
