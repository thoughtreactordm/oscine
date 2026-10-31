---
taskId: 01M69EYD5286ZNY5WBNJ19DCMD
title: 'Cover input — decode, two-slot crossfade, swatches, synthetic stand-in'
status: todo
priority: medium
labels:
  - D35.11
  - renderer
workstream: W23
workstreamId: W23-3
dependsOn:
  - 01M69EY3K1GXF65DKYVS3ZJY7J
order: 2
created: '2026-10-31T17:08:32.545Z'
updated: '2026-10-31T17:37:34.521Z'
---
Spec: wiki `oscine-visualizers` → D35.11.

The tier-independent half of the cover-as-texture decision. W23-8 adds the WebGL upload helper on top; this card owns everything a 2D effect needs.

- **Source:** `playback.nowPlaying.artwork.large`, the 640-px tier (`artworkWorker.ts:11`) and the same URL the stage already shows, so W16-9 artwork overrides apply with no logic here. No new size tier.
- **Decode once per track:** `fetch` → blob → `createImageBitmap`, the route `artworkAccent.readAccentSeed` uses (off the main thread, and untainted for later WebGL upload). A decode that loses a race to the next track is discarded.
- **`CoverInput` / `CoverSlot`** exactly as specified in D35.11: `current`, `previous` (only while crossfading), `mix`, and per slot `bitmap`, `texture` (always `null` in this card), `aspect`, `swatches` and `synthetic`.
- **Two-slot crossfade:** `mix` runs over the palette lerp's ~600 ms. The previous cover stays until the new one has decoded, and is `close()`d once the crossfade completes. Never more than two bitmaps live.
- **Swatches:** a pure function, 4×4 downsample → 16 linear-RGB triplets, unit-tested like `pickAccentSeed`. The host computes them once per cover.
- **No cover:** `hasArtwork()` false or a failed decode → a 256² stand-in synthesised from the palette (a soft field over the primary ramp, regenerated on palette change), marked `synthetic: true`. Effects don't branch on it.

The pure parts (swatches, the stand-in's field function, the crossfade state machine) are `@renderer`-free and DOM-free. The decoding glue is thin and lives with the host.

**Tests:** swatches of a synthetic two-colour image find both colours; the crossfade state machine handles A→B, A→B→C mid-fade (B is dropped and closed) and A→none; `close()` is called exactly once per bitmap; a rejected decode yields the synthetic stand-in.

**Done when:** the host can hand any `needs.cover` effect a correct `CoverInput` on every frame through track changes, missing art and decode failures.
