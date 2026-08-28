---
taskId: 01M12VF3AAEPVY8JQ0GCW2N3JG
title: Test corpus — mixed-format round-trip (D7 precondition)
status: done
priority: high
labels:
  - phase-1
  - test
  - gate
workstream: W16
workstreamId: W16-2
order: 9
created: '2026-08-28T00:14:12.297Z'
updated: '2026-08-28T19:48:16.296Z'
---
Design authority: wiki `oscine-tag-writeback` → "Test corpus — a precondition, not a nicety".

One of D7's two literal preconditions for write-back. Nothing in W16 flushes until this passes.

**Deliver:** a **synthesised** mixed-format fixture library with known-bad tags across all five v1 codecs (`flac | mp3 | vorbis | opus | aac`), embedded artwork, and at least one custom/arbitrary frame — plus round-trip **write → read → verify** tests exercising the W16-2 engine.

**Discipline (matches existing fixtures):** generated, not scavenged, like `probe:fixture` / `seed:synthetic`, so Windows and Linux measure the same thing. Add a script alias in the same family. No platform-conditional fixtures.

**Gate philosophy (matches M1/M2 gates):** this is a gate — anything it flags becomes a triage card, never a quiet fix folded into the flush path.

Acceptance: the fixture builds identically on both platforms; round-trip verification is green for every codec + artwork + a custom frame.
