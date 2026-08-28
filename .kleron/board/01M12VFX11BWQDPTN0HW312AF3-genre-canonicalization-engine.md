---
taskId: 01M12VFX11BWQDPTN0HW312AF3
title: Genre canonicalization engine
status: todo
priority: medium
labels:
  - phase-2
  - main
  - normalization
workstream: W16
workstreamId: W16-5
dependsOn:
  - 01M12VEX19HRHTZDD2BQWT1Q0C
order: 4
created: '2026-08-28T00:14:38.624Z'
updated: '2026-08-28T00:14:38.624Z'
---
Design authority: wiki `oscine-tag-writeback` → "Genre canonicalization engine". Directly targets the operator's stated pain: bulk junk genres, not one-off typos.

A library-wide mapping/alias table collapsing variants to a canonical label — e.g. `'hiphop'`, `'Hip-Hop/Rap'`, `'Rap'` → `'Hip-Hop'` — matched on the **same casefold key `track_genres` already uses** (W10), so it unifies with W15's chip surface instead of inventing a second taxonomy.

**Boundary (settled):** this lives in **W16, not W15** — normalizing and flushing are one operator action ("clean it, then commit it to source"), and the canonicalized value is an input to the W16-1 diff. W15 owns the free-form user vocabulary; W16 owns the rules that collapse it and the flush that persists the result.

**Schema (migration 017, with W16-1):** a `genre_aliases` table mapping a casefolded alias → canonical label. Start **global**; add an `enabled`/scope column only if per-root rules prove necessary. Finalise the shape against the casefold-key contract.

Acceptance: applying the ruleset over a library collapses aliased genres to their canonical label on the shared casefold key, and the result flows into the W16-1 diff as a pending genre write.
