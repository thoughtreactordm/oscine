---
taskId: 01KZ40S3HZGRXD8F0ZXJ3G00WE
title: 'Wire the listen commit to the outbox, and now-playing to transport-commit'
status: done
priority: high
labels:
  - main
  - playback
  - D19
workstream: W11
workstreamId: W11-5
dependsOn:
  - 01KZ40RQ6VF1EAZVWCJYTEGJAN
order: 2
created: '2026-08-03T14:34:53.886Z'
updated: '2026-08-04T15:06:58.839Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → The listen event → "What else the commit does".

Fills the seam W10-4 deliberately left open. Small card, two connections, and the correctness of both is what makes Fermata's stats and the operator's Last.fm profile agree.

**1. Enqueue on listen commit.** In the *same transaction* as the `listens` insert, write one `scrobble_queue` row per connected target. Same transaction, not after it: a listen that recorded but did not enqueue is a scrobble silently lost, and a rollback must take both.

**A track with no artist name is never enqueued** — Last.fm rejects a scrobble missing artist or title. It still gets its `listens` row, because Fermata's own stats have no such requirement, and silently dropping it would put the two records permanently out of step for no reason the operator could see. Where the two legitimately diverge, it should be by a written rule.

**2. Now-playing at transport-commit.** `nowPlaying` fires when the transport commits to a track — the same moment `play_history` gets its row — not at departure. Fire-and-forget, no queue, no retry.

**Both are no-ops with no account connected**, and that path needs a test of its own: the overwhelmingly common case is an operator who has never signed in, and W10's entire surface must work identically for them.

**Tests:** listen-commit with one target connected enqueues one row with correct seconds-not-milliseconds `timestamp`; with none connected enqueues nothing and still writes the listen; a failed transaction leaves neither row; a track with a null artist writes the listen and no queue row; `nowPlaying` fires once per transport commit including on repeat-one, and never on a skip that had already fired it.
