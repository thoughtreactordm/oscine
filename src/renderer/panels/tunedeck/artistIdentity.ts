import type { ArtistCandidate, ArtistResolution } from '@shared/artist'

/**
 * The words the identity header uses, as pure functions.
 *
 * Separated from the component for `signalReadout.ts`'s reason: these are the
 * part worth testing, and testing them through a mounted Vue component means a
 * DOM, a Pinia instance and a Nuxt UI plugin to assert on a sentence. **R5** is
 * a correctness risk about what the deck *claims*, so the claims are here where
 * a test can read them directly.
 */

/** How confident the header is allowed to look. Maps to a token, never a colour. */
export type IdentityTone = 'resolved' | 'unresolved' | 'problem'

export interface IdentityWording {
  /** The name in the header. Always something — the tag string, at worst. */
  headline: string
  /** The line under it. `null` when the headline says everything. */
  detail: string | null
  tone: IdentityTone
  /** Whether the picker is worth offering. False only when there is no artist. */
  correctable: boolean
  /** Whether to offer a retry. True only when asking again could change the answer. */
  retryable: boolean
}

/** `1987-12` → `1987`. MusicBrainz dates are partial, and the year is the useful part. */
function year(date: string | null): string | null {
  if (!date) return null
  const match = /^(\d{4})/u.exec(date)
  return match ? match[1] : null
}

/**
 * The line that tells two identically named artists apart.
 *
 * MusicBrainz's `disambiguation` first and alone when it exists, because it is a
 * human's one-line answer to exactly this question and anything appended to it
 * is noise. The rest is the fallback for the artists nobody has written one for:
 * kind, country, years, in that order, joined with a middle dot.
 */
export function describeCandidate(candidate: ArtistCandidate): string | null {
  if (candidate.disambiguation) return candidate.disambiguation

  const parts: string[] = []
  if (candidate.type) parts.push(candidate.type)
  if (candidate.country) parts.push(candidate.country)

  const begin = year(candidate.begin)
  const end = year(candidate.end)
  if (begin && end) parts.push(`${begin}–${end}`)
  else if (begin) parts.push(`${begin}–`)
  else if (end) parts.push(`–${end}`)

  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * What the header says, for every state the resolution can be in.
 *
 * The whole of R5's "unresolved is a first-class state" is in the fact that
 * three of these five branches are not errors and none of them is empty. A deck
 * that renders nothing when it cannot identify an artist teaches the operator
 * that the artist tab is broken; a deck that says which of the four things
 * happened teaches them what to do about it.
 *
 * `failed` is the IPC call itself having rejected, which is a bug rather than a
 * network state — worded as such, and kept out of `ArtistResolution` because
 * main cannot report a failure to reply.
 */
export function describeIdentity(
  resolution: ArtistResolution | null,
  { loading = false, failed = false }: { loading?: boolean; failed?: boolean } = {}
): IdentityWording {
  if (failed) {
    return {
      headline: resolution?.name ?? 'Unknown artist',
      detail: 'Oscine could not look this up.',
      tone: 'problem',
      correctable: false,
      retryable: true
    }
  }

  if (!resolution) {
    return {
      headline: 'No artist',
      detail: loading ? 'Looking…' : 'This track carries no artist tag.',
      tone: 'unresolved',
      correctable: false,
      retryable: false
    }
  }

  switch (resolution.status) {
    case 'resolved':
      return {
        // MusicBrainz's spelling, not the tag's: the point of resolving is that
        // the identity is now the authority. The tag is still what the track
        // list shows, and D7 keeps it that way on disk.
        headline:
          resolution.candidates.find((c) => c.mbid === resolution.mbid)?.name ?? resolution.name,
        // No detail for a plain automatic match, which is the common case. The
        // line there used to say "Matched on MusicBrainz.", which is what the
        // tick beside the name already says and what the tab is for — a
        // standing sentence that never varies and carries nothing is exactly
        // what `panes.ts` moved every group hint behind a tooltip to be rid of.
        // A disambiguation is different: it is the one line that tells this
        // Nirvana from the other ten, so it stays.
        detail:
          resolution.source === 'manual'
            ? 'Your choice. Kept until you change it.'
            : (resolution.candidates.find((c) => c.mbid === resolution.mbid)?.disambiguation ??
              null),
        tone: 'resolved',
        correctable: true,
        retryable: false
      }

    case 'ambiguous':
      return {
        headline: resolution.name,
        detail: `Several artists go by this name. Pick the right one.`,
        tone: 'unresolved',
        correctable: true,
        retryable: false
      }

    case 'no-match':
      return {
        headline: resolution.name,
        detail:
          resolution.source === 'manual'
            ? 'You said this artist is not on MusicBrainz.'
            : // MusicBrainz answers an unknown name with near misses rather than
              // with nothing, so "no match" usually still has a list behind it.
              // Saying so is what stops the operator concluding the tag is
              // hopeless when the right artist is sitting third in the picker.
              resolution.candidates.length > 0
              ? 'No close match. Look through the near misses?'
              : 'Not on MusicBrainz under this name.',
        tone: 'unresolved',
        correctable: true,
        retryable: false
      }

    case 'unavailable':
      return {
        headline: resolution.name,
        // Main's own sentence. It is already phrased for a person and already
        // free of URLs and stack traces, and rewording it here would be a second
        // place for "lookups are off" to be spelled differently.
        detail: resolution.failure?.message ?? 'Could not reach MusicBrainz.',
        tone: 'problem',
        correctable: true,
        // Never for `declined`: asking again cannot help while the toggle is
        // off, and a Retry that is guaranteed to fail is worse than no Retry.
        retryable: resolution.failure?.kind !== 'declined'
      }
  }
}
