# Oscine — design documentation

The design document lives in the project's Kleron wiki, which is version-controlled inside this
repository and travels with every clone:

**[`.kleron/wiki/fermata-design.md`](../.kleron/wiki/fermata-design.md)**

It is the single canonical copy. It covers:

| Section | Contents |
|---|---|
| 1 | What Oscine is, and the definition of "v1 is done" |
| 2 | Decisions D1–D15, each with rationale, rejected alternatives and a revisit trigger |
| 3 | Risks R1–R5, with mitigations |
| 4 | Data model — schema v1 |
| 5 | Queue semantics — the seven rules |
| 6 | Process architecture and the main/renderer boundary |
| 7 | Repository structure |
| 8–9 | Workstreams W1–W6 and milestones M1–M6 |
| 10–11 | Conventions, and what is explicitly out of scope for v1 |

This file is a pointer rather than a duplicate. Two copies of a long design document drift the
moment one is edited, and the Kleron tooling writes to the wiki copy — so a second full copy here
would go stale silently, which is worse than not having one.

Edit the wiki file directly, or through `kleron_wiki_update`.

## Other documentation

Milestone and task detail lives on the board in `.kleron/board/`, one markdown file per card,
also version-controlled. The M1 cards carry their own scope and acceptance criteria.
