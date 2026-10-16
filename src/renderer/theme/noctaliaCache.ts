/**
 * The last Noctalia palette, kept where the pre-paint can read it.
 *
 * The real one arrives over IPC, which is too late for the first paint: without
 * this, every launch on a Noctalia desktop would paint the plain theme and then
 * flip. Same move as the colour-mode replay in `index.ts` — a cache of what main
 * already said, never the source of truth. `useNoctaliaSync` overwrites or
 * clears it with main's answer as soon as there is one.
 */

import { parseNoctaliaPalette, type NoctaliaPalette } from '@shared/theme'

const KEY = 'oscine-noctalia-palette'

export function cachedNoctaliaPalette(): NoctaliaPalette | null {
  try {
    const stored = window.localStorage.getItem(KEY)
    return stored === null ? null : parseNoctaliaPalette(JSON.parse(stored))
  } catch {
    // Unreadable storage or a stale shape: start on the plain theme, which main
    // corrects a moment later. Never a reason not to paint.
    return null
  }
}

export function cacheNoctaliaPalette(palette: NoctaliaPalette | null): void {
  try {
    if (palette === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify(palette))
  } catch {
    // A full or disabled store costs one flip at the next launch, nothing more.
  }
}
