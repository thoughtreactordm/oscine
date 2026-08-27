/**
 * Tag suggestions, assembled: the track's artist, one lookup, the cache, and the
 * dedup against what the operator already has (**W15-4**).
 *
 * ## Where the MBID comes from
 *
 * The `artists` row, never the request — `relationsService.ts`' rule, and for the
 * same reason: a correction made in the identity picker changes which artist's
 * tags are proposed without this layer knowing the picker exists, and an
 * unresolved artist is answered with nothing before a socket opens, so there is
 * no path by which one band's genres are offered for another's track.
 *
 * ## Behind D14, and silent when it declines
 *
 * The whole networked half goes through `cache.through`, so this inherits the
 * D14 model entire: a fresh entry answers with lookups switched off, a stale one
 * beats a `declined`/`offline`/`timeout`/`rate-limited`/`unavailable` failure,
 * and a genuine failure resolves to *no suggestions* rather than an error.
 * Suggestions are a decoration on the local tag editor, which keeps working with
 * the cable pulled — a `declined` here is an empty "Suggested" section, never a
 * pane that will not load.
 *
 * ## Nothing new that is not new
 *
 * A suggestion equal to a genre already on the file, or a tag the operator has
 * already applied, is collapsed out here rather than drawn as a fresh chip —
 * keyed on the same casefold (`normalizeLabel`) that unifies the two vocabularies
 * everywhere else. Accepting a suggestion is an ordinary `tags.add`, so the next
 * call sees it as an existing user tag and stops offering it.
 */

import { normalizeLabel } from '@shared/genre'
import type { TagSuggestion } from '@shared/tags'
import type Database from 'better-sqlite3'
import type { CacheService } from '../cache'
import type { NetClient } from '../net'
import type { TagStore } from '../tags/store'
import { artistTagsCacheKey, fetchArtistTags } from './artistTags'
import { createArtistIdentityStore } from './store'

const ARTIST_TAGS_ENTITY = 'musicbrainz.artist-tags' as const

/**
 * How many suggestions the pane is offered.
 *
 * MusicBrainz's tag lists are long-tailed — a well-known artist carries dozens,
 * most with a single vote — and a "Suggested" section that ran to forty chips
 * would bury the handful the crowd actually agrees on. The list is weight-ordered
 * before the cap, so the rows a truncation drops are the least-agreed-upon ones.
 */
export const SUGGESTED_TAG_LIMIT = 12

export interface TagSuggestionService {
  /** The suggestions for a track, deduped against its existing tags. Never throws for a network reason. */
  suggest(trackId: number): Promise<TagSuggestion[]>
}

export interface TagSuggestionServiceOptions {
  db: Database.Database
  client: NetClient
  cache: CacheService
  /** The local tag record, read to collapse suggestions the track already carries. */
  tags: Pick<TagStore, 'tagsForTrack'>
}

export function createTagSuggestionService({
  db,
  client,
  cache,
  tags
}: TagSuggestionServiceOptions): TagSuggestionService {
  const identities = createArtistIdentityStore(db)

  /** The casefold keys of every genre and user tag the track already carries. */
  function existingKeys(trackId: number): Set<string> {
    const view = tags.tagsForTrack(trackId)
    const keys = new Set<string>()
    for (const genre of view.file) {
      const norm = normalizeLabel(genre)
      if (norm) keys.add(norm.key)
    }
    for (const tag of view.user) {
      const norm = normalizeLabel(tag.label)
      if (norm) keys.add(norm.key)
    }
    return keys
  }

  return {
    async suggest(trackId): Promise<TagSuggestion[]> {
      // The track left the library while the deck was looking at it, or its
      // artist was never resolved. Both are "no suggestions" rather than a throw,
      // and the second is the one that matters: no MBID means no lookup, which
      // means there is no way to propose one artist's genres for another's track.
      const identity = identities.forTrack(trackId)
      if (!identity?.mbid) return []
      const mbid = identity.mbid

      const result = await cache.through(ARTIST_TAGS_ENTITY, artistTagsCacheKey(mbid), () =>
        fetchArtistTags(client, mbid)
      )
      // Every failure is silence. A 404 (`not-found`) is an artist with no tag
      // document; a `declined`/`offline`/… is consent off or the network down —
      // and `cache.through` has already answered from a stale entry if it had
      // one. Either way the pane shows an empty section, not an error, and the
      // local editor beneath it is untouched.
      if (!result.ok) return []

      const existing = existingKeys(trackId)
      const suggestions: TagSuggestion[] = []
      for (const tag of result.value) {
        if (existing.has(tag.key)) continue
        suggestions.push({ label: tag.label, count: tag.count })
        if (suggestions.length >= SUGGESTED_TAG_LIMIT) break
      }
      return suggestions
    }
  }
}
