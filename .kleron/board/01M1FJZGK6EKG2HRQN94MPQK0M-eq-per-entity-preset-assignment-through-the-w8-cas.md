---
taskId: 01M1FJZGK6EKG2HRQN94MPQK0M
title: 'EQ: per-entity preset assignment through the W8 cascade'
status: backlog
priority: low
labels:
  - eq
  - settings
  - cascade
  - deferrable
workstream: W19
workstreamId: W19-6
dependsOn:
  - 01M1FJWETAJMAMQ5VE07A2J9QP
  - 01M1FJXM0N7Q7RQV88PQ3CHV03
order: 30
created: '2026-09-01T22:56:00.613Z'
updated: '2026-09-01T22:56:00.613Z'
---
## Intent

The second half of the `prospective-ideas` line this stream promotes: "Assign Genres, Artists,
Albums, or Playlists to EQ presets and they will automatically adapt to use their assigned profile."
A preset bound to an album applies itself when a track from that album plays.

## This card is deliberately last and deliberately deferrable

W19-1..5 are a complete, useful equalizer. This one turns a manual tool into an automatic one, which
is a real difference and not a blocking one. **Be willing to cut it from a first release** —
recorded here so cutting it is a decision rather than an omission. W19-3's stable preset ids are
what keep the option open at no cost.

## Nearly free, because W8 already built it

The settings cascade resolves most-specific-first — entity row, then global row, then descriptor
default — over scope kinds `global | track | album | artist | playlist | podcast`. So the whole
feature is one cascading key:

- `audio.eq.presetId` — nullable string, `cascade: ['track', 'album', 'artist', 'playlist']`

No migration, no new resolution logic, no second lookup path. Assignment is `settings.set` with an
`entityKind` and `entityId`, which the existing per-entity override UI already does for
`audio.crossfadeMs`.

## Genre is the one that does not fit, and that is a decision

The idea line names genres, but a genre is not a settings scope kind — `track_genres` (W10) is a
normalized many-to-many, so a track can carry three genres and three conflicting assignments with no
principled tiebreak. Adding `genre` to the cascade would put an ambiguous resolution into the one
mechanism in the app that is currently unambiguous.

**Ship the four unambiguous scopes.** If genre assignment is still wanted afterwards it is its own
card with its own tiebreak rule stated up front — most-specific genre, or first by
`track_genres.position`, or an explicit operator-ordered precedence list — and it should not be
smuggled in as an implementation detail here.

## Resolution at play time

`audioPreferences.ts` grows a computed that resolves `audio.eq.presetId` for the current track and
maps it to a spec from `audio.eq.presets`; the existing W19-3 watcher pushes it. Four behaviours to
get right:

- **A dangling id resolves to no preset**, not to an error and not to silence. Deleting a preset
  that albums reference must leave those albums playing flat, and the pane should be able to say
  which assignments are dangling.
- **Manual edits win for the session.** An operator who drags a band while an assigned album plays
  is not overridden at the next track boundary — they are told the assignment is suspended, with a
  one-click resume. Being fought by your own settings is the failure mode this feature invites.
- **Switch at the track boundary, not mid-track**, and ramp. W19-1's parameter ramping makes the
  change smooth, but a wholesale spec swap during a crossfade is audible on both tracks at once;
  apply it when the new track becomes current.
- Assignment respects `audio.eq.enabled`. A disabled EQ stays disabled; an assignment is not a way
  to turn the feature on behind the operator's back.

## Surface

Reuse the existing per-entity override affordance rather than building a second one — this is
exactly the shape `ScopedSettingRow` and the settings popover already handle. Add "EQ preset" to the
album, artist and playlist context menus (W14's G8 pass established the pattern for track rows and
album/artist cards), and list every assignment in the EQ pane so they are discoverable and revocable
from one place. An invisible assignment is a haunted app.

## Files

- `src/shared/settings/audio.ts` — the cascading descriptor
- `src/renderer/playback/audioPreferences.ts` — resolution and the suspend rule
- `src/renderer/panels/tools/EqualizerTool.vue` — the assignments list
- `src/renderer/panels/trackMenu.ts` / the album and artist menus — the assign entry

## Tests

- Cascade order: a track override beats album beats artist beats playlist beats global.
- A dangling preset id resolves to no preset and is reported, with playback unaffected.
- A manual edit suspends the assignment for the session and resumes on request.
- The spec changes at a track boundary, not mid-track — assert the push count and timing against a
  fake.
- `audio.eq.enabled: false` suppresses assignment entirely.
- Deleting a preset that has assignments does not delete the assignments (they dangle visibly) and
  does not corrupt the key.
- Reassigning by renaming a preset is impossible — assert the reference is by id.

## Out of scope

No genre scope (above). No automatic preset *generation* from anything. No headphone-profile
database. No conditional rules beyond entity scope — "loud at night" is a different feature and a
worse one.
