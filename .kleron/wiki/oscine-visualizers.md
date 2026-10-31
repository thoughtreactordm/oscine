---
title: Oscine — Stage Visualizers
created: '2026-10-31T16:27:50.708Z'
updated: '2026-10-31T16:27:50.708Z'
---
Design authority for **W23 — Stage Visualizers**, audio-reactive effects on the Now Playing
stage. The stream owns the **D35** block and risks **R16** and **R17**. Its anchor decision,
**D35 — A visualizer is a reader of the tap, never a node in the graph**, is stated below and
the follow-on decisions extend the block as `D35.n`. Read `[[fermata-design]]` for the
invariants and the frozen D1–D20, and `[[fermata-theme-token-layer]]` for the tokens this
stream consumes. Per the post-1.0 convention these decisions live here, not there.

Status: **settled 2026-10-31, carded as W23-1..15, not started.** The three questions the
draft left open were answered then and are recorded under *Settled questions*.

## What this is

A set of switchable, audio-reactive effects that take over the Now Playing stage background.
The operator turns them on from the stage and steps through them with next/previous (on the
stage, by keyboard or from the Command Palette). Every colour comes from the theme tokens.
With Reactive color on, those tokens already carry the cover art's hue, so the effects follow
the art with no extra machinery.

This picks up two existing threads rather than starting a new one. Design §11 lists
visualizers among the v1 *deferrals, not rejections*, so this stream takes up that deferral
and reopens no D-number. `[[prospective-ideas]]` § Visualizations is the operator's own
sketch, and both of its points are carried into D35.4: the effects replace the stage
background, and the cover and song details shrink to the upper-right corner. (The idea's
"synced to the MusicBrainz" is read as *synced to the music*: nothing here touches the
network.)

The stream is almost entirely renderer-side and mostly new files. It needs **no IPC, no
migration, no main-process code and no network**, and its only audio-layer change is
isolated in the last phase (D35.10). Everything the first phases need already exists:

- `AudioEngine.readWaveform()` (`src/renderer/audio/AudioEngine.ts:265`): 1024 mono
  time-domain samples, tapped after normalization and the transition fade but before master
  volume. Both paths implement it: `DecodedAudioEngine` taps `transitionGain` and
  `browserStreamingPlatform` taps `normalizationGain`. `GuardedAudioEngine` reads whichever
  path won admission, and the playback controller exposes it as `playback.readWaveform(into)`
  (`controller.ts:1782`).
- `spectrumModel.ts`: a Hann window, a radix-2 FFT, dB conversion, log-axis resampling and an
  attack/release smoother, all pure TS and unit-tested under Node.
- `WaveformRibbon.vue`: the canvas precedent. It reads `--ui-primary` out of the cascade and
  re-reads it on `onThemeChange`, sizes for `devicePixelRatio`, caps the draw rate with
  `FRAME_MS = 33`, honours reduced motion, and stops its loop once playback is paused and its
  shape has decayed.
- The reactive accent: `useReactiveAccent` feeds the cover-art seed into the primary ramp
  (`--oscine-color-primary-<step>`, aliased to `--ui-primary` via `bridge.css`), fading it
  over `FADE_MS = 320`.

## D35 — A visualizer is a reader of the tap, never a node in the graph

Effects get audio from **only** the engine's sample read, through `playback.readWaveform`,
the same call the ribbon makes. No effect, library or helper may name an `AnalyserNode`, build
an `AudioNode`, or connect to an `AudioContext`. That is the `AudioEngine` file header's rule
("a UI that had to reach past this line … would be naming an `AnalyserNode`") applied to a
whole stream: an R1 replacement engine, including a future native bit-perfect engine behind
`AudioEngine`, keeps every visualizer working as long as it implements `readWaveform`.

It follows that visualizers inherit the tap's semantics without exception: post-normalization,
pre-volume, whichever path won admission during a crossfade, and `false` (decay, don't snap)
when nothing is sounding. A visualizer that wants different semantics needs a decision, not a
workaround.

**Rejected: butterchurn** (the WebGL Milkdrop port). It wants an `AudioNode` to connect to,
which this decision forbids. Its preset corpus is mixed-licence. It is a large dependency. And
its look belongs to Milkdrop. See *Alternatives*.

## D35.1 — One host, many effects, a static registry

A single panel island, `VisualizerStage.vue` (in `src/renderer/panels/`), owns everything
with a lifecycle: the canvas, the frame loop, the analysis frame, the palette, the cover
texture (D35.11), the wash and the transitions (D35.12), and effect switching. An effect is a
plain module that draws and holds nothing else:

```ts
type VisualizerSurface = '2d' | 'webgl2'

interface VisualizerEffect {
  readonly id: string                 // stable; persisted in a setting
  readonly label: string              // shown on switch and in the palette
  readonly surface: VisualizerSurface
  readonly needs?: { cover?: boolean; stereo?: boolean }
  readonly emergence: 'overlay' | 'grow'   // D35.12
  readonly washUnder?: number              // D35.12; overlay only, default 1
  create(target: EffectTarget): EffectInstance
}

interface EffectInstance {
  resize(width: number, height: number): void   // backing-store pixels
  frame(audio: AnalysisFrame, palette: Palette, stage: StageInputs, dtSec: number): void
  dispose(): void
}

interface StageInputs {
  emergence: number          // 0 = the wash, 1 = the effect (D35.12)
  intensity: number          // the flash guard's multiplier (D35.8)
  wash: WashInput            // the rendered wash, for 'grow' effects (D35.12)
  cover: CoverInput | null   // null unless needs.cover (D35.11)
}
```

`EffectTarget` carries the context for the effect's surface (`CanvasRenderingContext2D` or
`WebGL2RenderingContext`) plus the quality tier from D35.6. Effects never upload, decode or
delete the cover or the wash; the host owns both.

