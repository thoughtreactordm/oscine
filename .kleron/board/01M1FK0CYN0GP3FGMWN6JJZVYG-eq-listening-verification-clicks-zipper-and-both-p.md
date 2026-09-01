---
taskId: 01M1FK0CYN0GP3FGMWN6JJZVYG
title: 'EQ: listening verification — clicks, zipper, and both playback paths'
status: triage
priority: high
labels:
  - eq
  - human-verify
  - audio
  - R11
triageKind: human-verify
workstream: W19
workstreamId: W19-7
dependsOn:
  - 01M1FJXM0N7Q7RQV88PQ3CHV03
  - 01M1FJYKECE08QTX8M1E7PSDA3
order: 0
created: '2026-09-01T22:56:29.652Z'
updated: '2026-09-01T22:56:29.652Z'
---
## Why this exists as a human card

Every defect this stream is most likely to ship is one that CI cannot detect, because CI cannot
hear. The unit tests assert that `setTargetAtTime` was called and that the graph has the right
shape; whether the result zippers, clicks or crunches is a question for ears. Two of the three
hardest problems in the stream — parameter zipper noise and clip behaviour — are audible-only, and
the third (the streaming path) is a wiring mistake that produces no error, just an EQ that quietly
does nothing.

Run this on both platforms. Do not close it on a partial matrix, and do not fold fixes into it —
anything that fails becomes its own triage card.

## Checks

| # | Check | What it is really testing |
|---|---|---|
| 1 | Drag a band's gain slowly across its full range while music plays | Zipper noise. Must be smooth; any granular fizz means a parameter is being assigned rather than ramped |
| 2 | Drag frequency fast, edge to edge, repeatedly | Same, on the parameter most likely to have been left un-ramped |
| 3 | Sweep Q from minimum to maximum on a boosted band | The parameter with the widest ratio, so the worst ramping case |
| 4 | Toggle the master enable repeatedly while playing | Click-free A/B. A tick on either transition means the dry/wet ramp is wrong or bypass is reconnecting nodes |
| 5 | Add and remove bands during playback, up to the 12-band limit and back | The fixed-pool claim. Any click here means the graph is being rebuilt under audio |
| 6 | Change a band's filter type mid-playback | The one transient that is expected — confirm it is a click and not a dropout or a silence |
| 7 | **Play a track long enough for R1 to send it to the `<audio>` path and confirm the EQ still applies** | The wiring mistake with no error message. Verify against `admission` in the dev tools rather than by guessing which track qualified |
| 8 | Crossfade between two tracks with a strong curve set | Post-mix placement. The EQ must apply once, evenly, to both — not twice, and not differently to each |
| 9 | A gapless album boundary with a strong curve set | Nothing rebuilds at the boundary; no click, no momentary flat |
| 10 | Boost 6 dB on a loud master with preamp at 0 | R11. The clip light must fire, and the crunch must be audible — confirming the indicator is telling the truth |
| 11 | Press Auto preamp, replay the same passage | Clipping gone, light quiet, level sensible rather than buried |
| 12 | Set a curve, quit, relaunch | Persistence, including across a cold start where settings load before the window |
| 13 | Switch output device (W8) with the EQ engaged | The new context gets the current spec. `AudioOutputRouter` and `EqualizerRouter` must not fight |
| 14 | Open the pane, play, close the pane, leave it playing 10 minutes | No leaked rAF poll and no analyser left attached — check CPU and the process metrics, not just the ears |
| 15 | Swap themes with the pane open | M5's criterion: curve, gridlines and disabled bands all re-colour with no component change |
| 16 | Drive the whole surface with the keyboard only | The band table and handle nudging are the accessible path; confirm they actually are |

## Reference material

Use programme material that exposes each problem rather than whatever is to hand: a sustained pure
tone or sine sweep for checks 1–3 (zipper is inaudible on a busy mix and obvious on a tone), a
kick-heavy loud master for 10–11, a gapless live album for 9, and a long file — over R1's per-track
cap, default 250 MB decoded — for 7.

## Reporting

Record platform, output device and whether the decoded or streaming path was active for each
audible finding; "the EQ clicks" is untriageable when the two paths are separate implementations of
the same connection.

## Blocked on

W19-4 and W19-5 landing. This is the gate that says the stream is shippable.
