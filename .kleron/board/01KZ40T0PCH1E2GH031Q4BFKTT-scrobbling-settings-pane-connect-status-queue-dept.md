---
taskId: 01KZ40T0PCH1E2GH031Q4BFKTT
title: 'Scrobbling settings pane — connect, status, queue depth, disconnect'
status: done
priority: medium
labels:
  - ui
  - W8-adjacent
  - D19
workstream: W11
workstreamId: W11-7
dependsOn:
  - 01KZ40R3J8RW3AP3180KPYAFNS
  - 01KZ40QHB4PYF5AG93T4KAK1YW
order: 4
created: '2026-08-03T14:35:23.724Z'
updated: '2026-08-04T15:06:58.871Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Scrobbling, and → Settings.

The operator-facing surface for everything in this stream, in `src/renderer/panels/settings/`.

**Declarative keys go through W8's registry** (`src/shared/settings.ts`) — `lastfm.enabled`, `lastfm.apiKey`, `lastfm.apiSecret`, `lastfm.loveOnFavorite`, `listenbrainz.enabled` — where adding a setting is a one-line entry rather than UI work.

**What is not declarative and needs real UI:**
- **Connect / Disconnect.** Connect launches W11-3's flow and shows a waiting state while the operator is in their browser, with a way out if they abandon it. Disconnect clears the `safeStorage` credential and says what it did — that pending scrobbles for that target stay queued, or are dropped, whichever you implement. Pick one and tell the operator.
- **Connected identity.** The username and nothing more. The renderer is never given the session key (D19).
- **Queue depth**, read from `scrobble_queue`. This is the honest health readout: rows are deleted on success, so a non-zero depth *is* the diagnostic. "3 scrobbles waiting to send" is a status, not an error, and should not be styled as one.
- **Last error**, when there is one, in plain language. "Last.fm rejected the session — reconnect" beats a code 9.
- **Retry now**, which wakes the drain worker.
- The **API key override** fields want a line of help text saying they are optional and what happens when empty, or they read as required and stop people at the first screen.

**Constraints:** theming through the token layer only, no hardcoded colours. Writes apply immediately and broadcast, per W8 — nothing staged behind OK/Cancel.

**Done when:** an operator can connect, see their username, watch the queue drain, unplug the network and watch it grow, plug it back in and watch it empty — without opening a devtools console.
