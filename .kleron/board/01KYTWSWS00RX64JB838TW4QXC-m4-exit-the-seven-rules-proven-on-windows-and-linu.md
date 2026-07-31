---
taskId: 01KYTWSWS00RX64JB838TW4QXC
title: 'M4 exit: the seven rules, proven on Windows and Linux'
status: todo
priority: medium
labels:
  - M4
  - gate
workstream: W5
workstreamId: W5-8
dependsOn:
  - 01KYTWS0VXNMWQFQE9PC4X31CR
  - 01KYTWS86PVQZ4PVRNCZZFNE4V
  - 01KYTWSJ58G18FTT4B7292NFYW
  - 01KYTWRN9JPP4M8S15ZRAW94DP
  - 01KYW1WTNNSMQK3H0SYBHYGS1Q
order: 27
created: '2026-07-31T01:32:15.518Z'
updated: '2026-07-31T12:20:47.472Z'
---
## Scope

- `npm run probe:m4-exit`, in the shape the M2 gate established: self-contained, runs the
  ordinary repository gate first, launches the built app against a temporary user-data
  directory and a synthesised fixture library, writes `m4-exit-<platform>.md` to the OS
  temporary directory.
- The isolated database is a safety property, not a convenience — playlist creation and
  deletion must never touch the operator's library.
- The report enumerates the seven §5 rules **by number** with pass/fail, plus an m3u8 export
  round-tripped through a second player and a playlist of 10k entries scrolled and reordered.
- Nothing platform-conditional. A gate whose two platforms are measured differently is not a
  gate.

## Acceptance

- All seven rules pass, reported by rule number, from a clean commit on both platforms.
- Reports from the **same commit** on Windows and Linux attached to this card.
- `--skip-repo-gate --allow-dirty` exist only for developing the probe; a report carrying
  either condition is not milestone evidence.
- Anything the gate flags becomes a triage card. Fixes are never folded into the gate run.
- Document the command in the CLAUDE.md command table alongside the M1 and M2 gates.

## Notes

M4's exit criterion is stated in §5: each of the seven rules gets a test. Those tests are
written in W5-3; this card is the gate that runs them against the built app on both platforms
and produces the evidence.
