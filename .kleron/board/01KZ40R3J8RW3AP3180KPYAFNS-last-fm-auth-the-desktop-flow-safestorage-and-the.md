---
taskId: 01KZ40R3J8RW3AP3180KPYAFNS
title: 'Last.fm auth — the desktop flow, `safeStorage`, and the shipped key'
status: done
priority: high
labels:
  - main
  - security
  - W8-adjacent
  - D19
workstream: W11
workstreamId: W11-3
dependsOn:
  - 01KZ40Q2G2QD6XPPMWFKBZKTZ9
order: 11
created: '2026-08-03T14:34:21.128Z'
updated: '2026-08-04T15:06:58.984Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → D19 and → Scrobbling → "Last.fm specifics".

**Read D19 before starting.** D14 rejected last.fm on the API-key question, and this card is only legitimate because of the argument D19 makes: the app key and the session key do different jobs, and conflating them is the mistake to avoid.

**The flow**, in main only — the renderer never opens a socket:
1. `auth.getToken` → an unauthenticated request token
2. Open the **system browser** at `last.fm/api/auth/?api_key=…&token=…`. A system browser, not a `BrowserWindow`: the operator is typing their password, and they are entitled to see their own browser's URL bar and password manager. An in-app window that renders someone's login form is exactly the shape of a phishing page.
3. The operator signs into their own account and grants access
4. `auth.getSession(token)` → a session key bound to that user, which never expires

**Credential handling, non-negotiable:**
- The **session key** goes to Electron `safeStorage` — currently unused anywhere in `src/`, so this card establishes the pattern. It never enters the settings table, never enters D11's bundle, and **never crosses IPC after it is written**.
- The renderer is told a username and a connected boolean. Nothing else.
- The **app key and shared secret** ship in the bundle, extractable from the asar, and that is accepted (D19). They identify the application and can scrobble for nobody on their own.
- `lastfm.apiKey` / `lastfm.apiSecret` are durable settings, empty by default, meaning "use the shipped pair". An operator who pastes their own overrides both — the escape hatch if the shipped key is ever revoked or rate-limited.

**Register the Oscine API account** as part of this card and record where the credentials came from. That is a real-world step, not a code step, and it will block the card if it is discovered late.

**Scrobbling sits outside D14's consent gate (W7-6), deliberately** — see D19. Do not wire it to the gate; do leave a comment at the point where a reader would expect the gate and find it absent.

**`safeStorage` caveat to handle rather than discover:** `isEncryptionAvailable()` can be false on a Linux box with no keyring. Decide and implement the behaviour — refusing to connect with a clear reason is honest; writing the key in plaintext as a fallback is not.

**Done when:** connecting on Windows and on Linux both produce a working session; the key survives a restart; disconnecting removes it; and grepping the renderer bundle for it finds nothing.