- **The registry is a static array** in `src/renderer/visualizer/registry.ts`, in display
  order. No runtime plugin loading and no operator-authored shaders or scripts. User effects
  would be a script-execution surface in the renderer, and that needs a decision of its own
  (see *Deferred*).
- **A canvas cannot change its context type**, so the host keys the `<canvas>` element on
  `surface`. Switching between a 2D and a WebGL2 effect therefore replaces the element, while
  switching between two effects on the same surface only re-creates the effect.
- **Switching passes through the wash** (D35.12): the outgoing effect settles back into the
  wash, the swap happens there, and the incoming effect grows out of it. Two effects never
  render at once, and because both tiers draw the same wash, replacing the canvas element
  for a 2D ↔ WebGL switch is invisible.
- **Effects are frame-rate independent.** All motion is driven by `dtSec` and the analysis
  frame, never by a frame count. `dtSec` is clamped to 0.1 s so a stall doesn't make an
  effect jump.

The pure parts are `@renderer`-free and DOM-free (the rule from the W19-4 note) and live in
`src/renderer/visualizer/`: the analysis model, the palette model, the flash guard and the
registry. Effects live in `src/renderer/visualizer/effects/` and the GL helpers in
`src/renderer/visualizer/gl/`.

## D35.2 — One analysis frame per rendered frame, allocation-free

The host polls `readWaveform` once per rendered frame and runs a pure model over the samples,
producing one `AnalysisFrame` that every effect reads:

```ts
interface AnalysisFrame {
  waveform: Float32Array      // 1024, −1..1, the raw tap
  spectrum: Float32Array      // BANDS (64), log-spaced 30 Hz–16 kHz, 0..1, smoothed
  bass: number                // 0..1, smoothed band energies
  mid: number
  treble: number
  level: number               // 0..1, smoothed RMS
  onset: number               // 0..1 strength this frame; 0 when no onset
  silent: boolean             // readWaveform returned false, or level under the floor
  timeSec: number             // seconds since the effect was created
}
```

- **Allocation-free.** `spectrumModel` allocates new typed arrays on every call, which is fine
  for the EQ pane but means GC jank at 60 fps across a whole stage. W23-1 adds `…Into`
  variants that write into caller-owned scratch buffers, and the existing functions become thin
  wrappers so the EQ pane is untouched. The frame model allocates once, at construction.
- **Normalised for display.** dB values are mapped onto 0..1 between the existing
  `SPECTRUM_FLOOR_DB`/`SPECTRUM_CEIL_DB`, then passed through a slow automatic gain (a time
  constant of seconds, not frames) so a quiet master still moves the picture and a loud one
  doesn't pin it. ReplayGain already sits ahead of the tap. The auto-gain only exists to keep
  the picture lively, and is not loudness processing.
- **Onsets** come from spectral flux over the 64 bands (the sum of positive band rises),
  compared against a mean of the last ~1 s times a constant plus a floor, with a 100 ms
  refractory window. A second poll inside one render quantum returns the same window and so
  reads as zero flux: correct, with no special case.
- **No tempo tracking.** BPM estimation is real DSP work that no first-phase effect needs
  (see *Deferred*).
- **Decay, don't snap.** When `readWaveform` returns false, the frame leaves `waveform`
  untouched, the smoothed values decay towards the floor, and `silent` is set only once
  they've settled. That is the ribbon's `relax()` behaviour, lifted into the shared model.

## D35.3 — Colour comes from the resolved token ramp, not a second extractor

The palette is read out of the cascade: `getComputedStyle` on the host canvas, the
`WaveformRibbon` precedent. It is re-read on `onThemeChange`. It holds:

