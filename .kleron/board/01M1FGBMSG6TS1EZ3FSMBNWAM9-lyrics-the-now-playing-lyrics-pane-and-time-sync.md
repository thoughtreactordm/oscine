---
taskId: 01M1FGBMSG6TS1EZ3FSMBNWAM9
title: 'Lyrics: the Now Playing lyrics pane and time sync'
status: backlog
priority: medium
labels:
  - lyrics
  - renderer
  - ui
workstream: W17
workstreamId: W17-3
dependsOn:
  - 01M1FGA0QA7ESY1H2H6BR18ASW
  - 01M1FGAS6272V4J1Z8GDYXNGKZ
order: 12
created: '2026-09-01T22:10:12.399Z'
updated: '2026-09-01T22:10:12.399Z'
---
## Intent

The visible half: a lyrics pane on the Now Playing stage that highlights the current line and
scrolls with playback. **This is the card that makes the stream shippable** — with W17-1 and W17-2
it is a complete, useful, entirely local feature, and the network cards after it are additive.

## Time sync — the clock already exists

`playback.currentTime` and `playback.duration` are reactive in the playback store (they are what
`SeekBar.vue` binds to), fed by the engine's `timeupdate` at `TIME_UPDATE_MS = 250`
(`src/renderer/audio/DecodedAudioEngine.ts:51`). That comment is right that the cadence is
deliberately not rAF so the clock keeps running when the window is hidden — **do not change it for
this feature.**

250 ms is fine for deciding *which line is current*: LRC timestamps are human-authored and
routinely ±300 ms anyway, so a finer clock buys nothing real. For smooth *scrolling between* lines,
anchor on the last `timeupdate` and interpolate with rAF **inside the pane**, and stop the rAF loop
when the pane is hidden, when playback is paused, and on unmount. Asking the engine to tick faster
would be the wrong fix in the wrong layer.

Line lookup must be O(log n) or an advancing cursor, not a scan per frame — and it has to survive a
**seek backwards** and a scrub, which an advancing cursor gets wrong unless it resets. Honour
`LyricsDocument.offsetMs` from the parser here.

## Layout

`StageView.vue` (361 lines) is currently a blurred artwork wash, a centered `.stage-content` column
(art + caption), `WaveformRibbon`, and an absolutely-positioned `.stage-transport`. There is
already a `@media (max-height: 800px) and (min-width: 640px)` rule at line 239 that flips
`.stage-content` to a row — so a lyrics column beside the art is a layout the view is halfway to
expressing. Extend that rather than inventing a second responsive scheme.

Build it as a **panel island** under `src/renderer/panels/` (D4), not as markup inline in
StageView, so the Tunedeck can host it later without a rewrite. StageView is its first host, the
same way `UDrawer` was Tunedeck's first host.

## States the pane must render

Each of these is a distinct visual state, and skipping any one of them is what makes a lyrics pane
feel broken:

- **Synced** — active line highlighted, neighbours dimmed, autoscroll centered.
- **Plain (unsynced)** — scrollable text, no highlight, no autoscroll. Must not pretend to sync.
- **Instrumental** — LRCLIB reports this explicitly; say so rather than showing "not found".
- **Not found** — quiet, not an error.
- **Loading** — and it must not flash on every track change.
- **Operator is scrolling** — suspend autoscroll on manual scroll, with a "jump back to current"
  affordance. Autoscroll that fights the reader is worse than none.

Attribute the source (sidecar / embedded / LRCLIB) unobtrusively — it is what makes a wrong match
diagnosable, and W17-5's manual override needs somewhere to hang off.

## Theming

Token layer only — the M5 exit criterion is that swapping a theme touches zero component code.
StageView already uses `--stage-art-max`, `--waveform-ribbon-*`, and `text-highlighted` /
`text-muted` / `text-dimmed`; the active-line highlight should fall out of those rather than
introduce a hardcoded colour.

Visibility should be a toggle (a stage affordance, and an Interface setting is a one-line entry in
the W8 registry — `src/shared/settings/interface.ts`). Not everyone wants lyrics on the stage.

## Files

- `src/renderer/panels/LyricsPane.vue` + a `lyricsSync.ts` composable (the cursor/interpolation
  logic, testable without mounting).
- `src/renderer/views/StageView.vue` — host + the row-layout extension.
- `src/renderer/stores/lyrics.ts` — fetch on track change, cancel in-flight on rapid skipping.
- `src/shared/settings/interface.ts` — visibility toggle.

## Tests (`tests/renderer/`)

Cursor selection at boundaries; seek backwards resets correctly; scrub does not thrash; offset
applied; plain document never highlights; rAF loop stops on pause/hide/unmount (leak check); rapid
track changes do not race a stale response into the pane.

## Out of scope

No network (W17-4), no manual match or offset editing (W17-5), no karaoke word highlighting even if
`words` is populated — parse it, don't render it yet. No lyrics in TrackList or search.
