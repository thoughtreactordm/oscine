import type { PresenceTrack } from '@shared/presence'

/**
 * The operator-templated status line — **W20-6**.
 *
 * `renderStatusLine(template, track)` turns a template string carrying tokens
 * (`{title}`, `{artist}`, `{album}`, `{albumArtist}`) into the text that becomes
 * the activity `details` field, which the status line mirrors (W20-4 pointed
 * `status_display_type` there and that seam is what lets a templated line reach
 * the compact "Listening to X" text at all — see `activity.ts`).
 *
 * Like `buildActivity`, it is pure: same template and track, same string, no
 * clock and no I/O, so it is unit-tested with nothing but literals. It never
 * returns blank — an all-empty render (e.g. `{album}` on a single) falls back to
 * the title, which `PresenceTrack` always carries, so the status line is never a
 * void. The privacy floor is *not* enforced here: `generic` mode ignores the
 * template entirely and that decision stays in `buildActivity`, beside the other
 * display-mode gates. See `[[oscine-discord-presence]]` D31.
 */

/**
 * Discord caps `details` at 128 characters. We cap the rendered line to match so
 * a token-heavy template on a long title cannot produce a field Discord truncates
 * on its own terms (mid-word, no ellipsis).
 */
export const STATUS_LINE_MAX_LENGTH = 128

/**
 * The tokens a template may name, resolved from the track. Anything else in
 * `{...}` is unknown and renders empty (then collapses like a missing field).
 * `{title}` is the only one guaranteed non-empty; the rest may be absent.
 */
const TOKENS: Record<string, (track: PresenceTrack) => string | null | undefined> = {
  title: (track) => track.title,
  artist: (track) => track.artist,
  album: (track) => track.album,
  albumArtist: (track) => track.albumArtist
}

/**
 * Connective punctuation an operator puts *between* fields — em/en dash, middot,
 * pipe, slash, comma, semicolon, colon, hyphen. When a token beside one of these
 * resolves empty, the connector is left stranded — a leading `— `, a trailing
 * ` —`, or a doubled `— —` where a middle token vanished — and must be collapsed
 * so a missing `{album}` in `{artist} — {album} — {title}` does not strand its
 * dashes. The literal characters are spelled out (not `\u` escapes) so no string
 * carries a backslash; the hyphen sits *last* so a character class reads it
 * literally rather than as a range. The patterns run after whitespace has already
 * been squeezed to single spaces, so they match a literal space, not `\s`.
 */
const CONNECTORS = '–—·|/,;:-'

/** A connector immediately followed by one or more further connectors — the seam a vanished middle token leaves. */
const DOUBLED_CONNECTOR = new RegExp(`([${CONNECTORS}])(?: ?[${CONNECTORS}])+`, 'g')

/** Spaces and connectors clinging to either end, left by a vanished first or last token. */
const EDGE_JUNK = new RegExp(`^[ ${CONNECTORS}]+|[ ${CONNECTORS}]+$`, 'g')

/**
 * Clean up the debris an empty token leaves behind: the empty bracket pair a
 * missing `{album}` drops in `{title} ({album})`, runs of whitespace, connectors
 * orphaned against each other, and connectors clinging to the ends.
 */
function collapseEmpties(text: string): string {
  return text
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(DOUBLED_CONNECTOR, '$1')
    .replace(EDGE_JUNK, '')
    .trim()
}

export function renderStatusLine(template: string, track: PresenceTrack): string {
  const substituted = template.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    const resolve = TOKENS[name]
    if (!resolve) return ''
    return (resolve(track) ?? '').trim()
  })

  const cleaned = collapseEmpties(substituted)
  const line = cleaned || track.title

  return line.length > STATUS_LINE_MAX_LENGTH
    ? line.slice(0, STATUS_LINE_MAX_LENGTH).trimEnd()
    : line
}