- the primary ramp, `--oscine-color-primary-<step>`, every step;
- `--ui-primary` (the theme's accent step);
- the surface and text tokens (`--ui-bg`, `--ui-bg-elevated`, `--ui-text-highlighted`,
  `--ui-text-muted`).

These are stored as CSS strings for 2D effects and as linear RGB triplets in a `Float32Array`
for shader uniforms.

**Reactive color is free.** With `theme.reactive` on, the cover-art seed already reshapes the
primary ramp, so a palette built from the ramp follows the art. The visualizer neither reads
`theme.reactive` nor has a mode of its own for it. An accent the operator set in the token
editor still wins, because it wins in the ramp.

**The host lerps the palette itself**, in OKLab, over ~600 ms. Effects therefore see
continuous colour whether a theme change arrives as one step (switching themes) or as a stream
(the 320 ms accent fade). Effects never interpolate colour on their own.

**Effects never hard-code a hue.** Every colour an effect draws is a function of palette
entries (a mix, a lightness shift, an alpha). That is M5's criterion ("swapping a theme
touches zero component code") applied to shader constants. Pure black or white used for
vignettes and additive blending count as `--ui-bg` and `--ui-text-highlighted` respectively.
Code review enforces this; no lint rule can see inside a GLSL string.

**The cover itself is the richest colour source.** Effects that want more than one hue get
it from the cover texture or its swatches (D35.11), not from a second extractor feeding the
palette. The palette stays the theme's; the cover is a separate input.

## D35.4 — Visualizer mode reshapes the stage; legibility never depends on the effect

With the visualizer on, the stage changes in three ways, as `[[prospective-ideas]]` sketched:

1. **The visualizer takes over the wash.** `VisualizerStage` mounts in the wash slot (the
   first child of the stage `<section>`, `absolute inset-0`, behind `.stage-body`), draws the
   wash itself, and the blurred cover `<img>` is dropped only once the canvas is showing an
   identical frame: the handoff in D35.12. No new z-index is introduced: the existing order
   (wash → body → transport at 10 → stage toggles at 20) holds as is.
2. **The cover cluster moves to the upper-left corner.** The art drops from `--stage-art-max`
   to a compact size and the caption sits beside it, both on a scrim panel (the token layer's
   scrim / on-scrim pair). *Amended 2026-10-31 from upper-right:* with lyrics on, the record
   already sits on the left and lyrics on the right, so a right-hand corner swapped the two
   sides and read as jarring. The left corner keeps the record on its own side, and lyrics
   keep their column on the right. The panels are frosted (a backdrop blur under a lightened
   scrim) and feathered at every edge. *Amended 2026-10-31 (W23-5), replacing the FLIP move:*
   the layout changes by a plain fade-through of the stage body — out over one motion
   duration, switch while nothing shows, back in over another. A FLIP of the art with the
   caption and lyrics cross-fading as they travel was built and rejected by the operator: the
   flight read as gimmicky and the scrim panels lingered. Only `opacity` animates; layout
   properties are never animated per frame. The scrim is
   the legibility guarantee: text contrast is a property of the theme, never of whatever the
   effect drew under it. In the High Contrast theme the scrim is opaque.
3. **The waveform ribbon is suppressed** while an effect is running, without changing
   `interface.nowPlayingWaveform`. Two visualizers competing at the bottom of one stage
   is noise, and the operator's ribbon preference comes back when the visualizer goes off.

The transport (Zen or `interface.nowPlayingStageTransport`) is unchanged. It already floats
over the stage at `z-index: 10`, and visualizer mode reuses the immersive bottom padding.

The visualizer toggle sits beside the lyrics toggle in the stage's top-right control group,
with the same hover/focus fade and the same `LYRICS_MIN_STAGE_WIDTH`-style width gate.

**Lyrics stay.** Turning the visualizer on never hides lyrics the operator asked for. With
both on, the cover cluster goes to the corner as above, and `LyricsPane` keeps its column on
the right,
sitting on its own darkened scrim panel (the same scrim pair as the cluster), so the lyric
lines' contrast never depends on the effect either. The panel is part of the stage layout;
`LyricsPane` itself is unchanged.

## D35.5 — Controls and settings

Five descriptors join `src/shared/settings/interface.ts`, after the ribbon's (`order: 110`):

| Key | Type / values | Default | Portable | Why |
|---|---|---|---|---|
| `interface.nowPlayingVisualizer` | boolean | `false` | yes | the stage toggle writes it, like `interface.nowPlayingLyrics` |
| `interface.visualizerInZen` | boolean | `false` | yes | Zen turns the visualizer on regardless of the stage toggle |
| `interface.visualizerEffect` | effect `id` string | first registry entry | yes | what is showing |
| `interface.visualizerCycle` | `'off' \| 'track' \| 'shuffle'` | `'off'` | yes | advance on track change, in order or at random |
| `interface.visualizerQuality` | `'auto' \| 'low' \| 'high'` | `'auto'` | **no** | the GPU belongs to the machine (D35.6) |

- **Zen is an override, not a write.** With `interface.visualizerInZen` on, the visualizer is
  showing whenever `zen.active` is true: entering Zen grows it in (D35.12), and leaving Zen
  returns the stage to whatever `interface.nowPlayingVisualizer` says. Zen never writes the
  stage toggle, the same way it overrides the title bar and tab row without touching their
  settings (`zen.ts`). Toggling the visualizer *while in Zen* is a session-only override that
  ends with Zen. Default off, so Zen's existing behaviour doesn't change by surprise.
- **An unknown effect id is kept, not rewritten.** The validator accepts any non-empty
  string. The host resolves an id missing from the registry to the first available effect *at
  runtime* and leaves the stored value alone, so switching to a branch with fewer effects
  doesn't destroy the operator's choice. That is W8's rule that unknown keys survive, applied
  to unknown values.
- **Next/previous** step through the *available* effects (D35.6 can make some unavailable),
  wrap at the ends, and write `interface.visualizerEffect`. On every switch the effect's
  `label` shows briefly on the stage as a small caption on the scrim, so stepping through is
  navigable without opening anything.
- **Keyboard**: three entries in the fixed `SHORTCUTS` table (`globalShortcuts.ts`), each a
  new `ShortcutAction` variant `{ kind: 'visualizer', action: 'toggle' | 'next' | 'prev' }`
  plus a `dispatch` case. They are only meaningful on the stage, and do nothing elsewhere. The
  chords are proposed in W23-6 and checked against the existing table and the Help modal.
  Editable targets are already excluded by the table.
- **Command Palette**: "Toggle visualizer", "Next visualizer", and one entry per effect
  ("Visualizer: Drift"), through W13's existing command surface.

## D35.6 — Canvas 2D is the floor, WebGL2 is a tier that must prove itself

- **2D effects always work.** The default effect is 2D, and with no GPU at all the visualizer
  still has something to show.
- **WebGL2 is raw.** No three.js, regl or twgl. The tier needs one full-screen triangle, a
  ping-pong pair of framebuffers, a texture from an `ImageBitmap` and program compilation that
  surfaces errors, which is a few hundred lines in `visualizer/gl/`. It is not worth a
  dependency or a licence entry in the Open Source modal.
- **Capability is probed once per session**, in the renderer, by creating a throwaway context
  with `failIfMajorPerformanceCaveat: true`. That flag is how Chromium refuses a context
  backed by software rendering (SwiftShader on a blocklisted GPU), so the probe needs no IPC
  and no `app.getGPUFeatureStatus()`. If it fails, every `surface: 'webgl2'` effect is
  **unavailable**: it is left out of next/previous, the cycle and the palette, and a stored
  WebGL `visualizerEffect` falls back at runtime without being rewritten (D35.5).
- **A shader that fails to compile** marks only that effect unavailable for the session and
  logs once. It is never a broken stage.
- **Context loss is expected, not exceptional.** On `webglcontextlost` the host calls
  `preventDefault()`, shows the first 2D effect, and tries to return to the WebGL effect on
  `webglcontextrestored`. Two losses in a session mark the tier unavailable until restart.
- **Resolution is budgeted, not native.** WebGL effects render to an internal target capped at
  about 2.1 MP (1920×1080) and are scaled up to the canvas. Zen on a 4K panel therefore costs
  what 1080p costs, and the softness suits feedback effects. `quality` adjusts this: `low`
  means a 1 MP cap and 30 fps, `high` means native resolution and 60 fps, and `auto` means the
  2.1 MP cap at 60 fps, dropping to `low` behaviour once a rolling frame-time average stays
  over budget for two seconds. 2D effects render at `devicePixelRatio`, with a frame cap
  shared with the ribbon's `FRAME_MS` approach.

## D35.7 — It costs nothing when nobody is watching

The host's loop runs **only while all of the following hold**: the setting is on, the stage
is mounted, `document.hidden` is false, reduced motion is not requested, and either playback
is playing or the analysis frame is still decaying.

- `StageView` is not kept alive (there is no `KeepAlive` in the renderer), so leaving the tab
  unmounts the host. `dispose()` runs and GL resources are deleted rather than left for GC.
- Unlike the ribbon, the host listens to `visibilitychange`. A minimised Zen window on a
  secondary monitor shouldn't spin a GPU.
- **Reduced motion turns the visualizer off**, which matches the ribbon. The toggle stays
  visible but disabled, and its tooltip says why. A static "visualizer" is just a background
  image, and the wash already is one.
- **Pausing settles into the wash** (D35.12). The analysis decays to rest (D35.2), the
  emergence eases to 0, and the loop stops holding the wash frame. A paused stage looks like
  the ordinary stage, and costs what it does. It never clears to black.
- The per-frame loop allocates nothing: no closures, arrays or strings built per frame. That
  is a review rule backed by the allocation-free analysis model.

## D35.8 — No effect may flash

Whatever the music does, the stage must not produce a full-field luminance flash faster than
three per second (the WCAG 2.3.1 general flash threshold), because an onset-driven brightness
pulse on a beat-heavy track does exactly that by default. **The flash guard is a pure model
in the host, not a convention in each effect:**

- effects receive `onset` and the band energies already shaped by an envelope with a minimum
  attack, so a pulse cannot go from rest to peak in one frame;
- the host samples the mean luminance of the rendered frame from a tiny downsample (an 8×8
  `readPixels` on WebGL every few frames, or a scaled `drawImage` on 2D) and, when the
  frame-to-frame change exceeds the threshold too often in a one-second window, damps a global
  intensity uniform the effect is required to multiply into its output.

The guard has its own unit tests against synthetic onset trains (an impulse at 8 Hz must not
produce more than three large luminance swings per second). That is **R17**'s mitigation, and
it ships with the first effect, not after the effects that need it most.

**The guard is always on.** There is no setting, flag or per-effect opt-out that disables it.
The threshold is a constant in the pure model, not a descriptor. An operator who wants more
punch picks a different effect; nobody can configure their way into a strobe.

## D35.9 — The effects are original

The first set is designed for this app, not reproduced from Windows Media Player, Milkdrop,
iTunes or anything else. That is a design stance as much as a legal one: the stage is
themeable, and these effects are built around the token ramp and the operator's own cover art,
which no 2004 visualizer had. Working names follow the songbird motif and can change:

| Effect | Surface | Emergence | What it does | Needs |
|---|---|---|---|---|
| **Bars** | 2D | overlay | mirrored log-spectrum bars with falling peak caps, rising from a centre line | — |
| **Halo** | 2D | overlay | a radial spectrum ringing a disc of the cover, pulsing on onsets | cover |
| **Trace** | 2D | overlay | the waveform as a slow-drifting ribbon with fading afterimages | — |
| **Drift** | WebGL2 | grow | a feedback field: each frame warps, zooms and rotates the last, bass drives zoom, the waveform is injected as a line. Seeded from the cover, so the image melts into the tunnel rather than one building out of black | cover |
| **Plumage** | WebGL2 | grow | the cover as a texture, displaced and kaleidoscoped by band energies, chromatic split on onsets | cover |
| **Rainfall** | WebGL2 | grow | a height-field ripple over the cover; each onset drops a ring, sized by its strength and placed by its dominant band | cover |
| **Groove** | WebGL2 | grow | a radial slit-scan: the cover smeared around its centre like a record turning under a light, smear length on level, rotation on bass | cover |
| **Murmuration** | WebGL2 | overlay | a few thousand instanced particles flocking on a flow field, scattering on onsets, each coloured from the cover pixel it was born over | cover |
| **Phase** | 2D | overlay | an X/Y (Lissajous) scope of left against right | stereo |

**Drift** is the effect that gives the old WMP feel, and it is the one that needs the GPU:
per-pixel feedback at full-stage size is exactly what 2D canvas cannot do at frame rate.
The cover effects (**Plumage**, **Rainfall**, **Groove**) are the ones only a
local-library player does well, since every track brings its own image. They are also the
`grow` effects, which is what makes D35.12 seamless rather than a crossfade: the cover on the
stage visibly starts to move.

**Mosaic was dropped (W23-7, 2026-10-31).** A 2D `grow` effect was to cut the cover into
tiles. Built twice — tiles lifting and tilting on their bands, then two-sided tiles flipping in
onset waves — it read as hokey both times, and the operator cut it. No 2D effect is `grow` now:
the host's `grow` path (W23-5) stays, and is first exercised by Drift (W23-9).

Effects that don't need the cover (`needs.cover` unset) don't get the texture, and with the
default `washUnder` they still sit on the wash, so the cover's colour field shows through
every overlay effect.

## D35.10 — The stereo tap is an engine change, and comes last

`readWaveform` is mono: `AnalyserNode` mixes its input down. Phase needs left and right
separately, which no existing tap provides. That means adding a capability to the engine
contract, so it is isolated in the last phase and not a prerequisite for anything else:

- An **optional** method beside `readWaveform`, on `AudioEngine`, `AudioPath` and
  `GuardedAudioEngine`: `readStereoWaveform?(left: WaveformBuffer, right: WaveformBuffer):
  boolean`. It carries the same tap point, the same "false means nothing audible, buffers
  untouched" rule and the same admission-path selection, with a mono source copied to both
  channels. It is optional so that an engine without it degrades (`stereo` effects become
  unavailable) instead of failing to typecheck.
- Each path builds a `ChannelSplitter` and two analysers **lazily**, only while a
  `needs.stereo` effect is showing, and removes them when it isn't. That follows
  `EqualizerRouter.subscribeClip`'s attach/detach precedent: two extra analysers on every
  track forever, for one effect, is not free.
- **Both paths ship in the same card**, the hard requirement W19 recorded: a stereo scope that
  works on decoded tracks and is silently flat on whatever R1 streamed is a bug report no one
  can reproduce.

## D35.11 — The cover is a texture, at the size the library already makes

The source is `playback.nowPlaying.artwork.large`, the same URL the stage's wash and cover
already show. An operator's artwork override (W16-9) is therefore what gets distorted, and the
visualizer has no cover-resolution logic of its own. The host decodes it once per track
(`fetch` → blob → `createImageBitmap`, the route `artworkAccent.readAccentSeed` uses, which is
off the main thread and yields an untainted bitmap WebGL accepts) and owns the result:

```ts
interface CoverInput {
  current: CoverSlot
  previous: CoverSlot | null   // present only while crossfading between tracks
  mix: number                  // 0 = previous, 1 = current
}

interface CoverSlot {
  bitmap: ImageBitmap          // 2D effects draw this
  texture: WebGLTexture | null // WebGL effects sample this; null on the 2D tier
  aspect: number               // width / height
  swatches: Float32Array       // 16 linear-RGB triplets from a 4×4 downsample
  synthetic: boolean           // true when generated from the palette (no cover)
}
```

- **640 px is the design size.** `large` is the 640-px tier (`artworkWorker.ts:11`). Every
  cover effect bends, blurs, tiles, mirrors or smears the image, and under those operations
  640 scaled to the stage is indistinguishable from more. Showing the cover *undistorted and
  sharp* at full stage size is out of scope. A larger tier is main-process work this stream
  doesn't do, and is deferred with a trigger.
- **Texture rules.** One helper in `visualizer/gl/` uploads every cover, so the rules can't
  drift between effects:
  - `SRGB8_ALPHA8` internal format, so sampling returns linear light and blends are correct.
  - Mipmaps generated at upload, sampled with `LINEAR_MIPMAP_LINEAR`. The mips double as the
    blur pyramid D35.12 uses.
  - `MIRRORED_REPEAT` wrapping, so kaleidoscope and tunnel sampling outside 0..1 has no seams.
  - One `UNPACK_FLIP_Y` convention.
  - Non-square covers are fitted with object-cover semantics using `aspect`.
- **Track changes crossfade inside the texture.** The host keeps two slots and drives `mix`
  over the palette lerp's ~600 ms (D35.3), so the cover and the colour change together. The
  previous cover stays on screen until the new one has decoded, and is `close()`d (and its
  texture deleted) once the crossfade completes. The cost is two 640² covers with mips, about
  4.5 MB of GPU memory at worst.
- **Context loss re-uploads.** The host keeps the current bitmap, so `webglcontextrestored`
  rebuilds textures without a refetch. An effect never holds the only copy.
- **No cover is still a cover.** When `hasArtwork()` reports the placeholder or the decode
  fails, the host synthesises a 256² stand-in from the palette (a soft field over the primary
  ramp, regenerated when the palette changes) and marks it `synthetic`. Cover effects keep
  running, and cycling doesn't skip effects track by track. Effects don't branch on
  `synthetic`; it exists for the wash (D35.12) and for diagnostics.
- **Swatches are the multi-hue palette.** Sixteen colours from a 4×4 downsample, computed once
  per cover by a pure function (unit-tested like `pickAccentSeed`). Murmuration colours its
  particles this way, and WebGL effects can equally sample a small mip. This replaces the
  "multi-hue palette from art" item that was deferred.

## D35.12 — The visualizer grows out of the wash and settles back into it

**The blurred wash is the visualizer's rest state.** Every transition passes through a frame
that looks like the ordinary stage, so there is never a cut: on, off, pause, effect switch,
2D ↔ WebGL swap and context loss. There are three parts.

**1. The host draws the wash itself, once per cover.** It reproduces `.stage-wash-img`:
object-cover fit, `scale(1.25)`, a Gaussian blur with σ = `--oscine-cover-blur` × 1.6 (CSS
`blur(r)` *is* σ = r), and `saturate(2.2)` using the Filter Effects spec's matrix. The result
is emitted with alpha = `--oscine-cover-bleed` × 1.1 onto a transparent, premultiplied canvas,
so it composites over the stage exactly as the `<img>` does without the host needing to know
what is underneath.

- **One source of truth.** The multipliers move out of the literal `calc()`s in
  `StageView.vue` and into four typed custom properties on the stage: `--stage-wash-blur`,
  `--stage-wash-saturate`, `--stage-wash-opacity` and `--stage-wash-scale`.
  `.stage-wash-img` consumes them and the host reads them on `onThemeChange`, so a token-editor
  change moves both washes together. They must be registered with `@property`: an
  unregistered custom property's computed value is the unresolved `calc(…)` string, not a
  length.
- **Cost.** The wash only changes with the cover or the theme, so it is rendered into a texture
  then and only blitted per frame.
  - On WebGL2: downsample through the mips to ⅛ size, where σ = 64 px becomes 8 texels, then
    run a separable Gaussian on a target of about 240×135, at roughly 25 taps × 2 passes.
  - On 2D: draw the cover into a small offscreen canvas with `ctx.filter` blur and saturate
    scaled to match, then upscale with smoothing. `ctx.filter` is only cheap on a small canvas,
    which is exactly where it is used.
  - The per-frame cost is one full-screen textured quad or `drawImage`.
- **Matched within tolerance, not bit-exact.** Blur kernels and the gamma of blending differ
  between CSS and the GPU. At about 20 % opacity over a 64-px blur the remainder is below what
  anyone can see, and the handoff absorbs it. W23-15 checks it by screenshot.

**2. The handoff between the CSS wash and the canvas wash.**

- **On:** the host mounts and renders the wash frame. Only once that frame is presented
  (the `requestAnimationFrame` after the first draw) does `StageView` fade the `<img>` out
  over 150 ms.
- **Off:** the reverse. Once the emergence reaches 0, the `<img>` is remounted and fades in
  over 150 ms beneath the canvas, then the canvas unmounts and the loop stops.
- **The CSS wash is the fallback that is always available.** On context loss it is restored
  instantly, because a lost context has already blanked the canvas, and the 2D path grows from
  it.
- **The CSS wash's own `filter` is never animated.** Only its `opacity` changes, which is a
  compositor-only property and costs nothing.

**3. Emergence.** The host eases `StageInputs.emergence` between 0 (the wash) and 1 (the
effect). Each effect declares how it uses it:

- **`overlay`** (abstract effects: Bars, Trace, Halo, Murmuration, Phase). The host draws the
  wash and then the effect over it, with the effect's output scaled by emergence. The effect
  does nothing special. `washUnder` (0..1, default 1) is how much wash stays under the effect
  at full emergence, so by default every overlay effect sits on the cover's colour field.
- **`grow`** (cover effects: Drift, Plumage, Rainfall, Groove). The effect receives
  `stage.wash` and must produce the wash at emergence 0, with its displacement, feedback,
  tiling or smear scaling up from zero. Plumage at 0 is the blurred cover sitting still; at 1
  it is the full effect. This is the seamless case: the stage's own cover starts to move.

`grow` correctness can't be unit-tested, since it lives in shaders. A dev-only flag,
`VITE_VISUALIZER_HOLD_EMERGENCE`, freezes the emergence at a given value so W23-15 can compare
an effect at 0 with the CSS wash by screenshot, effect by effect.

| Event | What happens |
|---|---|
| Visualizer on | the stage body fades through to the corner layout (D35.4); handoff → emergence 0 → 1 over ~0.6 s |
| Visualizer off | the body fades through back to the centred layout; emergence 1 → 0 → handoff back → canvas unmounts, loop stops |
| Pause | analysis decays (D35.2); after 3 s paused, emergence eases to 0 over ~0.6 s and the loop stops on the wash frame. The layout does not move |
| Resume | loop restarts, emergence 0 → 1 |
| Effect switch, same surface | emergence → 0 over ~0.3 s, swap, → 1 |
| Effect switch, 2D ↔ WebGL | the same, with the canvas element replaced at emergence 0. Both tiers draw the same wash, so the swap is invisible |
| Track change | the cover crossfade (D35.11) runs inside the wash and the effect at once; emergence is untouched |
| Context loss | the CSS wash is restored instantly; the first 2D effect grows from it |
| No cover | the stage shows no wash today and neither does the host (the synthetic cover feeds effects, not the wash); emergence grows from the bare stage |

All durations are multiples of `--oscine-motion-duration`, so the motion tokens govern them,
with the defaults above. *Amended 2026-10-31 (W23-5):* the emergence is 4× (0.6 s) and the
switch 2× (0.3 s) rather than ~1.2 s and ~0.4 s — the operator found the longer ease sluggish. Reduced motion never reaches this table, because the visualizer is
off under it (D35.7).

## R16 — GPU and driver variance

**Medium, platform.** WebGL behaviour varies by GPU, driver and OS in ways no CI runner
exercises. Failure modes: a context that comes up as software rendering and crawls; a driver
that loses the context on suspend or a display change; a feedback shader that is fine on a
discrete GPU and drops frames on an integrated one at 4K in Zen; fans and battery drain on a
laptop. Mitigations ship with the mechanism: the `failIfMajorPerformanceCaveat` probe, the
resolution budget, `auto` quality backing off on frame time, context-loss recovery that falls
back to 2D, the idle stop, and compile failure as "unavailable" rather than broken. W23-15
exercises them on real hardware on both platforms, including a forced `--disable-gpu` run to
prove the fallback.

## R17 — Photosensitive flashing

**High, safety.** An audio-reactive visual on a beat-heavy track will strobe unless something
stops it, and a fullscreen strobe in Zen on a TV is a seizure risk, not a cosmetic one.
Failure modes: an effect that ignores the intensity uniform; a new effect that bypasses the
envelope; a palette change (a dark theme flipping to light) read as a flash; a cover effect's
chromatic split or ripple crest on a bright cover. `grow` effects are not exempt: emergence
and the guard's intensity are separate multipliers, and both apply. Mitigations: the
host-level flash guard (D35.8) with unit tests on synthetic onset trains; effects required to
multiply the guard's intensity into their output, checked in review and by the W23-15 strobe
check on every effect; and the palette lerp (D35.3) so a theme change is never a step.

## Alternatives

- **butterchurn / Milkdrop presets.** Rejected under D35: it needs an audio node, its presets
  are of mixed licence, and its look is someone else's.
- **three.js (or regl, twgl).** Rejected under D35.6: the tier needs a full-screen triangle and
  two framebuffers, not a scene graph.
- **A second artwork extractor feeding a 5-colour palette into the theme.** Rejected under
  D35.11: cover swatches and texture sampling give effects the cover's hues without changing
  what the palette means.
- **Animating the CSS wash (`filter: blur()`, `saturate()`) into the effect.** Rejected under
  D35.12: it re-rasterises a full-window blur every frame, and an effect can't continue from a
  CSS filter anyway. Only the wash's `opacity` is ever animated.
- **A plain cross-dissolve between the CSS wash and the effect.** Rejected under D35.12: it
  costs the same as the handoff and reads as a cut. `grow` effects starting *from* the wash is
  the point.
- **Running the effect over the stage as an overlay instead of replacing the wash.**
  Rejected: it fights the cover, the lyrics and the ribbon for the same pixels, and the
  operator's own sketch asks for the background.
- **An FFT from `AnalyserNode.getFloatFrequencyData`.** Rejected under D35: it means reaching
  past the engine interface, and `spectrumModel` already does the FFT in TS.
- **WebGPU.** Not now: WebGL2 is enough for every effect listed, and WebGPU in Electron on
  Linux is the less-trodden path. Revisit if an effect needs compute shaders.

## Deferred

- **A larger artwork tier.** Revisit when an effect needs to show the cover sharp and
  undistorted at full stage size. That is a new size in `artworkWorker.ts`, so it is
  main-process and cache work, outside this stream.
- **Tempo / beat-phase tracking.** Revisit when an effect wants to land on the beat rather
  than react to it.
- **Operator-authored effects** (user GLSL or scripts). This is script execution in the
  renderer and needs its own decision about sandboxing and sharing.
- **Timed cycling** ("change every N minutes"). `cycle` only advances on track changes.
- **A mini visualizer in the transport bar** or elsewhere off the stage.

## Does NOT

- Does NOT name an `AnalyserNode`, create an `AudioNode` or touch an `AudioContext` outside
  `src/renderer/audio/` (D35). Only D35.10 changes the engine contract.
- Does NOT add IPC, a migration, main-process code or a network request.
- Does NOT read `theme.reactive` or feed cover colours into the palette; reactive colour
  arrives through the ramp (D35.3), and cover hues reach effects only as the texture and its
  swatches (D35.11).
- Does NOT animate the CSS wash's `filter`, or any layout property, per frame (D35.4, D35.12).
- Does NOT add an artwork size tier; the cover is the existing 640-px `large` (D35.11).
- Does NOT hard-code a hue in an effect or a shader (D35.3).
- Does NOT run while hidden, paused-and-settled, unmounted or under reduced motion (D35.7).
- Does NOT bundle third-party presets or a rendering library (D35.6, D35.9).
- Does NOT change `interface.nowPlayingWaveform` when it suppresses the ribbon (D35.4).

## Settled questions

Answered by the operator on 2026-10-31, when the stream was carded.

1. **Lyrics and the visualizer together: both stay**, with the lyrics on a darkened scrim
   panel (D35.4). Making them mutually exclusive was rejected as a surprising interaction.
2. **Zen: yes, behind `interface.visualizerInZen`, default off** (D35.5). Zen is the
   TV/secondary-monitor mode where a visualizer is most at home, and the default keeps
   1.x Zen unchanged.
3. **The flash guard is always on** (D35.8). No setting disables it.

## Cards

Three phases, and the stream can stop after any of them and still ship, as with W17:

- **Phase 1** (W23-1..7) is a complete feature on the 2D tier: the host, the seamless wash
  transitions, controls, safety and idle discipline, and the 2D effects. (It first named a
  2D cover effect, Mosaic, as the proof of `grow`; Mosaic was dropped in W23-7 — see the
  note under D35.9 — so the first `grow` effect is Drift, W23-9.)
- **Phase 2** (W23-8..12) adds the GPU tier and the rest of the cover effects.
- **Phase 3** (W23-13..14) is the only phase that touches the audio layer.

| Card | Scope | Depends on |
|---|---|---|
| **W23-1** | Analysis frame model (D35.2): `…Into` FFT variants in `spectrumModel` with the EQ pane unchanged, 64 log bands, band energies, auto-gain, spectral-flux onsets, decay/silence. Tests: a 60 Hz sine lands in `bass`, an impulse train yields onsets at its rate and not more, results are identical at 30 and 60 fps, nothing is allocated per frame. | — |
| **W23-2** | Palette model and flash guard (D35.3, D35.8): token read, OKLab lerp, High Contrast behaviour; the pure luminance guard and onset envelope with synthetic-strobe tests. | — |
| **W23-3** | Cover input (D35.11), the tier-independent half: host decode of `artwork.large`, the two-slot crossfade and `close()` lifecycle, the pure swatch function and its tests, the palette-synthesised stand-in for no cover. | W23-2 |
| **W23-4** | `VisualizerStage` host and stage layout (D35.1, D35.4, D35.7): canvas keyed on surface, registry, lifecycle (idle, hidden, reduced motion, unmount disposal), the corner cluster on its scrim (moving without animation for now), the lyrics scrim panel, ribbon suppression, the stage toggle, the five settings and the Zen override. In this card the CSS wash simply stays underneath and the canvas is a transparent `overlay` layer that fades in with emergence. Ships with **Bars**. Also amends `fermata-design` §11 to record that visualizers left the deferral list, in the same note style as the three items already there. | W23-1, W23-2, W23-3 |
| **W23-5** | Wash and transitions (D35.12), on the 2D tier: the four `@property` wash properties shared with `.stage-wash-img`, the 2D wash pass, the CSS ↔ canvas handoff, `overlay`/`grow` emergence and `washUnder`, every row of the transitions table including pause-settles-to-wash, the fade-through layout change (amended from a FLIP move), and the `VITE_VISUALIZER_HOLD_EMERGENCE` flag. | W23-4 |
| **W23-6** | Controls (D35.5): next/previous, the label caption, cycle on track change, the `SHORTCUTS` entries and dispatch, Command Palette commands, unknown-id fallback. | W23-4 |
| **W23-7** | **Halo** and **Trace** (2D). Mosaic was in scope and was dropped (see D35.9). | W23-5 |
| **W23-8** | WebGL2 tier (D35.6, plus the GPU halves of D35.11 and D35.12): the capability probe, `visualizer/gl/` helpers, the cover upload helper and its texture rules, re-upload on context restore, the GPU wash pass matched to the 2D one, compile-failure handling, context loss with the CSS wash restored instantly, the resolution budget and `quality` tiers with the `auto` frame-time backoff, effects excluded when unavailable. | W23-5 |
| **W23-9** | **Drift**, seeded from the cover. | W23-8 |
| **W23-10** | **Plumage**. | W23-8 |
| **W23-11** | **Rainfall** and **Groove**. | W23-8 |
| **W23-12** | **Murmuration**, coloured from the cover swatches. | W23-8 |
| **W23-13** | Stereo tap (D35.10): optional `readStereoWaveform` on `AudioEngine` / `AudioPath` / `GuardedAudioEngine`, lazy splitter and analysers on **both** the decoded and streaming paths in this card, mono duplication, tests for the attach/detach lifecycle. | — |
| **W23-14** | **Phase** (X/Y scope). | W23-13, W23-4 |
| **W23-15** | Viewing verification on Windows and Linux: Zen at 4K, an integrated GPU, a forced `--disable-gpu` fallback, context loss via suspend/resume, reduced motion, High Contrast, every effect against a strobe-heavy track, every `grow` effect held at emergence 0 against the CSS wash by screenshot, the on/off/pause/switch transitions by eye, and recorded frame times per effect and quality tier. Anything it flags is a triage card, not a fix folded into the run. | W23-7, W23-9..12 |
