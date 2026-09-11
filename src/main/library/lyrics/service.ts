import { parseLrc, type LyricsDocument } from '@shared/lyrics'

/**
 * The lyrics resolver: the tier order for one track's lyrics.
 *
 *   1. **Sidecar `.lrc`** — the operator put it there deliberately.
 *   2. **Embedded tags** — the file's own `USLT`/`LYRICS`/`©lyr`, the cheapest
 *      tier and the one that costs nothing at runtime beyond a re-parse.
 *   3. **Network** — a seam W17-4 fills; omitted here, so the feature is
 *      complete and useful with `network.externalLookups` off.
 *
 * The tier that wins is recorded in `LyricsDocument.source` (each reader stamps
 * its own provenance), because W17-3 attributes it and W17-5 needs to know what
 * a manual override is replacing.
 *
 * This module is main-process only and holds no Electron or database imports —
 * the caller resolves the audio path and injects the readers, which is what lets
 * it be tested without files or a socket.
 */
export interface LyricsResolverDeps {
  /** Tier 1. Returns the parsed sidecar document, or `null` when there is none. */
  readSidecar: (audioAbsPath: string) => Promise<LyricsDocument | null>
  /**
   * Tier 2. The file's embedded lyrics as raw text, or `null`. Text, not a
   * document, because only this resolver should run it through `parseLrc` — most
   * embedded synced lyrics are LRC stuffed into an unsynced frame, so the text
   * is judged here rather than assumed plain at the source.
   */
  readEmbeddedLyrics: (audioAbsPath: string) => Promise<string | null>
  /**
   * Tier 3. The network lookup, injected by W17-4 and absent in this card. When
   * omitted the chain simply ends after the two local tiers.
   */
  fetchNetworkLyrics?: (audioAbsPath: string) => Promise<LyricsDocument | null>
}

/**
 * Walk the tiers for one already-resolved audio path and return the first that
 * yields lyrics, or `null` when none do.
 *
 * Never throws: a tier that fails — a moved file, an unreadable tag — is treated
 * as "no lyrics from here" and the walk continues, because a lyrics lookup is
 * not allowed to take out the caller. An empty-but-valid document (a blank
 * sidecar) also falls through, so a stray empty `.lrc` does not mask the
 * embedded lyrics underneath it.
 */
export async function resolveLyrics(
  audioAbsPath: string,
  deps: LyricsResolverDeps
): Promise<LyricsDocument | null> {
  const sidecar = await safe(() => deps.readSidecar(audioAbsPath))
  if (hasLines(sidecar)) return sidecar

  const embedded = await safe(() => deps.readEmbeddedLyrics(audioAbsPath))
  if (embedded !== null && embedded.trim() !== '') {
    const doc = parseLrc(embedded, 'embedded')
    if (hasLines(doc)) return doc
  }

  if (deps.fetchNetworkLyrics) {
    const network = await safe(() => deps.fetchNetworkLyrics!(audioAbsPath))
    // Instrumental is a real answer that carries no lines — W17-3 renders it as
    // its own state — so the network tier accepts it where `hasLines` would not.
    // Only the network tier can produce it; the local tiers never set the flag.
    if (network !== null && (network.lines.length > 0 || network.instrumental === true)) {
      return network
    }
  }

  return null
}

function hasLines(doc: LyricsDocument | null): doc is LyricsDocument {
  return doc !== null && doc.lines.length > 0
}

/** Run a tier, swallowing any rejection to `null` so one bad tier cannot end the walk. */
async function safe<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch {
    return null
  }
}
