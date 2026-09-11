---
taskId: 01M28SE04CRPRVTV15AWEZQ4Q2
title: 'Presence: settings descriptors, generated UI, and the onboarding network step'
status: in-review
priority: medium
labels:
  - discord
  - settings
  - onboarding
workstream: W20
workstreamId: W20-3
order: 1
created: '2026-09-11T17:49:47.531Z'
updated: '2026-09-11T20:45:59.114Z'
---
## Intent

The operator-control surface: the `discord.*` keys as declarative descriptors so the settings UI
generates itself (W8's whole point — adding a setting is a one-line entry, not UI work), plus a
mention in the onboarding Network step. No client, no mapping, no cover lookup — this card defines
*what the operator can set*; W20-3 reads these keys and W20-5 honours the album-art one.

## The keys

In `src/shared/settings/` (find the file the other `category: 'network'` keys live in — the
scrobble/consent keys are the model; verify the exact module before adding). All `category:
'network'`, `portable: false` (privacy-sensitive and machine-specific — they must not ride D11's
export bundle):

- `discord.enabled` — boolean, **default `false`**. Master toggle. Everything else is inert when
  this is off, and the W20-1 emitter is gated on it.
- `discord.display` — select: `title-artist` / `title-only` / `generic` (rendered "Listening to
  music"). The privacy dial over how much identifying detail is broadcast. Default `title-artist`.
- `discord.showAlbumArt` — boolean, **default `false`**, **D14-gated**. Disabled/annotated when
  `network.externalLookups` consent is off, exactly as other network-dependent settings present
  themselves; help text must state it performs an **online cover lookup** so the network cost is not
  a surprise. See `[[oscine-discord-presence]]`.
- `discord.showTimestamp` — boolean, default `true`. The elapsed/remaining progress bar.
- `discord.whenPaused` — select: `hide` / `paused` ("show Paused"). Default `hide`.

Each descriptor carries its `type`, `default`, `label`, `help`, control hint and search keywords like
every other key, so it is searchable and self-rendering. Do not hand-build a Discord settings panel —
if it needs custom layout beyond what the generator gives, that is a signal to fix the generator, not
to special-case this group.

## D14 gating of `showAlbumArt`

Reuse whatever mechanism existing network-dependent settings use to disable/annotate against
`network.externalLookups` — do **not** invent a second gating path. The toggle being *on* while
consent is *off* must resolve to "no cover lookup" at the point of use (W20-5 re-checks consent live
regardless), but the UI should make the dependency visible rather than letting the operator flip a
toggle that silently does nothing.

## Onboarding

`[[oscine-onboarding]]` conditionally shows a Network step alongside scrobbling. Add a line offering
Discord presence there — it is another opt-in third-party disclosure and belongs in the same place
the operator first meets the network-facing choices. Keep it a mention that flips `discord.enabled`,
not a second onboarding flow.

## Files

- `src/shared/settings/<network module>.ts` — the five descriptors.
- The onboarding Network step component under `src/renderer/` — one entry.

## Tests

Descriptors resolve with the stated defaults (`enabled`/`showAlbumArt`/`whenPaused` especially, since
a wrong default is a privacy regression); `showAlbumArt` presents as gated when consent is off;
`portable: false` holds so none of these appear in an export bundle; the select options match the
values W20-3's mapping switches on (guard against a value/label drift between this card and W20-3).

## Out of scope

No presence emission or mapping (W20-3). No Discord client (W20-2). No cover resolution (W20-5) —
this card only declares the toggle it hangs off.
